// DOC-08 §4.3 RF-FIS-020/RN-FIS-021 [RN-FIS-021 INVIOLÁVEL] — Nota de
// Armazenagem: registro + crédito do Estoque Fiscal.
//
// [LACUNA: DOC-08] gatilho exato de ENTRADA do dado: "upload de XML
// (portal/interno), integração (DOC-13) ou emissão delegada (RN-FIS-001)".
// DOC-13 (integração ERP) e a emissão delegada por certificado do cliente
// (RN-FIS-001) não existem nesta base — implementado aqui o registro MANUAL/
// upload (campos já extraídos, sem parser de XML dedicado nesta sessão —
// mesma fronteira que o prompt aceita para as demais entradas fiscais desta
// sessão), que é o denominador comum dos três gatilhos possíveis.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { resolveOperationNature, resolveScopeType } from '../shared/operation-nature.util.js';

export interface StorageInvoiceItemInput {
  productId: string;
  qty: number;
  /** RF-FIS-020: "referência à(s) NF de entrada" — obrigatório por item (ver migration 0069, comentário de fiscal_document_item). */
  referenceInboundInvoiceId: string;
}

export interface RegisterStorageInvoiceInput {
  tenantId: string;
  warehouseId: string;
  issuerCnpj: string;
  recipientCnpj: string;
  issuedAt: string;
  accessKey?: string | null;
  totalValue?: number | null;
  xmlStorageKey?: string | null;
  items: StorageInvoiceItemInput[];
  actorUserId: string;
}

@Injectable()
export class StorageInvoiceService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService
  ) {}

  async register(input: RegisterStorageInvoiceInput) {
    if (input.items.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_ITEMS', detail: 'RF-FIS-020: Nota de Armazenagem exige ao menos 1 item' });
    }
    for (const item of input.items) {
      if (item.qty <= 0) throw new BadRequestException({ error: 'INVALID_QTY', detail: `RF-FIS-020: quantidade deve ser > 0 (produto ${item.productId})` });
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const result = await this.db.transaction(ctx, async (client) => {
      const clientResult = await client.query<{ cnpj: string; legal_name: string; address_state: string | null }>(
        `SELECT cnpj, legal_name, address_state FROM wms.client WHERE id = $1`,
        [input.tenantId]
      );
      const clientRow = clientResult.rows[0];
      if (!clientRow) throw new NotFoundException(`client ${input.tenantId} not found`);

      const warehouseResult = await client.query<{ cnpj: string; name: string; code: string; address_state: string | null }>(
        `SELECT cnpj, name, code, address_state FROM wms.warehouse WHERE id = $1`,
        [input.warehouseId]
      );
      const warehouseRow = warehouseResult.rows[0];
      if (!warehouseRow) throw new NotFoundException(`warehouse ${input.warehouseId} not found`);

      // RF-FIS-020: "emitente = CNPJ do cliente; destinatário = CNPJ do armazém".
      if (input.issuerCnpj !== clientRow.cnpj) {
        throw new BadRequestException({
          error: 'ISSUER_MISMATCH',
          detail: `RF-FIS-020: emitente ${input.issuerCnpj} não confere com o CNPJ do cliente (${clientRow.cnpj})`,
        });
      }
      if (input.recipientCnpj !== warehouseRow.cnpj) {
        throw new BadRequestException({
          error: 'RECIPIENT_MISMATCH',
          detail: `RF-FIS-020: destinatário ${input.recipientCnpj} não confere com o CNPJ do armazém (${warehouseRow.cnpj})`,
        });
      }

      // RF-FIS-020: quantidade ≤ quantidade recebida ainda não coberta, POR
      // (produto × NF de entrada referenciada) — ver decisão de modelagem
      // em migration 0069 (fiscal_document_item.reference_inbound_invoice_id).
      for (const item of input.items) {
        const uncovered = await this.loadUncoveredQty(client, input.tenantId, input.warehouseId, item.productId, item.referenceInboundInvoiceId);
        if (item.qty > uncovered) {
          throw new BadRequestException({
            error: 'STORAGE_INVOICE_EXCEEDS_RECEIVED',
            detail: `RF-FIS-020: item ${item.productId} excede o recebido — cobertura restante de ${uncovered}`,
          });
        }
      }

      const scopeType = resolveScopeType(clientRow.address_state, warehouseRow.address_state);
      const nature = await resolveOperationNature(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        documentType: 'NOTA_ARMAZENAGEM',
        scopeType,
      });

      const internalNumber = await this.documentNumberingService.generateDocumentNumber(
        client,
        'FISCAL_DOCUMENT',
        input.warehouseId,
        warehouseRow.code,
        input.actorUserId
      );

      const totalValue = input.totalValue ?? null;

      const documentResult = await client.query(
        `INSERT INTO wms.fiscal_document (
           tenant_id, warehouse_id, document_type, status, internal_number, access_key,
           issuer_cnpj, issuer_name, recipient_cnpj, recipient_name, issued_at, total_value,
           xml_storage_key, operation_nature_id, created_by
         ) VALUES ($1,$2,'NOTA_ARMAZENAGEM','REGISTRADA',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          input.tenantId,
          input.warehouseId,
          internalNumber,
          input.accessKey ?? null,
          input.issuerCnpj,
          clientRow.legal_name,
          input.recipientCnpj,
          warehouseRow.name,
          input.issuedAt,
          totalValue,
          input.xmlStorageKey ?? null,
          nature.id,
          input.actorUserId,
        ]
      );
      const document = documentResult.rows[0];

      let lineNumber = 1;
      const creditedByProduct = new Map<string, number>();
      for (const item of input.items) {
        await client.query(
          `INSERT INTO wms.fiscal_document_item (tenant_id, fiscal_document_id, line_number, product_id, qty, reference_inbound_invoice_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [input.tenantId, document.id, lineNumber, item.productId, item.qty, item.referenceInboundInvoiceId, input.actorUserId]
        );
        lineNumber += 1;
        creditedByProduct.set(item.productId, (creditedByProduct.get(item.productId) ?? 0) + item.qty);
      }

      // RN-FIS-021 [INVIOLÁVEL] — crédito do Estoque Fiscal, por (produto ×
      // nota) — storage_remittance_invoice_id = fiscal_document.id desta
      // Nota de Armazenagem (FK real desde a migration 0069).
      for (const [productId, qty] of creditedByProduct) {
        await client.query(
          `INSERT INTO wms.fiscal_stock_balance (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id, qty_credited, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id)
           DO UPDATE SET qty_credited = wms.fiscal_stock_balance.qty_credited + EXCLUDED.qty_credited, updated_at = now(), updated_by = $6`,
          [input.tenantId, input.warehouseId, productId, document.id, qty, input.actorUserId]
        );
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.nota_armazenagem_registrada',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { fiscal_document_id: document.id, internal_number: internalNumber, item_count: input.items.length },
      });
      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.saldo_fiscal_creditado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { fiscal_document_id: document.id, credited: Object.fromEntries(creditedByProduct) },
      });

      return document;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'fiscal_document',
      entityId: result.id,
      action: 'CREATE',
      requirementId: 'DOC-08 RF-FIS-020/RN-FIS-021',
      after: result,
    });

    return result;
  }

  /**
   * RF-FIS-020 — "quantidade recebida ainda não coberta" para (produto ×
   * NF de entrada): soma de inbound_order_item.qty_received (DOC-04,
   * "quantidade final apurada" após conferência) do pedido daquela invoice,
   * menos o já coberto por OUTRAS Notas de Armazenagem que referenciam a
   * MESMA invoice para o mesmo produto.
   */
  private async loadUncoveredQty(client: PoolClient, tenantId: string, warehouseId: string, productId: string, inboundInvoiceId: string): Promise<number> {
    const invoiceResult = await client.query<{ inbound_order_id: string }>(
      `SELECT inbound_order_id FROM wms.inbound_invoice WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3`,
      [inboundInvoiceId, tenantId, warehouseId]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      throw new NotFoundException(`inbound_invoice ${inboundInvoiceId} not found for tenant ${tenantId} / warehouse ${warehouseId}`);
    }

    const receivedResult = await client.query<{ received: string }>(
      `SELECT COALESCE(SUM(qty_received), 0) AS received FROM wms.inbound_order_item WHERE inbound_order_id = $1 AND product_id = $2`,
      [invoice.inbound_order_id, productId]
    );
    const covered = await client.query<{ covered: string }>(
      `SELECT COALESCE(SUM(fdi.qty), 0) AS covered
       FROM wms.fiscal_document_item fdi
       JOIN wms.fiscal_document fd ON fd.id = fdi.fiscal_document_id
       WHERE fd.document_type = 'NOTA_ARMAZENAGEM' AND fdi.reference_inbound_invoice_id = $1 AND fdi.product_id = $2`,
      [inboundInvoiceId, productId]
    );

    return Number(receivedResult.rows[0].received) - Number(covered.rows[0].covered);
  }
}
