// DOC-06 §4.1/§4.2/§4.8 — Pedido, Fluxo Operacional e estornos.
//
// RN-EXP-011 regra 3: "tentativa de acionar etapa posterior é inerte na UI e
// erro FLOW_STEP_ORDER_VIOLATION na API". A guarda NÃO está aqui — está no
// serviço (core/OperationFlowService.completeStep), justamente para que
// nenhum caminho de API a contorne. Este controller só transporta.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OutboundOrderService } from './outbound-order.service.js';
import { OutboundFlowService } from './outbound-flow.service.js';
import { OutboundReversalService } from './outbound-reversal.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { OutboundFlowStep } from './outbound-flow.util.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface CreateOrderBody extends TenantWarehouseBody {
  items: Array<{ product_id: string; qty: number; packaging_id?: string }>;
  recipient_name?: string;
  recipient_document?: string;
  expected_dispatch_date?: string;
  carrier_name?: string;
  appointment_id?: string;
}

interface CompleteStepBody extends TenantWarehouseBody {
  step: OutboundFlowStep;
}

interface ReverseStepBody extends TenantWarehouseBody {
  step: OutboundFlowStep;
  reason: string;
  reversal_exception_id?: string;
}

interface CancelOrderBody extends TenantWarehouseBody {
  reason: string;
  late_cancellation_exception_id?: string;
}

@Controller('expedicao/pedidos')
@UseGuards(PermissionGuard)
export class OutboundOrderController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(OutboundOrderService) private readonly outboundOrderService: OutboundOrderService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService,
    @Inject(OutboundReversalService) private readonly outboundReversalService: OutboundReversalService
  ) {}

  @RequirePermission('EXP.PEDIDO_CRIAR')
  @Post()
  create(@Body() body: CreateOrderBody, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundOrderService.create({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      items: body.items.map((i) => ({ productId: i.product_id, qty: i.qty, packagingId: i.packaging_id ?? null })),
      recipientName: body.recipient_name ?? null,
      recipientDocument: body.recipient_document ?? null,
      expectedDispatchDate: body.expected_dispatch_date ?? null,
      carrierName: body.carrier_name ?? null,
      appointmentId: body.appointment_id ?? null,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.PEDIDO_LIBERAR')
  @Post(':id/liberar')
  release(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundOrderService.release(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  /**
   * RN-EXP-011 — contrato ÚNICO do estado do fluxo, consumido pelo painel
   * (DOC-10): etapas, estados, qual é acionável e quais estão bloqueadas.
   */
  @RequirePermission('EXP.PEDIDO_CRIAR')
  @Get(':id/fluxo')
  getFlow(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundFlowService.getOrderFlowState(id, tenantId, principal.userId);
  }

  /**
   * Conclusão de etapa. A permissão declarada aqui é a de LIBERAR porque as
   * etapas concluíveis nesta sessão são as do próprio pedido; a 6B, ao trazer
   * picking/packing/pesagem, exporá as rotas das suas etapas com as
   * permissões específicas do §3 (EXP.PICKING_EXECUTAR etc.).
   */
  @RequirePermission('EXP.PEDIDO_LIBERAR')
  @Post(':id/etapas/concluir')
  completeStep(@Param('id') id: string, @Body() body: CompleteStepBody, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundFlowService.completeOrderStepStandalone(
      { tenantId: body.tenant_id, warehouseId: body.warehouse_id, orderId: id, step: body.step },
      principal.userId
    );
  }

  @RequirePermission('EXP.ESTORNO')
  @Post(':id/estornar')
  reverseStep(@Param('id') id: string, @Body() body: ReverseStepBody, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundReversalService.reverseStep({
      orderId: id,
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      step: body.step,
      reason: body.reason,
      reversalExceptionId: body.reversal_exception_id ?? null,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.PEDIDO_CANCELAR')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: CancelOrderBody, @CurrentUser() principal: RequestPrincipal) {
    return this.outboundReversalService.cancel({
      orderId: id,
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      reason: body.reason,
      lateCancellationExceptionId: body.late_cancellation_exception_id ?? null,
      actorUserId: principal.userId,
    });
  }
}
