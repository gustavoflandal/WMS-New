// DOC-10 RF-PAI-005 (apresentação de RN-EXP-011) — expõe via HTTP o
// contrato único de leitura já existente (OperationFlowService.getFlowState,
// 6A). Nenhuma rota HTTP o expunha antes desta sessão; a tela da trilha
// (7B) é a 1ª consumidora. Genérico por desenho — server o mesmo endpoint
// para pedido, recebimento, reversa, transferência e inventário sem
// variação por tipo, mesma promessa do componente de trilha em @wms/ui.
//
// [LACUNA: DOC-10 não nomeia uma permissão própria para a leitura isolada
// do Fluxo Operacional — RF-PAI-005 descreve o acesso como "a partir do
// cartão" do Painel, então reaproveita PAI.PAINEL_OPERACOES.]
//
// `warehouse_id` é EXIGIDO na query mesmo não sendo usado por
// OperationFlowService.getFlowState() (tenant_id+entity+entityId já
// identificam a linha sem ambiguidade): PermissionGuard resolve o contexto
// WAREHOUSE de RN-SEG-011 lendo `request.query.warehouse_id` — sem ele,
// hasPermission() nunca casa a atribuição WAREHOUSE do usuário e a rota
// nega para todo mundo que não seja irrestrito (achado desta sessão, via
// verificação manual ponta a ponta com um usuário GESTOR_ARMAZEM real).
import { BadRequestException, Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { OperationFlowService } from './operation-flow.service.js';
import { PermissionGuard, RequestPrincipal } from '../rbac/guards/permission.guard.js';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../rbac/decorators/current-user.decorator.js';

@Controller('fluxo-operacional')
@UseGuards(PermissionGuard)
export class OperationFlowController {
  constructor(@Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService) {}

  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Get(':entity/:entityId')
  getFlowState(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @Query('tenant_id') tenantId: string,
    @Query('warehouse_id') warehouseId: string | undefined,
    @CurrentUser() principal: RequestPrincipal
  ) {
    if (!warehouseId) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    return this.operationFlowService.getFlowState(tenantId, principal.userId, entity, entityId);
  }
}
