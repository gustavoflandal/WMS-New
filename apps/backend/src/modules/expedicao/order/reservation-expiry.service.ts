// DOC-06 §4.1 RN-EXP-003 — expiração de reserva.
//
// "A reserva expira e é liberada automaticamente SE o pedido ... permanecer
// sem picking iniciado por mais de `EXP.RESERVA_VALIDADE_H` (padrão 72 h —
// expiração notifica e devolve o pedido a `RELEASED_EXPIRED` para nova
// liberação)."
//
// `RELEASED_EXPIRED` é substado de RELEASED (§5.1), então o pedido permanece
// em `RELEASED` com `reservation_expired = TRUE` — ver outbound-flow.util.ts.
//
// Roda cross-tenant via transactionAsWorker (ADR-006), mesmo padrão de
// ExpirationService (RN-EST-014) e CrossDockAgingWorkerImpl (RNF-REC-052).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';

const DEFAULT_RESERVATION_VALIDITY_HOURS = 72;

export interface ReservationExpiryResult {
  expiredOrderIds: string[];
  qtyReleased: number;
}

@Injectable()
export class ReservationExpiryService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService
  ) {}

  async expireOverdueReservations(referenceDate: Date = new Date()): Promise<ReservationExpiryResult> {
    const validityHours = await this.resolveValidityHours();

    return this.db.transactionAsWorker(async (client) => {
      // "sem picking iniciado": o pedido ainda está em RELEASED (não avançou
      // para IN_PICKING) e a reserva já passou da validade.
      const candidates = await client.query<{ id: string; tenant_id: string; warehouse_id: string; number: string }>(
        `SELECT id, tenant_id, warehouse_id, number
         FROM wms.outbound_order
         WHERE status = 'RELEASED'
           AND reservation_expired = FALSE
           AND reserved_at IS NOT NULL
           AND reserved_at < $1::timestamptz - ($2 || ' hours')::interval`,
        [referenceDate.toISOString(), validityHours]
      );

      const expiredOrderIds: string[] = [];
      let qtyReleased = 0;

      for (const order of candidates.rows) {
        const reservations = await client.query(
          `SELECT r.* FROM wms.stock_reservation r
           JOIN wms.outbound_order_item i ON i.id = r.demand_ref_id
           WHERE r.demand_ref_type = 'OUTBOUND_ORDER_ITEM' AND i.outbound_order_id = $1 AND r.status = 'ACTIVE'`,
          [order.id]
        );

        for (const reservation of reservations.rows) {
          // Devolve o saldo pelo serviço único (RN-EST-001): reserved → available.
          await this.stockMovementService.apply(client, {
            tenantId: order.tenant_id,
            warehouseId: order.warehouse_id,
            movementType: 'LIBERACAO_RESERVA',
            productId: reservation.product_id,
            batchId: reservation.batch_id,
            qty: Number(reservation.qty),
            locationIdFrom: reservation.location_id,
            palletIdFrom: reservation.pallet_id,
            locationIdTo: reservation.location_id,
            palletIdTo: reservation.pallet_id,
            documentRefType: 'OUTBOUND_ORDER',
            documentRefId: order.id,
            actorUserId: reservation.created_by,
          });
          await client.query(`UPDATE wms.stock_reservation SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [reservation.id]);
          qtyReleased += Number(reservation.qty);
        }

        await client.query(`UPDATE wms.outbound_order_item SET qty_reserved = 0, updated_at = now() WHERE outbound_order_id = $1`, [order.id]);
        // Substado RELEASED_EXPIRED: o pedido continua RELEASED (§5.1) e fica
        // pronto para nova liberação.
        await client.query(`UPDATE wms.outbound_order SET reservation_expired = TRUE, reserved_at = NULL, updated_at = now() WHERE id = $1`, [order.id]);

        await this.eventsService.publishInTransaction(client, {
          event_type: 'expedicao.reserva_efetivada',
          tenant_id: order.tenant_id,
          warehouse_id: order.warehouse_id,
          payload: { outbound_order_id: order.id, number: order.number, expired: true, display_status: 'RELEASED_EXPIRED' },
        });

        expiredOrderIds.push(order.id);
      }

      return { expiredOrderIds, qtyReleased };
    });
  }

  /** `EXP.RESERVA_VALIDADE_H` (§4.1, padrão 72). */
  private async resolveValidityHours(): Promise<number> {
    const result = await this.db.queryGlobal<{ value: string }>(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.RESERVA_VALIDADE_H'`);
    const parsed = result.rows[0]?.value === undefined ? NaN : Number(result.rows[0].value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESERVATION_VALIDITY_HOURS;
  }
}
