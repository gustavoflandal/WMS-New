// DOC-06 §4.3 RF-EXP-020 — Ondas: formação e liberação.
//
// Escopo desta sessão (6A): a ONDA e seus limites. A GERAÇÃO DAS TAREFAS de
// picking que a liberação dispara é da Sessão 6B (RF-EXP-030) — aqui a
// liberação da onda marca o agrupamento como liberado e publica o evento que
// a 6B consumirá para gerar as tarefas.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PickingTaskService } from '../picking/picking-task.service.js';

export interface CreateWaveInput {
  tenantId: string;
  warehouseId: string;
  /** Pedidos a agrupar — precisam estar RELEASED (§4.3). */
  outboundOrderIds: string[];
  /** Filtros que formaram a onda (§4.3), guardados como aplicados (§7). */
  filters?: Record<string, unknown>;
  actorUserId: string;
}

const DEFAULT_MAX_ORDERS_PER_WAVE = 200;

@Injectable()
export class WaveService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(PickingTaskService) private readonly pickingTaskService: PickingTaskService
  ) {}

  /**
   * RF-EXP-020 — "agrupar pedidos `RELEASED` em Onda por filtros".
   * Limite `EXP.ONDA_MAX_PEDIDOS` (padrão 200).
   */
  async create(input: CreateWaveInput) {
    if (input.outboundOrderIds.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_WAVE', detail: 'RF-EXP-020: a onda exige ao menos 1 pedido' });
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const maxOrders = await this.resolveMaxOrders(ctx);
    if (input.outboundOrderIds.length > maxOrders) {
      throw new BadRequestException({
        error: 'WAVE_MAX_ORDERS_EXCEEDED',
        detail: `RF-EXP-020: a onda excede EXP.ONDA_MAX_PEDIDOS (${input.outboundOrderIds.length} > ${maxOrders})`,
      });
    }

    const created = await this.db.transaction(ctx, async (client) => {
      // §4.3: só pedidos RELEASED entram em onda. Verificado item a item para
      // que a mensagem aponte QUAL pedido está fora da condição.
      const ordersResult = await client.query(
        `SELECT id, number, status, wave_id FROM wms.outbound_order WHERE id = ANY($1::uuid[]) AND warehouse_id = $2`,
        [input.outboundOrderIds, input.warehouseId]
      );
      if (ordersResult.rows.length !== input.outboundOrderIds.length) {
        throw new NotFoundException('RF-EXP-020: um ou mais pedidos informados não existem neste armazém');
      }
      for (const order of ordersResult.rows) {
        if (order.status !== 'RELEASED') {
          throw new BadRequestException({
            error: 'ORDER_NOT_RELEASED',
            detail: `RF-EXP-020: só pedidos RELEASED entram em onda — ${order.number} está em ${order.status}`,
          });
        }
        if (order.wave_id !== null) {
          throw new ConflictException({ error: 'ORDER_ALREADY_IN_WAVE', detail: `RF-EXP-020: o pedido ${order.number} já pertence a outra onda` });
        }
      }

      const waveResult = await client.query(
        `INSERT INTO wms.wave (tenant_id, warehouse_id, status, filters, created_by) VALUES ($1,$2,'CREATED',$3,$4) RETURNING *`,
        [input.tenantId, input.warehouseId, JSON.stringify(input.filters ?? {}), input.actorUserId]
      );
      const wave = waveResult.rows[0];

      let sequence = 1;
      for (const orderId of input.outboundOrderIds) {
        await client.query(
          `INSERT INTO wms.wave_order (tenant_id, wave_id, outbound_order_id, sequence_order, created_by) VALUES ($1,$2,$3,$4,$5)`,
          [input.tenantId, wave.id, orderId, sequence, input.actorUserId]
        );
        await client.query(`UPDATE wms.outbound_order SET wave_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [orderId, wave.id, input.actorUserId]);
        sequence += 1;
      }

      return { wave, orderCount: input.outboundOrderIds.length };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'wave',
      entityId: created.wave.id,
      action: 'CREATE',
      requirementId: 'DOC-06 RF-EXP-020',
      after: { ...created.wave, order_count: created.orderCount },
    });

    return created;
  }

  /**
   * RF-EXP-020 — liberação da onda: passa a RELEASED, publica
   * `expedicao.onda_liberada` e GERA as tarefas de picking de todos os
   * pedidos consolidando o sequenciamento (RF-EXP-030, fechado na 6B — a 6A
   * só persistia a ordem de entrada em wave_order.sequence_order).
   */
  async release(waveId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const wave = await this.loadWave(waveId, ctx);
    if (wave.status !== 'CREATED') {
      throw new ConflictException({ error: 'WAVE_NOT_RELEASABLE', detail: `RF-EXP-020: a onda ${waveId} não está CREATED (status atual: ${wave.status})` });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const ordersResult = await client.query(
        `SELECT outbound_order_id FROM wms.wave_order WHERE wave_id = $1 ORDER BY sequence_order ASC`,
        [waveId]
      );
      const orderIds = ordersResult.rows.map((r: any) => r.outbound_order_id);

      const updated = await client.query(
        `UPDATE wms.wave SET status = 'RELEASED', released_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [waveId, actorUserId]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.onda_liberada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { wave_id: waveId, outbound_order_ids: orderIds },
      });

      await this.pickingTaskService.generateForOrders(client, { tenantId, warehouseId, waveId, orderIds }, actorUserId);

      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'wave',
      entityId: waveId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RF-EXP-020',
      before: wave,
      after: result,
    });

    return result;
  }

  /**
   * §4.3 — "Pedido sem onda PODE ser liberado individualmente (onda
   * unitária implícita)." Implementado como uma onda REAL de um único
   * pedido, criada e liberada na mesma chamada: reaproveita 100% do código
   * já testado de create()/release() (mesmo evento `expedicao.onda_liberada`,
   * mesma geração de tarefas) em vez de um segundo caminho de liberação —
   * "onda unitária" é tratado literalmente, não como um bypass da onda.
   */
  async releaseImplicit(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const created = await this.create({ tenantId, warehouseId, outboundOrderIds: [orderId], filters: { implicit: true }, actorUserId });
    return this.release(created.wave.id, tenantId, warehouseId, actorUserId);
  }

  /** `EXP.ONDA_MAX_PEDIDOS` (§4.3, padrão 200). */
  private async resolveMaxOrders(ctx: TenantContext): Promise<number> {
    const result = await this.db.query(ctx, `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.ONDA_MAX_PEDIDOS'`, []);
    const value = result.rows[0]?.value;
    const parsed = value === undefined ? NaN : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ORDERS_PER_WAVE;
  }

  private async loadWave(waveId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.wave WHERE id = $1`, [waveId]);
    const wave = result.rows[0];
    if (!wave) throw new NotFoundException(`wave ${waveId} not found`);
    return wave;
  }
}
