// DOC-10 §4.1 — RF-PAI-001/002. Convenção `paineis/<domínio-plural>`
// (mesmo padrão de estoque/inventarios, expedicao/pedidos).
import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { OperationsBoardService } from './operations-board.service.js';
import { BoardPreferenceService } from './board-preference.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

@Controller('paineis/operacoes')
@UseGuards(PermissionGuard)
export class OperationsBoardController {
  constructor(
    @Inject(OperationsBoardService) private readonly boardService: OperationsBoardService,
    @Inject(BoardPreferenceService) private readonly preferenceService: BoardPreferenceService
  ) {}

  /** RF-PAI-001/002 — cartões do painel, filtrados (RN-SEG-011) e ordenados. */
  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Get()
  listCards(
    @Query('warehouse_id') warehouseId: string,
    @Query('card_type') cardType: string | undefined,
    @Query('client_id') clientId: string | undefined,
    @Query('step_code') stepCode: string | undefined,
    @Query('only_with_exception') onlyWithException: string | undefined,
    @Query('only_late') onlyLate: string | undefined,
    @Query('created_from') createdFrom: string | undefined,
    @Query('created_to') createdTo: string | undefined,
    @Query('text') text: string | undefined,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.boardService.listCards({
      userId: principal.userId,
      warehouseId,
      cardType,
      clientId,
      stepCode,
      onlyWithException: onlyWithException === 'true',
      onlyLate: onlyLate === 'true',
      createdFrom,
      createdTo,
      text,
    });
  }

  /**
   * RF-PAI-002 — preferência de filtro do usuário (RD-PAI-005). `warehouse_id`
   * não é usado por BoardPreferenceService.get() (a preferência é por
   * usuário, não por armazém) — só existe na query para o PermissionGuard
   * derivar o contexto WAREHOUSE de PAI.PAINEL_OPERACOES (mesmo achado do
   * endpoint de trilha: sem isto, hasPermission() nunca casa a atribuição de
   * quem não é irrestrito e a rota nega para todo mundo — achado desta
   * sessão, via verificação manual ponta a ponta).
   */
  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Get('preferencias')
  getPreference(@Query('warehouse_id') _warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.preferenceService.get(principal.userId);
  }

  @RequirePermission('PAI.PAINEL_OPERACOES')
  @Post('preferencias')
  savePreference(@Body() body: { warehouse_id: string | null; filters: Record<string, unknown> }, @CurrentUser() principal: RequestPrincipal) {
    return this.preferenceService.save(principal.userId, body.warehouse_id, body.filters ?? {});
  }
}
