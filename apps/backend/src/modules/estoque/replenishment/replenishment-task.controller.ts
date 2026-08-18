// DOC-05 §4.5 RF-EST-042 — Reposição de picking (execução com dupla leitura).
// [LACUNA] DOC-05 §3 não lista uma permissão dedicada para reposição —
// reaproveitada EST.TRANSFERIR_INTERNO (mesma natureza operacional: mover
// saldo entre endereços internos do armazém).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ReplenishmentTaskService } from './replenishment-task.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface AssignBody extends TenantWarehouseBody {
  assigned_to_user_id: string;
}

interface ExecuteBody extends TenantWarehouseBody {
  operation_id: string;
  scanned_location_code_from: string;
  scanned_location_code_to: string;
}

@Controller('estoque/reposicoes')
@UseGuards(PermissionGuard)
export class ReplenishmentTaskController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ReplenishmentTaskService) private readonly replenishmentTaskService: ReplenishmentTaskService) {}

  @RequirePermission('EST.TRANSFERIR_INTERNO')
  @Get()
  listQueue(@Query('tenant_id') tenantId: string, @Query('warehouse_id') warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.replenishmentTaskService.listQueue(tenantId, warehouseId, principal.userId);
  }

  @RequirePermission('EST.TRANSFERIR_INTERNO')
  @Post(':id/assign')
  assign(@Param('id') id: string, @Body() body: AssignBody, @CurrentUser() principal: RequestPrincipal) {
    return this.replenishmentTaskService.assignTask(id, body.assigned_to_user_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EST.TRANSFERIR_INTERNO')
  @Post(':id/execute')
  execute(@Param('id') id: string, @Body() body: ExecuteBody, @CurrentUser() principal: RequestPrincipal) {
    return this.replenishmentTaskService.executeTask(
      id,
      { operationId: body.operation_id, scannedLocationCodeFrom: body.scanned_location_code_from, scannedLocationCodeTo: body.scanned_location_code_to },
      body.tenant_id,
      body.warehouse_id,
      principal.userId
    );
  }
}
