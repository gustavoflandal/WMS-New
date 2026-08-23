// DOC-10 §4.5 — RF-PAI-040/043. Convenção `paineis/<domínio-plural>`.
import { BadRequestException, Controller, ForbiddenException, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { DashboardService } from './dashboard.service.js';
import { resolveGroup } from './dashboard-groups.util.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';

@Controller('paineis/dashboard')
@UseGuards(PermissionGuard)
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboardService: DashboardService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  /** RF-PAI-040 — filtro de período (padrão hoje) + cliente (autorizados). */
  @RequirePermission('PAI.DASHBOARD')
  @Get(':group')
  async getGroup(
    @Param('group') groupParam: string,
    @Query('warehouse_id') warehouseId: string,
    @Query('client_id') clientId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() principal: RequestPrincipal
  ) {
    const group = resolveGroup(groupParam);
    if (!group) throw new BadRequestException({ error: 'INVALID_GROUP', detail: 'RF-PAI-040: grupo deve ser RECEBIMENTO/EXPEDICAO/PATIO_PORTARIA/ESTOQUE' });
    await this.assertClientAuthorized(principal.userId, clientId);

    const today = new Date().toISOString().slice(0, 10);
    const period = { from: from ?? today, to: to ?? today };

    return this.dashboardService.getGroupDashboard(group, warehouseId, clientId ?? null, period);
  }

  /** RF-PAI-043 — exportação CSV auditada. */
  @RequirePermission('PAI.DASHBOARD')
  @Get(':group/csv')
  async exportCsv(
    @Param('group') groupParam: string,
    @Query('warehouse_id') warehouseId: string,
    @Query('client_id') clientId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() principal: RequestPrincipal,
    @Res() res: Response
  ) {
    const group = resolveGroup(groupParam);
    if (!group) throw new BadRequestException({ error: 'INVALID_GROUP', detail: 'RF-PAI-040: grupo deve ser RECEBIMENTO/EXPEDICAO/PATIO_PORTARIA/ESTOQUE' });
    await this.assertClientAuthorized(principal.userId, clientId);

    const today = new Date().toISOString().slice(0, 10);
    const period = { from: from ?? today, to: to ?? today };
    const csv = await this.dashboardService.exportGroupCsv(group, warehouseId, clientId ?? null, period, principal.userId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${group.toLowerCase()}-${period.from}-${period.to}.csv"`);
    res.send(csv);
  }

  /** RF-PAI-040 "cliente (autorizados)" — só filtra por um client_id que o usuário de fato tem atribuição sobre. */
  private async assertClientAuthorized(userId: string, clientId: string | undefined): Promise<void> {
    if (!clientId) return;
    const authorized = await this.rbacService.getAuthorizedClientIds(userId);
    if (!authorized.includes(clientId)) {
      throw new ForbiddenException({ error: 'CLIENT_NOT_AUTHORIZED', detail: 'RF-PAI-040: cliente fora das atribuições vigentes do usuário' });
    }
  }
}
