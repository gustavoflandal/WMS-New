// DOC-05 §4.4 RF-EST-031 — Reclassificação para avaria e descarte.
//
// RECLASSIFICACAO_AVARIA: aplicada IMEDIATAMENTE (permissão EST.DESCARTE +
// fotos obrigatórias, "como no DOC-04" — mesmo CHECK cardinality()>=1 de
// wms.discrepancy, migration 0038); a linha de wms.stock_reclassification
// nasce já RESOLVED/APPLIED.
//
// DESCARTE: "exige exceção EST.DESCARTE_SALDO (2 passos)" — nasce PENDING,
// vinculada a uma wms.operational_exception aberta FORA da transação de
// INSERT (o motor de workflow abre a própria, não é possível aninhar
// db.transaction() — mesmo padrão de CheckingService.createDiscrepancyWithException,
// DOC-04). decideDiscard() re-invoca OperationalExceptionService.decide() e só
// aplica o efeito de saldo quando a decisão é final (mesmo padrão de
// CheckingService.decideDiscrepancy — esta base não usa callback/webhook,
// o CALLER re-consulta o status retornado).
//
// [LACUNA: DOC-05 RF-EST-031 pede "termo de descarte em PDF e notificação ao
// cliente; reflexo fiscal no DOC-08" — nenhum pipeline de PDF, notificação
// formal ou módulo Fiscal (DOC-08, apps/backend/src/modules/fiscal é um stub
// vazio) existe nesta base ainda, mesmo precedente já documentado em
// CheckingService (DOC-04) para a "carta de divergência em PDF". O evento
// `estoque.descarte_efetivado` (outbox -> tópico "alertas") é o único sinal
// de notificação existente — pipeline de e-mail/PDF/fiscal é trabalho futuro.]
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { StockBucket } from '../movement/stock-movement-effects.util.js';
import { WriteOffPendingService } from '../../fiscal/write-off/write-off-pending.service.js';

export interface RegisterAvariaInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  locationId?: string | null;
  palletId?: string | null;
  fromBucket: 'AVAILABLE' | 'BLOCKED';
  qty: number;
  photoKeys: string[];
  actorUserId: string;
}

export interface RequestDiscardInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  locationId?: string | null;
  palletId?: string | null;
  sourceBucket: 'DAMAGED' | 'BLOCKED';
  qty: number;
  reasonRequest: string;
  actorUserId: string;
}

@Injectable()
export class StockReclassificationService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(WriteOffPendingService) private readonly writeOffPendingService: WriteOffPendingService
  ) {}

  /** RF-EST-031 — reclassificação para avaria, efeito imediato, fotos obrigatórias. */
  async registerAvaria(input: RegisterAvariaInput) {
    if (input.photoKeys.length === 0) {
      // Primeira linha de defesa (a real é o CHECK do banco, migration 0046
      // — mesmo raciocínio de wms.discrepancy/migration 0038): falha cedo
      // com um erro de negócio legível em vez de deixar o INSERT estourar.
      throw new BadRequestException({ error: 'PHOTO_REQUIRED', detail: 'RF-EST-031: reclassificação para avaria exige ao menos 1 foto (photoKeys)' });
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const result = await this.db.transaction(ctx, async (client) => {
      const movement = await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType: 'RECLASSIFICACAO_AVARIA',
        productId: input.productId,
        batchId: input.batchId ?? null,
        qty: input.qty,
        locationIdFrom: input.locationId ?? null,
        palletIdFrom: input.palletId ?? null,
        locationIdTo: input.locationId ?? null,
        palletIdTo: input.palletId ?? null,
        bucketFromOverride: input.fromBucket as StockBucket,
        actorUserId: input.actorUserId,
      });

      const inserted = await client.query(
        `INSERT INTO wms.stock_reclassification (
           tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id,
           request_type, from_bucket, qty, photo_keys, status, resolution, movement_id,
           created_by, resolved_at, resolved_by
         ) VALUES ($1,$2,$3,$4,$5,$6,'RECLASSIFICACAO_AVARIA',$7,$8,$9,'RESOLVED','APPLIED',$10,$11,now(),$11)
         RETURNING *`,
        [
          input.tenantId,
          input.warehouseId,
          input.productId,
          input.batchId ?? null,
          input.locationId ?? null,
          input.palletId ?? null,
          input.fromBucket,
          input.qty,
          input.photoKeys,
          movement.movementIds[0],
          input.actorUserId,
        ]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.saldo_alterado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { movement_type: 'RECLASSIFICACAO_AVARIA', product_id: input.productId, qty: input.qty, reclassification_id: inserted.rows[0].id },
      });

      return { reclassification: inserted.rows[0], movement };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'stock_reclassification',
      entityId: result.reclassification.id,
      action: 'CREATE',
      requirementId: 'DOC-05 RF-EST-031',
      after: result.reclassification,
    });

    return result;
  }

  /** RF-EST-031 — abre a solicitação de descarte + exceção EST.DESCARTE_SALDO (2 passos). */
  async requestDiscard(input: RequestDiscardInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const inserted = await this.db.query(
      ctx,
      `INSERT INTO wms.stock_reclassification (
         tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id,
         request_type, from_bucket, qty, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'DESCARTE',$7,$8,'PENDING',$9)
       RETURNING *`,
      [input.tenantId, input.warehouseId, input.productId, input.batchId ?? null, input.locationId ?? null, input.palletId ?? null, input.sourceBucket, input.qty, input.actorUserId]
    );
    const row = inserted.rows[0];

    // RN-SEG-021 (DOC-12): exceção aberta FORA da transação acima — o motor
    // de workflow abre a própria (não é possível aninhar db.transaction()),
    // mesmo padrão de CheckingService.createDiscrepancyWithException (DOC-04).
    const exception = await this.operationalExceptionService.create({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      exceptionType: 'EST.DESCARTE_SALDO',
      entity: 'stock_reclassification',
      entityId: row.id,
      qty: input.qty,
      reasonRequest: input.reasonRequest,
      requestedBy: input.actorUserId,
    });

    await this.db.query(ctx, `UPDATE wms.stock_reclassification SET operational_exception_id = $2 WHERE id = $1`, [row.id, exception.id]);
    row.operational_exception_id = exception.id;

    return row;
  }

  /**
   * RF-EST-031 — decide a exceção vinculada (motor genérico do DOC-12) e, se
   * a decisão for final, aplica o efeito (DESCARTE aprovado -> baixa de
   * saldo via StockMovementService; rejeitado -> sem efeito de saldo).
   */
  async decideDiscard(reclassificationId: string, tenantId: string, warehouseId: string, decidedBy: string, decision: 'APPROVE' | 'REJECT', reason: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: decidedBy, warehouse_id: warehouseId };
    const loaded = await this.db.query(ctx, `SELECT * FROM wms.stock_reclassification WHERE id = $1`, [reclassificationId]);
    const row = loaded.rows[0];
    if (!row) throw new NotFoundException(`stock_reclassification ${reclassificationId} not found`);
    if (row.request_type !== 'DESCARTE') {
      throw new BadRequestException({ error: 'NOT_A_DISCARD_REQUEST', detail: `RF-EST-031: reclassificação ${reclassificationId} não é do tipo DESCARTE` });
    }
    if (row.status !== 'PENDING') {
      throw new ConflictException({ error: 'DISCARD_ALREADY_RESOLVED', detail: `status atual: ${row.status}` });
    }
    if (!row.operational_exception_id) {
      throw new ConflictException({ error: 'NO_EXCEPTION_LINKED', detail: 'stock_reclassification sem operational_exception_id — estado inconsistente' });
    }

    const exception = await this.operationalExceptionService.decide(row.operational_exception_id, tenantId, warehouseId, decidedBy, decision, reason);
    if (!['APPROVED', 'REJECTED'].includes(exception.status)) {
      // EST.DESCARTE_SALDO é default_steps=2 (§3, migration 0044) — 1º passo
      // aprovado ainda deixa a exceção PENDING aguardando o 2º aprovador
      // (distinto, RN-SEG-043); nenhum efeito de saldo é aplicado até então.
      return { reclassification: row, exception, applied: false };
    }

    const approved = exception.status === 'APPROVED';
    const resolution = await this.db.transaction(ctx, async (client) => {
      let movementId: string | null = null;
      if (approved) {
        const movement = await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId,
          movementType: 'DESCARTE',
          productId: row.product_id,
          batchId: row.batch_id,
          qty: row.qty,
          locationIdFrom: row.location_id,
          palletIdFrom: row.pallet_id,
          bucketFromOverride: row.from_bucket as StockBucket,
          requirementId: row.operational_exception_id,
          actorUserId: decidedBy,
        });
        movementId = movement.movementIds[0];

        // DOC-08 RN-FIS-070: descarte aprovado em produto com Estoque Fiscal
        // trava qty_pending_writeoff (mesma transação do efeito físico) —
        // no-op (applied:false) quando o produto não tem fiscal_stock_balance.
        await this.writeOffPendingService.applyPendingWriteoffInTransaction(client, {
          tenantId,
          warehouseId,
          productId: row.product_id,
          qty: row.qty,
          origin: 'DESCARTE',
          originEntity: 'stock_reclassification',
          originEntityId: reclassificationId,
          actorUserId: decidedBy,
        });

        await this.eventsService.publishInTransaction(client, {
          event_type: 'estoque.descarte_efetivado',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: decidedBy,
          payload: { reclassification_id: reclassificationId, product_id: row.product_id, qty: row.qty },
        });
      }

      const updated = await client.query(
        `UPDATE wms.stock_reclassification SET status = 'RESOLVED', resolution = $2, movement_id = $3, resolved_at = now(), resolved_by = $4 WHERE id = $1 RETURNING *`,
        [reclassificationId, approved ? 'DISCARDED' : 'REJECTED', movementId, decidedBy]
      );
      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: decidedBy,
      origin: 'API',
      entity: 'stock_reclassification',
      entityId: reclassificationId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 RF-EST-031',
      reason,
      before: row,
      after: resolution,
    });

    return { reclassification: resolution, exception, applied: true };
  }
}
