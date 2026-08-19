// DOC-06 §4.7 RF-EXP-061 — Carregamento: leitura de cada Volume, recusa de
// volume estranho no ato, conclusão efetiva a baixa (SAIDA_EXPEDICAO).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { isFirstPendingStep } from '../order/flow-step-guard.util.js';

export interface OpenLoadingInput {
  tenantId: string;
  warehouseId: string;
  vehicleVisitId?: string | null;
  orderIds: string[];
  actorUserId: string;
}

@Injectable()
export class LoadingService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService
  ) {}

  /** RF-EXP-061 — abre a carga: veículo (opcional aqui, validado em vinculação futura) + pedidos IN_DISPATCH. */
  async openLoading(input: OpenLoadingInput) {
    if (input.orderIds.length === 0) throw new BadRequestException({ error: 'EMPTY_LOADING', detail: 'RF-EXP-061: a carga exige ao menos 1 pedido' });
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const created = await this.db.transaction(ctx, async (client) => {
      const ordersResult = await client.query(`SELECT id, number, status FROM wms.outbound_order WHERE id = ANY($1::uuid[]) AND warehouse_id = $2`, [
        input.orderIds,
        input.warehouseId,
      ]);
      if (ordersResult.rows.length !== input.orderIds.length) throw new NotFoundException('RF-EXP-061: um ou mais pedidos não existem neste armazém');
      for (const order of ordersResult.rows) {
        if (order.status !== 'IN_DISPATCH') {
          throw new ConflictException({ error: 'ORDER_NOT_READY_FOR_LOADING', detail: `RF-EXP-061: pedido ${order.number} não está IN_DISPATCH (status atual: ${order.status})` });
        }
      }

      const loadingResult = await client.query(
        `INSERT INTO wms.loading (tenant_id, warehouse_id, vehicle_visit_id, status, started_at, created_by) VALUES ($1,$2,$3,'OPEN', now(), $4) RETURNING *`,
        [input.tenantId, input.warehouseId, input.vehicleVisitId ?? null, input.actorUserId]
      );
      const loading = loadingResult.rows[0];

      for (const orderId of input.orderIds) {
        await client.query(`INSERT INTO wms.loading_order (tenant_id, loading_id, outbound_order_id, created_by) VALUES ($1,$2,$3,$4)`, [
          input.tenantId,
          loading.id,
          orderId,
          input.actorUserId,
        ]);
      }

      return loading;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'loading',
      entityId: created.id,
      action: 'CREATE',
      requirementId: 'DOC-06 RF-EXP-061',
      after: { ...created, order_ids: input.orderIds },
    });

    return created;
  }

  /**
   * RF-EXP-061 — leitura de UM volume no embarque. "Volume estranho à carga
   * é recusado no ato identificando o pedido de origem." Volume de um pedido
   * REAL que não pertence a esta carga (LPN existe, mas outbound_order_id
   * fora do conjunto de loading_order) é REJECTED_FOREIGN; LPN inexistente é
   * REJECTED_UNKNOWN.
   */
  async scanPackage(loadingId: string, lpn: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const loading = await this.loadLoading(loadingId, ctx);
    if (loading.status !== 'OPEN') {
      throw new ConflictException({ error: 'LOADING_NOT_OPEN', detail: `RF-EXP-061: carga ${loadingId} não está OPEN (status atual: ${loading.status})` });
    }

    const packageResult = await this.db.query(ctx, `SELECT * FROM wms.package WHERE lpn = $1`, [lpn]);
    const pkg = packageResult.rows[0];

    // Rejeições são gravadas FORA da transação de efeito (this.db.query direto,
    // não client.query): o registro da recusa precisa SOBREVIVER ao erro que
    // devolvemos ao chamador — mesmo padrão de REJECTED_SCAN no putaway (4B),
    // que grava e audita ANTES de lançar a exceção, nunca dentro de um bloco
    // que será revertido pelo próprio throw.
    if (!pkg) {
      await this.db.query(
        ctx,
        `INSERT INTO wms.loading_scan (tenant_id, loading_id, package_id, outbound_order_id, scanned_lpn, result, rejection_detail, scanned_by)
         VALUES ($1,$2,NULL,NULL,$3,'REJECTED_UNKNOWN',$4,$5)`,
        [tenantId, loadingId, lpn, `RF-EXP-061: LPN "${lpn}" não corresponde a nenhum volume`, actorUserId]
      );
      throw new BadRequestException({ error: 'UNKNOWN_PACKAGE', detail: `RF-EXP-061: LPN "${lpn}" não corresponde a nenhum volume conhecido` });
    }

    const memberResult = await this.db.query(ctx, `SELECT 1 FROM wms.loading_order WHERE loading_id = $1 AND outbound_order_id = $2`, [loadingId, pkg.outbound_order_id]);
    if (memberResult.rows.length === 0) {
      const orderResult = await this.db.query(ctx, `SELECT number FROM wms.outbound_order WHERE id = $1`, [pkg.outbound_order_id]);
      const detail = `RF-EXP-061: volume ${lpn} pertence ao pedido ${orderResult.rows[0]?.number ?? pkg.outbound_order_id}, que não faz parte desta carga`;
      await this.db.query(
        ctx,
        `INSERT INTO wms.loading_scan (tenant_id, loading_id, package_id, outbound_order_id, scanned_lpn, result, rejection_detail, scanned_by)
         VALUES ($1,$2,$3,$4,$5,'REJECTED_FOREIGN',$6,$7)`,
        [tenantId, loadingId, pkg.id, pkg.outbound_order_id, lpn, detail, actorUserId]
      );
      throw new BadRequestException({ error: 'FOREIGN_PACKAGE', detail, originOrderId: pkg.outbound_order_id });
    }

    if (pkg.status !== 'WEIGHED') {
      throw new ConflictException({ error: 'PACKAGE_NOT_READY', detail: `RF-EXP-061: volume ${lpn} não está WEIGHED (status atual: ${pkg.status})` });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      await client.query(`UPDATE wms.package SET status = 'LOADED', loaded_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1`, [pkg.id, actorUserId]);
      await this.recordScan(client, loadingId, tenantId, pkg.id, pkg.outbound_order_id, lpn, 'ACCEPTED', null, actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.volume_carregado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { loading_id: loadingId, package_id: pkg.id, outbound_order_id: pkg.outbound_order_id, lpn },
      });

      const orderCompleted = await this.tryCompleteLoadingForOrder(client, pkg.outbound_order_id, tenantId, warehouseId, actorUserId);
      if (orderCompleted) {
        await this.tryCompleteLoading(client, loadingId, actorUserId);
      }

      return { package_id: pkg.id, outbound_order_id: pkg.outbound_order_id, result: 'ACCEPTED', order_completed: orderCompleted };
    });

    return result;
  }

  /**
   * RF-EXP-061 — quando TODOS os volumes (não cancelados) do pedido estão
   * LOADED: efetiva SAIDA_EXPEDICAO (baixa definitiva do saldo físico, lendo
   * as reservas ATIVAS — RN-EST-001) e conclui a etapa Carregamento.
   */
  private async tryCompleteLoadingForOrder(client: PoolClient, orderId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<boolean> {
    const pendingResult = await client.query(`SELECT COUNT(*) AS count FROM wms.package WHERE outbound_order_id = $1 AND status NOT IN ('LOADED', 'CANCELLED')`, [
      orderId,
    ]);
    if (Number(pendingResult.rows[0].count) > 0) return false;

    if (!(await isFirstPendingStep(client, orderId, 'CARREGAMENTO'))) return false;

    const reservationsResult = await client.query(
      `SELECT r.* FROM wms.stock_reservation r
       JOIN wms.outbound_order_item i ON i.id = r.demand_ref_id
       WHERE r.demand_ref_type = 'OUTBOUND_ORDER_ITEM' AND i.outbound_order_id = $1 AND r.status = 'ACTIVE'`,
      [orderId]
    );
    for (const reservation of reservationsResult.rows) {
      await this.stockMovementService.apply(client, {
        tenantId,
        warehouseId,
        movementType: 'SAIDA_EXPEDICAO',
        productId: reservation.product_id,
        batchId: reservation.batch_id,
        qty: Number(reservation.qty),
        locationIdFrom: reservation.location_id,
        palletIdFrom: reservation.pallet_id,
        documentRefType: 'OUTBOUND_ORDER',
        documentRefId: orderId,
        actorUserId,
      });
      await client.query(`UPDATE wms.stock_reservation SET status = 'CONSUMED', updated_at = now(), updated_by = $2 WHERE id = $1`, [reservation.id, actorUserId]);
    }

    await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'CARREGAMENTO' }, actorUserId);
    return true;
  }

  private async tryCompleteLoading(client: PoolClient, loadingId: string, actorUserId: string): Promise<void> {
    const pendingResult = await client.query(
      `SELECT COUNT(*) AS count FROM wms.loading_order lo
       JOIN wms.outbound_order o ON o.id = lo.outbound_order_id
       WHERE lo.loading_id = $1 AND o.status != 'LOADED'`,
      [loadingId]
    );
    if (Number(pendingResult.rows[0].count) > 0) return;
    await client.query(`UPDATE wms.loading SET status = 'COMPLETED', completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1`, [loadingId, actorUserId]);
  }

  private async recordScan(
    client: PoolClient,
    loadingId: string,
    tenantId: string,
    packageId: string | null,
    outboundOrderId: string | null,
    scannedLpn: string,
    result: 'ACCEPTED' | 'REJECTED_FOREIGN' | 'REJECTED_UNKNOWN',
    rejectionDetail: string | null,
    actorUserId: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO wms.loading_scan (tenant_id, loading_id, package_id, outbound_order_id, scanned_lpn, result, rejection_detail, scanned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, loadingId, packageId, outboundOrderId, scannedLpn, result, rejectionDetail, actorUserId]
    );
  }

  private async loadLoading(loadingId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.loading WHERE id = $1`, [loadingId]);
    const loading = result.rows[0];
    if (!loading) throw new NotFoundException(`loading ${loadingId} not found`);
    return loading;
  }
}
