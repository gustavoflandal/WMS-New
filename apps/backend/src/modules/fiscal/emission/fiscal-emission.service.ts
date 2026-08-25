// DOC-08 §4.7 RNF-FIS-060/061 [INVIOLÁVEL] — ciclo de emissão real:
// DRAFT -> SIGNED -> TRANSMITTED -> AUTHORIZED/REJECTED/DENIED. Chamado
// pelo FiscalEmissionWorkerImpl (perfil `worker`). Reusa
// StorageReturnInvoiceService.effectuateAuthorization() (ex-`authorize()`
// da 8A) para o efeito de Consumo Fiscal — nenhuma linha dessa lógica é
// duplicada aqui.
//
// Design de transação: cada etapa (assinatura, transmissão, tratamento do
// retorno) é uma transação PRÓPRIA, tenant-scoped (wms_app, via
// db.transaction(ctx,...) reconstruindo o TenantContext a partir do
// fiscal_document lido no scan cross-tenant) — nunca uma transação única
// envolvendo a chamada de rede à SEFAZ (não se segura conexão/lock de
// Postgres através de I/O externo lento). Só o SCAN inicial (descobrir
// quais documentos estão DRAFT, entre todos os tenants) usa
// transactionAsWorker (wms_worker/BYPASSRLS) — mesmo padrão de
// InboundInvoiceFiscalService.checkDeadlines().
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { FiscalIssuerService } from './fiscal-issuer.service.js';
import { DanfeService } from './danfe.service.js';
import { StorageReturnInvoiceService } from '../storage-return-invoice/storage-return-invoice.service.js';
import { SEFAZ_CLIENT_PORT, SefazClientPort } from './sefaz-client.port.js';
import { buildNfeEnvelopeXml, NfeXmlItem } from './nfe-xml-builder.util.js';
import { signXml } from './xml-dsig.util.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';
const CONTINGENCY_FAILURE_THRESHOLD = 3;

export interface FiscalEmissionCandidate {
  id: string;
  tenant_id: string;
  warehouse_id: string;
}

export interface ProcessDocumentResult {
  fiscalDocumentId: string;
  outcome: 'AUTHORIZED' | 'REJECTED' | 'DENIED' | 'TRANSPORT_FAILURE' | 'SKIPPED';
  cStat?: number;
}

@Injectable()
export class FiscalEmissionService {
  private readonly logger = new Logger(FiscalEmissionService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(FileStorageService) private readonly fileStorageService: FileStorageService,
    @Inject(FiscalIssuerService) private readonly fiscalIssuerService: FiscalIssuerService,
    @Inject(DanfeService) private readonly danfeService: DanfeService,
    @Inject(StorageReturnInvoiceService) private readonly storageReturnInvoiceService: StorageReturnInvoiceService,
    @Inject(SEFAZ_CLIENT_PORT) private readonly sefazClient: SefazClientPort
  ) {}

  /** RNF-FIS-060 — fila de emissão. Cross-tenant scan (SELECT), processamento tenant-scoped por documento. */
  async pollAndProcessBatch(batchSize = 20): Promise<ProcessDocumentResult[]> {
    const candidatesResult = await this.db.transactionAsWorker(async (client) => {
      return client.query<FiscalEmissionCandidate>(
        `SELECT id, tenant_id, warehouse_id FROM wms.fiscal_document
         WHERE status = 'DRAFT' AND document_type = 'NOTA_DEVOLUCAO_ARMAZENAGEM'
         ORDER BY created_at ASC LIMIT $1`,
        [batchSize]
      );
    });

    const results: ProcessDocumentResult[] = [];
    for (const candidate of candidatesResult.rows) {
      try {
        results.push(await this.processDocument(candidate.id, candidate.tenant_id, candidate.warehouse_id));
      } catch (error) {
        this.logger.error(`Falha ao processar fiscal_document ${candidate.id}`, error as Error);
        results.push({ fiscalDocumentId: candidate.id, outcome: 'TRANSPORT_FAILURE' });
      }
    }
    return results;
  }

  async processDocument(fiscalDocumentId: string, tenantId: string, warehouseId: string): Promise<ProcessDocumentResult> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: SYSTEM_ACTOR, warehouse_id: warehouseId };

    const prepared = await this.claimAndSign(ctx, fiscalDocumentId);
    if (!prepared) {
      return { fiscalDocumentId, outcome: 'SKIPPED' };
    }

    await this.db.query(ctx, `UPDATE wms.fiscal_document SET status = 'TRANSMITTED', updated_at = now() WHERE id = $1`, [fiscalDocumentId]);

    let transmitResult;
    try {
      transmitResult = await this.sefazClient.transmit({
        envelopeXml: prepared.signedXml,
        ambiente: prepared.ambiente,
        uf: prepared.uf,
        tpemis: prepared.tpemis,
      });
    } catch (error) {
      await this.handleTransportFailure(ctx, prepared.issuerId, fiscalDocumentId, (error as Error).message);
      return { fiscalDocumentId, outcome: 'TRANSPORT_FAILURE' };
    }

    // Sucesso de transporte reseta o contador de falhas do emitente.
    await this.db.query(
      ctx,
      `UPDATE wms.fiscal_issuer SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures > 0`,
      [prepared.issuerId]
    );

    if (transmitResult.cStat === 100) {
      await this.handleAuthorized(ctx, fiscalDocumentId, transmitResult);
      return { fiscalDocumentId, outcome: 'AUTHORIZED', cStat: transmitResult.cStat };
    }
    if (transmitResult.cStat === 110) {
      await this.handleDenied(ctx, fiscalDocumentId, transmitResult);
      return { fiscalDocumentId, outcome: 'DENIED', cStat: transmitResult.cStat };
    }
    await this.handleRejected(ctx, fiscalDocumentId, transmitResult);
    return { fiscalDocumentId, outcome: 'REJECTED', cStat: transmitResult.cStat };
  }

  /**
   * DRAFT -> SIGNED. Garante reserva/reaproveitamento de nNF (RNF-FIS-060:
   * REJECTED->DRAFT reaproveita o MESMO número, nunca reserva um novo).
   * Retorna null se o documento não estava mais DRAFT (já reivindicado por
   * outro worker, ou terminal) — guarda otimista via `WHERE status='DRAFT'`
   * na própria UPDATE, sem precisar de FOR UPDATE SKIP LOCKED cross-processo.
   */
  private async claimAndSign(
    ctx: TenantContext,
    fiscalDocumentId: string
  ): Promise<{ signedXml: string; ambiente: 'HOMOLOGACAO' | 'PRODUCAO'; uf: string; tpemis: 'NORMAL' | 'SVC'; issuerId: string } | null> {
    // Claim atômico: só um chamador concorrente (multi-instância do worker)
    // consegue flipar DRAFT->SIGNED; os demais recebem 0 linhas e desistem
    // ANTES de reservar número/montar XML — evita reserva duplicada de nNF
    // para o mesmo documento (RNF-FIS-060 "sequencial sem lacunas").
    const claimResult = await this.db.query(
      ctx,
      `UPDATE wms.fiscal_document SET status = 'SIGNED', updated_at = now() WHERE id = $1 AND status = 'DRAFT' RETURNING *`,
      [fiscalDocumentId]
    );
    const doc = claimResult.rows[0];
    if (!doc) return null;

    let issuerId: string = doc.fiscal_issuer_id;
    if (!issuerId) {
      const issuerResult = await this.db.query(
        ctx,
        `SELECT id FROM wms.fiscal_issuer WHERE tenant_id = $1 AND warehouse_id = $2 ORDER BY created_at ASC LIMIT 1`,
        [ctx.tenant_id, ctx.warehouse_id]
      );
      const issuerRow = issuerResult.rows[0];
      if (!issuerRow) {
        throw new BadRequestException({
          error: 'FISCAL_ISSUER_NOT_CONFIGURED',
          detail: `RD-FIS-004: nenhum fiscal_issuer cadastrado para tenant ${ctx.tenant_id} / armazém ${ctx.warehouse_id}`,
        });
      }
      issuerId = issuerRow.id;
    }
    const issuerRowResult = await this.db.query(ctx, `SELECT * FROM wms.fiscal_issuer WHERE id = $1`, [issuerId]);
    const issuer = issuerRowResult.rows[0];

    const uf = await this.resolveIssuerUf(ctx, issuer);
    const tpemis: 'NORMAL' | 'SVC' = issuer.transmission_mode === 'CONTINGENCIA_SVC' ? 'SVC' : 'NORMAL';

    let nfeNumber: number = doc.nfe_number;
    let nfeSerie: number = doc.nfe_serie;
    if (!nfeNumber) {
      const claimResult = await this.db.transaction(ctx, async (client) => {
        const reserved = await this.fiscalIssuerService.reserveNextNumber(client, issuerId);
        await client.query(`UPDATE wms.fiscal_document SET fiscal_issuer_id = $2, nfe_number = $3, nfe_serie = $4, tpemis = $5, updated_at = now() WHERE id = $1`, [
          fiscalDocumentId,
          issuerId,
          reserved.nfeNumber,
          reserved.serie,
          tpemis,
        ]);
        return reserved;
      });
      nfeNumber = claimResult.nfeNumber;
      nfeSerie = claimResult.serie;
    } else {
      await this.db.query(ctx, `UPDATE wms.fiscal_document SET fiscal_issuer_id = $2, tpemis = $3, updated_at = now() WHERE id = $1`, [
        fiscalDocumentId,
        issuerId,
        tpemis,
      ]);
    }

    const itemsResult = await this.db.query(
      ctx,
      `SELECT fdi.line_number, fdi.qty, p.description, p.ncm, fd.operation_nature_id, opn.cfop
       FROM wms.fiscal_document_item fdi
       JOIN wms.product p ON p.id = fdi.product_id
       JOIN wms.fiscal_document fd ON fd.id = fdi.fiscal_document_id
       LEFT JOIN wms.operation_nature opn ON opn.id = fd.operation_nature_id
       WHERE fdi.fiscal_document_id = $1 ORDER BY fdi.line_number`,
      [fiscalDocumentId]
    );
    const items: NfeXmlItem[] = itemsResult.rows.map((row: any) => ({
      lineNumber: Number(row.line_number),
      productCode: String(row.line_number),
      description: row.description,
      ncm: row.ncm ?? '00000000',
      cfop: row.cfop ?? '5906',
      qty: Number(row.qty),
      unitValue: 0, // RD-FIS-001 não modela preço unitário na Nota de Devolução — total permanece 0 (RG-014 trata quantidade, não valor)
    }));

    const cUF = await this.resolveCUF(uf);
    const built = buildNfeEnvelopeXml({
      fiscalDocumentId,
      cUF,
      issuedAt: new Date(),
      issuerCnpj: doc.issuer_cnpj,
      issuerName: doc.issuer_name,
      recipientCnpj: doc.recipient_cnpj,
      recipientName: doc.recipient_name,
      serie: nfeSerie,
      nfeNumber,
      tpemis,
      items,
    });

    let signedXml = built.xml;
    const cert = await this.fiscalIssuerService.getDecryptedCertificate(ctx.tenant_id, ctx.warehouse_id, issuerId);
    signedXml = signXml(built.xml, cert.privateKeyPem);

    const xmlStorageKey = await this.fileStorageService.upload('fiscal_document_xml', fiscalDocumentId, `${built.accessKey}.xml`, 'text/xml', Buffer.from(signedXml));

    await this.db.query(
      ctx,
      `UPDATE wms.fiscal_document SET access_key = $2, xml_storage_key = $3, total_value = $4, updated_at = now() WHERE id = $1`,
      [fiscalDocumentId, built.accessKey, xmlStorageKey, built.totalValue]
    );

    return { signedXml, ambiente: issuer.ambiente, uf, tpemis, issuerId };
  }

  private async handleAuthorized(ctx: TenantContext, fiscalDocumentId: string, transmitResult: { cStat: number; protocolNumber: string | null }): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE wms.fiscal_document SET cstat = $2, protocol_number = $3, updated_at = now() WHERE id = $1`,
      [fiscalDocumentId, transmitResult.cStat, transmitResult.protocolNumber]
    );

    // Reusa a lógica de Consumo Fiscal já testada na 8A (RN-FIS-040) — não duplicada.
    await this.storageReturnInvoiceService.effectuateAuthorization(fiscalDocumentId, ctx.tenant_id, ctx.warehouse_id, SYSTEM_ACTOR);

    await this.danfeService.generateDanfe(fiscalDocumentId, ctx.tenant_id, ctx.warehouse_id, SYSTEM_ACTOR);

    await this.db.query(
      ctx,
      `UPDATE wms.outbound_order SET fiscal_documents_authorized_at = now(), fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $2
       WHERE fiscal_document_id = $1`,
      [fiscalDocumentId, SYSTEM_ACTOR]
    );
  }

  private async handleRejected(ctx: TenantContext, fiscalDocumentId: string, transmitResult: { cStat: number; cStatMessage: string }): Promise<void> {
    const detail = `cStat ${transmitResult.cStat}: ${transmitResult.cStatMessage}`;
    await this.db.query(
      ctx,
      `UPDATE wms.fiscal_document SET status = 'REJECTED', cstat = $2, rejection_detail = $3, updated_at = now() WHERE id = $1`,
      [fiscalDocumentId, transmitResult.cStat, detail]
    );
    await this.db.query(
      ctx,
      `UPDATE wms.outbound_order SET fiscal_rejection_detail = $2, updated_at = now(), updated_by = $3 WHERE fiscal_document_id = $1`,
      [fiscalDocumentId, detail, SYSTEM_ACTOR]
    );
    await this.db.transaction(ctx, (client) =>
      this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.nota_rejeitada',
        tenant_id: ctx.tenant_id,
        warehouse_id: ctx.warehouse_id!,
        actor_user_id: SYSTEM_ACTOR,
        payload: { fiscal_document_id: fiscalDocumentId, cstat: transmitResult.cStat, detail },
      })
    );
  }

  /** cStat 110 — denegação (SS5.1: "numero consumido, pedido bloqueado p/ tratamento" — [LACUNA: DOC-08] sem workflow de recuperação definido). */
  private async handleDenied(ctx: TenantContext, fiscalDocumentId: string, transmitResult: { cStat: number; cStatMessage: string }): Promise<void> {
    const detail = `cStat ${transmitResult.cStat}: ${transmitResult.cStatMessage}`;
    await this.db.query(
      ctx,
      `UPDATE wms.fiscal_document SET status = 'DENIED', cstat = $2, rejection_detail = $3, updated_at = now() WHERE id = $1`,
      [fiscalDocumentId, transmitResult.cStat, detail]
    );
    await this.db.query(
      ctx,
      `UPDATE wms.outbound_order SET fiscal_rejection_detail = $2, updated_at = now(), updated_by = $3 WHERE fiscal_document_id = $1`,
      [fiscalDocumentId, detail, SYSTEM_ACTOR]
    );
  }

  /** RNF-FIS-061 — 3 falhas consecutivas de TRANSPORTE (não resposta SEFAZ) alternam para contingência SVC. */
  private async handleTransportFailure(ctx: TenantContext, issuerId: string, fiscalDocumentId: string, errorMessage: string): Promise<void> {
    const result = await this.db.query<{ consecutive_failures: number; transmission_mode: string }>(
      ctx,
      `UPDATE wms.fiscal_issuer SET consecutive_failures = consecutive_failures + 1, last_failure_at = now()
       WHERE id = $1 RETURNING consecutive_failures, transmission_mode`,
      [issuerId]
    );
    const row = result.rows[0];
    if (row && row.consecutive_failures >= CONTINGENCY_FAILURE_THRESHOLD && row.transmission_mode !== 'CONTINGENCIA_SVC') {
      await this.db.query(
        ctx,
        `UPDATE wms.fiscal_issuer SET transmission_mode = 'CONTINGENCIA_SVC', contingencia_since = now() WHERE id = $1`,
        [issuerId]
      );
      this.logger.warn(`RNF-FIS-061: emitente ${issuerId} entrou em CONTINGENCIA_SVC após ${row.consecutive_failures} falhas consecutivas`);
      await this.db.transaction(ctx, (client) =>
        this.eventsService.publishInTransaction(client, {
          event_type: 'fiscal.contingencia_ativada',
          tenant_id: ctx.tenant_id,
          warehouse_id: ctx.warehouse_id!,
          actor_user_id: SYSTEM_ACTOR,
          payload: { fiscal_issuer_id: issuerId, consecutive_failures: row.consecutive_failures },
        })
      );
    }
    this.logger.error(`Falha de transporte SEFAZ para fiscal_document ${fiscalDocumentId}: ${errorMessage}`);
  }

  /** UF do emitente — via wms.warehouse.address_state (mesmo campo já usado por resolveScopeType em storage-return-invoice). */
  private async resolveIssuerUf(ctx: TenantContext, issuer: { warehouse_id: string }): Promise<string> {
    const result = await this.db.query<{ address_state: string }>(ctx, `SELECT address_state FROM wms.warehouse WHERE id = $1`, [issuer.warehouse_id]);
    return result.rows[0]?.address_state ?? 'SP';
  }

  /** Código IBGE da UF (cUF) — subconjunto suficiente para os estados usados nos exemplos normativos do DOC-08; demais [DEBITO: 8B] completar tabela oficial. */
  private async resolveCUF(uf: string): Promise<string> {
    const IBGE_UF_CODES: Record<string, string> = { SP: '35', RJ: '33', MG: '31', PR: '41', RS: '43', SC: '42', BA: '29', ES: '32' };
    return IBGE_UF_CODES[uf] ?? '35';
  }
}
