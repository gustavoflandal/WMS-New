// DOC-17 RF-TEL-001 — contrato único de detalhe de etapa. Mesmo prefixo de
// `core/operation-flow/operation-flow.controller.ts` (rotas distintas, sem
// colisão) — ver decisão 1 do prompt da sessão para por que este controller
// vive em `modules/telas` (negócio) e não em `core`.
import { BadRequestException, Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { StepDetailService } from './step-detail.service.js';

@Controller('fluxo-operacional')
@UseGuards(PermissionGuard)
export class StepDetailController {
  constructor(@Inject(StepDetailService) private readonly stepDetailService: StepDetailService) {}

  @RequirePermission('TEL.DETALHE_CONSULTAR')
  @Get(':entity/:entityId/steps/:stepCode/detail')
  getStepDetail(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @Param('stepCode') stepCode: string,
    @Query('tenant_id') tenantId: string,
    @Query('warehouse_id') warehouseId: string | undefined,
    @CurrentUser() principal: RequestPrincipal
  ) {
    // Achado real de sessão anterior (operation-flow.controller.ts): sem
    // warehouse_id na query, PermissionGuard nunca resolve o contexto
    // WAREHOUSE (RN-SEG-011) e a rota nega para todo usuário não irrestrito.
    if (!warehouseId) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    return this.stepDetailService.getStepDetail({ tenantId, warehouseId, entity, entityId, stepCode }, principal.userId);
  }
}
