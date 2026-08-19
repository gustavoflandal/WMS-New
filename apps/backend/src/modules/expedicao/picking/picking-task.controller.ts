// DOC-06 §4.4 — Picking: execução (RF-EXP-031) e decisão de corte (RN-EXP-032).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PickingTaskService } from './picking-task.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { DatabaseService } from '../../../core/database/database.service.js';

interface TenantWarehouseQuery {
  tenant_id: string;
  warehouse_id: string;
}

interface ExecuteTaskBody extends TenantWarehouseQuery {
  operation_id: string;
  scanned_location_code: string;
  scanned_product_code: string;
  qty_confirmed: number;
  reason_code?: string;
  reason_text?: string;
  weight_kg?: number;
  weight_source?: 'SCALE' | 'MANUAL';
}

interface ShortDecisionBody extends TenantWarehouseQuery {
  decision: 'RESELECT' | 'DEFINITIVE';
}

@Controller('expedicao/picking')
@UseGuards(PermissionGuard)
export class PickingTaskController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(PickingTaskService) private readonly pickingTaskService: PickingTaskService,
    @Inject(DatabaseService) private readonly db: DatabaseService
  ) {}

  @RequirePermission('EXP.PICKING_EXECUTAR')
  @Get('tarefas')
  listTasks(@Query('order_id') orderId: string, @Query('tenant_id') tenantId: string, @Query('warehouse_id') warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.db.query(
      { tenant_id: tenantId, user_id: principal.userId, warehouse_id: warehouseId },
      `SELECT * FROM wms.picking_task WHERE outbound_order_id = $1 ORDER BY route_sequence ASC`,
      [orderId]
    );
  }

  @RequirePermission('EXP.PICKING_EXECUTAR')
  @Post('tarefas/:id/executar')
  execute(@Param('id') id: string, @Body() body: ExecuteTaskBody, @CurrentUser() principal: RequestPrincipal) {
    return this.pickingTaskService.executeTask(
      id,
      body.tenant_id,
      body.warehouse_id,
      {
        operationId: body.operation_id,
        scannedLocationCode: body.scanned_location_code,
        scannedProductCode: body.scanned_product_code,
        qtyConfirmed: body.qty_confirmed,
        reasonCode: body.reason_code ?? null,
        reasonText: body.reason_text ?? null,
        weightKg: body.weight_kg ?? null,
        weightSource: body.weight_source ?? null,
      },
      principal.userId
    );
  }

  @RequirePermission('EXP.ONDA_GERIR')
  @Post('tarefas/:id/decisao-corte')
  decideShort(@Param('id') id: string, @Body() body: ShortDecisionBody, @CurrentUser() principal: RequestPrincipal) {
    return this.pickingTaskService.applyShortDecision(id, body.decision, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
