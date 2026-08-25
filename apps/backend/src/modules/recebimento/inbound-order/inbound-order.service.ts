// DOC-04 §4.2 — Ordem de Recebimento (RF-REC-010/RN-REC-011/RN-REC-012).
// RF-REC-020: toda Ordem instancia o Fluxo Operacional genérico
// (core/operation-flow) com as 7 etapas fixas, "Chegada" já concluída na
// criação (a chegada em si — do veículo — é registrada pelo gate-in do
// DOC-03; aqui só a etapa do Fluxo Operacional de RECEBIMENTO é marcada
// DONE, não o gate-in).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { uuidV7 } from '../../../core/identifiers/uuid-v7.util.js';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { parseNfeXml, ParsedNfeItem } from '../shared/nfe-xml.util.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';

// RF-REC-020: "Chegada -> Doca -> Descarga -> Conferência -> Etiquetagem ->
// Putaway -> Fim" (etapa "Divergências" é intercalada dinamicamente à parte,
// via operationFlowService.insertDynamicStep — não faz parte dos passos fixos).
const RECEIVING_FLOW_STEPS = ['CHEGADA', 'DOCA', 'DESCARGA', 'CONFERENCIA', 'ETIQUETAGEM', 'PUTAWAY', 'FIM'];

// RN-REC-011: o vínculo a um vehicle_visit só é válido para fins de registro
// de NF-e/prazo fiscal quando o gate-in daquela visita já foi CONFIRMADO
// (DOC-03 §5.1) — states anteriores a GATE_IN_OK não contam.
const GATE_IN_CONFIRMED_STATUSES = ['NO_PATIO', 'EM_DESLOCAMENTO_DOCA', 'EM_DOCA', 'LIBERADO_SAIDA', 'ENCERRADA'];

export interface CreateFromXmlInput {
  tenantId: string;
  warehouseId: string;
  xmlContent: string;
  /** Se omitido, o serviço tenta casar automaticamente por vehicle_visit.nfe_keys (DOC-03 RF-POR-011). */
  vehicleVisitId?: string | null;
}

export interface CreateManualItemInput {
  productId: string;
  qtyExpected: number;
}

export interface CreateManualInput {
  tenantId: string;
  warehouseId: string;
  vehicleVisitId?: string | null;
  items: CreateManualItemInput[];
}

@Injectable()
export class InboundOrderService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(FileStorageService) private readonly fileStorageService: FileStorageService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService
  ) {}

  /**
   * RF-REC-010(a): ASN por XML de NF-e. Extrai itens/emitente/chave, casa
   * itens por SKU/EAN/NCM+descrição (RN-REC-012), cria a Ordem + Fluxo
   * Operacional. RN-REC-011/RG-014 passo 1: a inbound_invoice (e o início do
   * prazo de regularização) só é registrada quando a Ordem casa com um
   * vehicle_visit cujo gate-in já foi confirmado — "a mercadoria chegar"
   * (RG-014) é o gate-in (DOC-03), não o upload do XML em si, que RF-REC-
   * 010(a) permite acontecer ANTES da chegada física.
   *
   * [DÉBITO: Sessão 4B+] Quando nenhum vehicle_visit casa (ASN pré-chegada,
   * RF-REC-010(a)/(b)), a Ordem é criada normalmente mas SEM inbound_invoice
   * — não há, nesta sessão, um endpoint de "vínculo tardio" que registre a
   * fatura quando o gate-in correspondente ocorrer depois. Reenviar o XML
   * nesse cenário falharia com NFE_ALREADY_REGISTERED de forma incorreta
   * (a chave já teria sido usada) — este fluxo tardio precisa ser desenhado
   * e implementado antes de expor createFromXml a ASNs verdadeiramente
   * pré-chegada em produção.
   */
  async createFromXml(input: CreateFromXmlInput, actorUserId: string) {
    let parsed;
    try {
      parsed = parseNfeXml(input.xmlContent);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const dup = await this.db.queryGlobal(`SELECT id FROM wms.inbound_invoice WHERE access_key = $1`, [parsed.access_key]);
    if (dup.rows.length > 0) {
      throw new ConflictException({
        error: 'NFE_ALREADY_REGISTERED',
        detail: `RF-REC-010: NF-e ${parsed.access_key} já foi registrada em uma Ordem de Recebimento`,
      });
    }

    const settings = await this.loadClientWarehouseSettings(input.tenantId, input.warehouseId, actorUserId);
    const warehouse = await this.loadWarehouse(input.warehouseId);

    const resolvedVisit = await this.resolveVehicleVisit(
      input.tenantId,
      input.warehouseId,
      input.vehicleVisitId ?? null,
      parsed.access_key,
      actorUserId
    );

    if (resolvedVisit && settings.inbound_invoice_deadline_days === null) {
      throw new BadRequestException({
        error: 'DEADLINE_NOT_CONFIGURED',
        detail:
          'RG-014 passo 1 / RN-REC-011: client_warehouse_settings.inbound_invoice_deadline_days não está configurado para este cliente x armazém — não é possível iniciar o prazo de regularização',
      });
    }

    const orderId = uuidV7(); // RG-011
    let xmlStorageKey: string | null = null;
    if (resolvedVisit) {
      xmlStorageKey = await this.fileStorageService.upload(
        'inbound_invoice',
        orderId,
        `${parsed.access_key}.xml`,
        'text/xml',
        Buffer.from(input.xmlContent, 'utf-8')
      );
    }

    try {
      const result = await this.db.transaction(
        { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId },
        async (client) => {
          const number = await this.documentNumberingService.generateDocumentNumber(
            client,
            'INBOUND_ORDER',
            input.warehouseId,
            warehouse.code,
            actorUserId
          );

          const orderResult = await client.query(
            `INSERT INTO wms.inbound_order (id, tenant_id, warehouse_id, number, vehicle_visit_id, origin, blind_checking, status, created_by)
             VALUES ($1,$2,$3,$4,$5,'XML_NFE',$6,'CREATED',$7) RETURNING *`,
            [orderId, input.tenantId, input.warehouseId, number, resolvedVisit?.id ?? null, settings.blind_checking, actorUserId]
          );
          const order = orderResult.rows[0];

          const items = [];
          const itemsWithoutProduct: any[] = [];
          for (const parsedItem of parsed.items) {
            const productId = await this.matchProduct(client, input.tenantId, parsedItem);
            const status = productId ? 'PENDING' : 'SEM_CADASTRO';
            const itemResult = await client.query(
              `INSERT INTO wms.inbound_order_item (tenant_id, inbound_order_id, product_id, raw_sku, raw_description, raw_ean, qty_expected, status, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [
                input.tenantId,
                order.id,
                productId,
                parsedItem.raw_sku,
                parsedItem.raw_description,
                parsedItem.raw_ean,
                parsedItem.qty,
                status,
                actorUserId,
              ]
            );
            const item = itemResult.rows[0];
            items.push(item);
            if (!productId) itemsWithoutProduct.push(item);
          }

          let invoice: any = null;
          if (resolvedVisit) {
            const deadline = this.addDays(new Date(), settings.inbound_invoice_deadline_days);
            const invoiceResult = await client.query(
              `INSERT INTO wms.inbound_invoice (tenant_id, warehouse_id, inbound_order_id, access_key, issuer_cnpj, issuer_name, total_value, xml_storage_key, regularization_deadline, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
              [
                input.tenantId,
                input.warehouseId,
                order.id,
                parsed.access_key,
                parsed.issuer_cnpj,
                parsed.issuer_name,
                parsed.total_value,
                xmlStorageKey,
                deadline,
                actorUserId,
              ]
            );
            invoice = invoiceResult.rows[0];
          }

          await this.createReceivingFlow(client, input.tenantId, input.warehouseId, order.id, actorUserId);

          await this.eventsService.publishInTransaction(client, {
            event_type: 'recebimento.ordem_criada',
            tenant_id: input.tenantId,
            warehouse_id: input.warehouseId,
            actor_user_id: actorUserId,
            payload: {
              inbound_order_id: order.id,
              number: order.number,
              origin: 'XML_NFE',
              item_count: items.length,
              vehicle_visit_id: resolvedVisit?.id ?? null,
              invoice_registered: !!invoice,
            },
          });

          return { order, items, invoice, itemsWithoutProduct };
        }
      );

      await this.auditService.record({
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'inbound_order',
        entityId: result.order.id,
        action: 'CREATE',
        requirementId: 'DOC-04 RF-REC-010(a)',
        after: result.order,
      });

      // RN-REC-012: exceções abertas FORA da transação (o motor de workflow
      // do DOC-12 abre a própria transação — não é possível aninhar).
      for (const item of result.itemsWithoutProduct) {
        await this.operationalExceptionService.create({
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          exceptionType: 'REC.PRODUTO_SEM_CADASTRO',
          entity: 'inbound_order_item',
          entityId: item.id,
          reasonRequest: `RN-REC-012: item "${item.raw_description}" (SKU ${item.raw_sku || 's/ SKU'}, EAN ${item.raw_ean || 's/ EAN'}) não casou com produto do catálogo do cliente`,
          requestedBy: actorUserId,
        });
      }

      return { order: result.order, items: result.items, invoice: result.invoice };
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /** RF-REC-010(c): digitação manual, itens do catálogo do cliente (sem SEM_CADASTRO — produto precisa existir). */
  async createManual(input: CreateManualInput, actorUserId: string) {
    if (!input.items || input.items.length === 0) {
      throw new BadRequestException({ error: 'NO_ITEMS', detail: 'RF-REC-010(c): a Ordem de Recebimento manual precisa de ao menos 1 item' });
    }

    const settings = await this.loadClientWarehouseSettings(input.tenantId, input.warehouseId, actorUserId);
    const warehouse = await this.loadWarehouse(input.warehouseId);

    const resolvedVisit = input.vehicleVisitId
      ? await this.resolveVehicleVisit(input.tenantId, input.warehouseId, input.vehicleVisitId, null, actorUserId)
      : null;

    const orderId = uuidV7(); // RG-011
    try {
      const result = await this.db.transaction(
        { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId },
        async (client) => {
          const number = await this.documentNumberingService.generateDocumentNumber(
            client,
            'INBOUND_ORDER',
            input.warehouseId,
            warehouse.code,
            actorUserId
          );

          const orderResult = await client.query(
            `INSERT INTO wms.inbound_order (id, tenant_id, warehouse_id, number, vehicle_visit_id, origin, blind_checking, status, created_by)
             VALUES ($1,$2,$3,$4,$5,'MANUAL',$6,'CREATED',$7) RETURNING *`,
            [orderId, input.tenantId, input.warehouseId, number, resolvedVisit?.id ?? null, settings.blind_checking, actorUserId]
          );
          const order = orderResult.rows[0];

          const items = [];
          for (const it of input.items) {
            const productResult = await client.query(`SELECT id FROM wms.product WHERE id = $1`, [it.productId]);
            if (productResult.rows.length === 0) {
              throw new BadRequestException({
                error: 'PRODUCT_NOT_FOUND',
                detail: `RF-REC-010(c): produto ${it.productId} não encontrado no catálogo do cliente`,
              });
            }
            const itemResult = await client.query(
              `INSERT INTO wms.inbound_order_item (tenant_id, inbound_order_id, product_id, qty_expected, status, created_by)
               VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING *`,
              [input.tenantId, order.id, it.productId, it.qtyExpected, actorUserId]
            );
            items.push(itemResult.rows[0]);
          }

          await this.createReceivingFlow(client, input.tenantId, input.warehouseId, order.id, actorUserId);

          await this.eventsService.publishInTransaction(client, {
            event_type: 'recebimento.ordem_criada',
            tenant_id: input.tenantId,
            warehouse_id: input.warehouseId,
            actor_user_id: actorUserId,
            payload: {
              inbound_order_id: order.id,
              number: order.number,
              origin: 'MANUAL',
              item_count: items.length,
              vehicle_visit_id: resolvedVisit?.id ?? null,
            },
          });

          return { order, items };
        }
      );

      await this.auditService.record({
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'inbound_order',
        entityId: result.order.id,
        action: 'CREATE',
        requirementId: 'DOC-04 RF-REC-010(c)',
        after: result.order,
      });

      return result;
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /** §5.1: CREATED -> CANCELLED via REC.CANCELAR_RECEBIMENTO, apenas sem contagem iniciada (guardado pelo status atual ser CREATED). */
  async cancel(orderId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const orderResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order WHERE id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`inbound_order ${orderId} not found`);
    if (order.status !== 'CREATED') {
      throw new BadRequestException({
        error: 'ORDER_NOT_CANCELLABLE',
        detail: `§5.1: só é possível cancelar uma Ordem CREATED (sem contagem iniciada); status atual: ${order.status}`,
      });
    }

    const updated = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE wms.inbound_order SET status = 'CANCELLED', refusal_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [orderId, reason, actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
      if (flowResult.rows.length > 0) {
        await this.operationFlowService.cancelFlow(client, flowResult.rows[0].id, actorUserId);
      }

      // [LACUNA: DOC-04 §4.7 não lista um evento de domínio para cancelamento
      // da Ordem — nenhum evento é publicado aqui, só a auditoria abaixo.]

      return result.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 §5.1',
      reason,
      before: order,
      after: updated,
    });

    return updated;
  }

  /**
   * RN-REC-023 — `REC.RECUSA_TOTAL` ("veículo devolvido sem descarga ou com
   * recusa integral") exige 2 aprovadores (`exception_type.default_steps=2`,
   * migration 0033). Só a partir de AT_DOCK/UNLOADING (§5.1: são as únicas
   * origens de "-> REFUSED" no diagrama). A decisão em si passa pelo motor
   * genérico do DOC-12 (`POST /operational-exception/:id/decide`, fora
   * deste service); `applyTotalRefusalDecision()` é o "resume" que lê o
   * resultado e aplica o efeito — mesmo padrão de 2 chamadas já usado por
   * `GateInService.resumeAfterExceptionDecision` (DOC-03).
   */
  async requestTotalRefusal(orderId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const order = await this.findById(orderId, tenantId, warehouseId, actorUserId).then((r) => r.order);
    if (!['AT_DOCK', 'UNLOADING'].includes(order.status)) {
      throw new BadRequestException({
        error: 'ORDER_NOT_REFUSABLE',
        detail: `§5.1: recusa total só é possível a partir de AT_DOCK/UNLOADING (status atual: ${order.status})`,
      });
    }

    const exception = await this.operationalExceptionService.create({
      tenantId,
      warehouseId,
      exceptionType: 'REC.RECUSA_TOTAL',
      entity: 'inbound_order',
      entityId: orderId,
      reasonRequest: reason,
      requestedBy: actorUserId,
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RN-REC-023',
      reason,
      before: order,
    });

    return { order, exception };
  }

  /**
   * `[DÉBITO]` "a visita segue para gate-out com a recusa documentada"
   * (RN-REC-023) não aciona `GateOutService` (DOC-03) automaticamente aqui
   * — módulos deste codebase não se importam entre si via DI (RNF-ARQ-001,
   * mesmo limite já respeitado por `DockService`, que só lê/escreve
   * `wms.vehicle_visit` via SQL direto); a visita segue disponível para
   * gate-out normal pelo fluxo já existente do DOC-03, sem transição
   * automática de estado aqui.
   */
  async applyTotalRefusalDecision(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.findById(orderId, tenantId, warehouseId, actorUserId).then((r) => r.order);

    const exceptionResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'inbound_order' AND entity_id = $1 AND exception_type = 'REC.RECUSA_TOTAL' ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );
    const exception = exceptionResult.rows[0];
    if (!exception) throw new NotFoundException(`nenhuma exceção REC.RECUSA_TOTAL encontrada para inbound_order ${orderId}`);
    if (exception.status !== 'APPROVED') {
      throw new BadRequestException({
        error: 'REFUSAL_NOT_APPROVED',
        detail: `RN-REC-023: REC.RECUSA_TOTAL ainda não está APPROVED (status atual: ${exception.status})`,
      });
    }

    const updated = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE wms.inbound_order SET status = 'REFUSED', refusal_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [orderId, exception.reason_request, actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
      if (flowResult.rows.length > 0) {
        await this.operationFlowService.cancelFlow(client, flowResult.rows[0].id, actorUserId);
      }

      // RF-REC-023 não está entre os 11 eventos de §4.7 — mesmo precedente
      // de `recebimento.crossdock_tempo_excedido`/`portaria.vaga_indisponivel`:
      // evento novo citando a fonte exata (RN-REC-023), não o catálogo de 11.
      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.recusa_total_aplicada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_id: orderId, number: order.number },
      });

      return result.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RN-REC-023',
      before: order,
      after: updated,
    });

    return updated;
  }

  async findById(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const orderResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order WHERE id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`inbound_order ${orderId} not found`);

    const itemsResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order_item WHERE inbound_order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );

    return { order, items: itemsResult.rows };
  }

  private async createReceivingFlow(client: PoolClient, tenantId: string, warehouseId: string, orderId: string, actorUserId: string) {
    const { flow } = await this.operationFlowService.createFlow(
      client,
      { tenantId, warehouseId, entity: 'inbound_order', entityId: orderId, flowType: 'RECEBIMENTO', stepCodes: RECEIVING_FLOW_STEPS },
      actorUserId
    );
    // "CHEGADA já concluída na criação" — a chegada do VEÍCULO é do DOC-03
    // (gate-in); esta etapa só reflete que, ao existir uma Ordem, a chegada
    // do ponto de vista do Fluxo Operacional de recebimento já é fato.
    await this.operationFlowService.completeStep(client, flow.id, 'CHEGADA', actorUserId);
    return flow;
  }

  /**
   * RN-REC-012: casamento por SKU (exato), depois EAN (product_barcode,
   * exato), depois NCM+descrição. [LACUNA: DOC-04 não define um critério de
   * similaridade textual para "NCM+descrição" — implementado apenas como
   * NCM exato + descrição idêntica (case-insensitive), sem fuzzy matching.]
   */
  private async matchProduct(client: PoolClient, tenantId: string, item: ParsedNfeItem): Promise<string | null> {
    if (item.raw_sku) {
      const bySku = await client.query(`SELECT id FROM wms.product WHERE tenant_id = $1 AND sku = $2`, [tenantId, item.raw_sku]);
      if (bySku.rows.length > 0) return bySku.rows[0].id;
    }
    if (item.raw_ean) {
      const byEan = await client.query(`SELECT product_id FROM wms.product_barcode WHERE tenant_id = $1 AND barcode = $2`, [
        tenantId,
        item.raw_ean,
      ]);
      if (byEan.rows.length > 0) return byEan.rows[0].product_id;
    }
    if (item.raw_ncm && item.raw_description) {
      const byNcm = await client.query(`SELECT id FROM wms.product WHERE tenant_id = $1 AND ncm = $2 AND lower(description) = lower($3)`, [
        tenantId,
        item.raw_ncm,
        item.raw_description,
      ]);
      if (byNcm.rows.length > 0) return byNcm.rows[0].id;
    }
    return null;
  }

  private async loadClientWarehouseSettings(tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`,
      [tenantId, warehouseId]
    );
    const settings = result.rows[0];
    if (!settings) {
      throw new BadRequestException({
        error: 'CLIENT_WAREHOUSE_SETTINGS_NOT_FOUND',
        detail: `DOC-02 §5.1: client_warehouse_settings não configurado para tenant ${tenantId} x armazém ${warehouseId}`,
      });
    }
    return settings;
  }

  private async loadWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.warehouse WHERE id = $1`, [warehouseId]);
    const warehouse = result.rows[0];
    if (!warehouse) throw new NotFoundException(`warehouse ${warehouseId} not found`);
    return warehouse;
  }

  /**
   * Resolve o vehicle_visit da Ordem. Se `vehicleVisitId` for informado,
   * valida armazém/sentido/gate-in confirmado. Senão, tenta casar
   * automaticamente pela chave de NF-e informada no gate-in (DOC-03
   * RF-POR-011, vehicle_visit.nfe_keys) — só considera visitas cujo gate-in
   * já foi confirmado (RN-REC-011).
   */
  private async resolveVehicleVisit(
    tenantId: string,
    warehouseId: string,
    vehicleVisitId: string | null,
    accessKeyForAutoMatch: string | null,
    actorUserId: string
  ) {
    if (vehicleVisitId) {
      const result = await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `SELECT * FROM wms.vehicle_visit WHERE id = $1`,
        [vehicleVisitId]
      );
      const visit = result.rows[0];
      if (!visit) throw new NotFoundException(`vehicle_visit ${vehicleVisitId} not found`);
      if (visit.warehouse_id !== warehouseId || visit.direction !== 'INBOUND') {
        throw new BadRequestException({
          error: 'VEHICLE_VISIT_MISMATCH',
          detail: 'RF-REC-010: vehicle_visit informado não pertence a este armazém ou não é de entrada (INBOUND)',
        });
      }
      if (!GATE_IN_CONFIRMED_STATUSES.includes(visit.status)) {
        throw new BadRequestException({
          error: 'GATE_IN_NOT_CONFIRMED',
          detail: `RN-REC-011: o gate-in da visita ${vehicleVisitId} ainda não foi confirmado (status atual: ${visit.status})`,
        });
      }
      return visit;
    }

    if (!accessKeyForAutoMatch) return null;

    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.vehicle_visit
       WHERE warehouse_id = $1 AND direction = 'INBOUND' AND $2 = ANY(nfe_keys)
         AND status = ANY($3)
       ORDER BY created_at DESC LIMIT 1`,
      [warehouseId, accessKeyForAutoMatch, GATE_IN_CONFIRMED_STATUSES]
    );
    return result.rows[0] ?? null;
  }

  private addDays(base: Date, days: number): string {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
