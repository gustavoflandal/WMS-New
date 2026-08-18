// DOC-05 §4.2 RN-EST-013 — quebra de política de giro.
//
// Esta é a ÚNICA rota HTTP desta sessão, e existe porque RN-EST-013 descreve
// explicitamente um ato do usuário ("QUANDO um usuário solicitar seleção fora
// da ordem") com permissão nomeada no catálogo (`EST.QUEBRA_POLITICA_GIRO`,
// migration 0016).
//
// [LACUNA: DOC-05 §3 não define permissão para a reserva REGULAR nem para
// consultar uma simulação de seleção — o catálogo EST.* do §3 cobre
// transferência, bloqueio, inventário e descarte, nenhum código para
// "reservar" ou "consultar saldo". Por isso a seleção/reserva regular NÃO é
// exposta por rota nesta sessão: seus consumidores são internos (kanban
// agora; picking do DOC-06 depois), e inventar um código de permissão para
// expô-la violaria a disciplina de citação. Quando o DOC-06 definir a
// permissão de picking, a rota regular nasce lá.]
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { StockReservationService } from './stock-reservation.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { SelectionPurpose } from './stock-selection.port.js';

interface PolicyBreakReservationBody {
  tenant_id: string;
  warehouse_id: string;
  product_id: string;
  demand_qty: number;
  purpose: SelectionPurpose;
  demand_ref_type: string;
  demand_ref_id: string;
  /** RN-EST-013: lote específico exigido pelo cliente (quebra da ORDEM). */
  forced_batch_id?: string;
  /** RN-EST-013: quebra da exclusão por shelf life (exige anexo na exceção). */
  override_shelf_life?: boolean;
  /** Exceção EST.QUEBRA_FEFO já APROVADA — validada antes de qualquer efeito. */
  policy_break_exception_id: string;
  break_reason: string;
  today?: string;
  allow_partial?: boolean;
}

@Controller('estoque/reservas')
@UseGuards(PermissionGuard)
export class StockReservationController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StockReservationService) private readonly stockReservationService: StockReservationService) {}

  @RequirePermission('EST.QUEBRA_POLITICA_GIRO')
  @Post('quebra-politica')
  reserveWithPolicyBreak(@Body() body: PolicyBreakReservationBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockReservationService.reserve({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      demandQty: body.demand_qty,
      purpose: body.purpose,
      demandRefType: body.demand_ref_type,
      demandRefId: body.demand_ref_id,
      forcedBatchId: body.forced_batch_id ?? null,
      overrideShelfLife: body.override_shelf_life ?? false,
      policyBreakExceptionId: body.policy_break_exception_id,
      breakReason: body.break_reason,
      today: body.today,
      allowPartial: body.allow_partial ?? false,
      actorUserId: principal.userId,
    });
  }
}
