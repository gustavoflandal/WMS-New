// DOC-10 §4.2 — RF-PAI-010. Convenção `paineis/<domínio-plural>`.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AlertService } from './alert.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';

@Controller('paineis/alertas')
@UseGuards(PermissionGuard)
export class AlertController {
  constructor(
    @Inject(AlertService) private readonly alertService: AlertService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  /** RF-PAI-010 — mesmo padrão de RN-SEG-011 do painel (RbacService.resolveWarehouseAuthorizedClientIds). */
  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Get()
  async list(
    @Query('warehouse_id') warehouseId: string,
    @Query('status') status: 'EMITIDO' | 'RESOLVIDO' | undefined,
    @Query('severity') severity: 'INFO' | 'WARN' | 'CRIT' | undefined,
    @CurrentUser() principal: RequestPrincipal
  ) {
    const authorizedClientIds = await this.rbacService.resolveWarehouseAuthorizedClientIds(principal.userId, warehouseId, 'PAI.PAINEL_OPERACOES');
    return this.alertService.list({ warehouseId, authorizedClientIds, status, severity, userId: principal.userId });
  }

  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Get('nao-lidos/contagem')
  async countUnread(@Query('warehouse_id') warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    const authorizedClientIds = await this.rbacService.resolveWarehouseAuthorizedClientIds(principal.userId, warehouseId, 'PAI.PAINEL_OPERACOES');
    return { count: await this.alertService.countUnread(warehouseId, authorizedClientIds, principal.userId) };
  }

  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Post(':id/lido')
  async markRead(@Param('id') alertId: string, @Body() body: { tenant_id: string | null; warehouse_id: string }, @CurrentUser() principal: RequestPrincipal) {
    await this.alertService.markRead(alertId, principal.userId, body.tenant_id, body.warehouse_id);
    return { ok: true };
  }
}
