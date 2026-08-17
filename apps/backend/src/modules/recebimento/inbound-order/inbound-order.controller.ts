// DOC-04 §4.2 — Ordem de Recebimento. Auditoria de CREATE/STATUS_CHANGE feita
// explicitamente dentro do InboundOrderService (before/after reais) —
// nenhuma rota aqui usa @Audited()/AuditInterceptor para evitar registro
// duplicado (mesmo padrão do gate-in.controller.ts, DOC-03).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateFromXmlInput, CreateManualInput, InboundOrderService } from './inbound-order.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface CancelBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
}

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface FindQuery {
  tenant_id: string;
  warehouse_id: string;
}

@Controller('recebimento/inbound-orders')
@UseGuards(PermissionGuard)
export class InboundOrderController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(InboundOrderService) private readonly inboundOrderService: InboundOrderService) {}

  @RequirePermission('REC.CONFERIR')
  @Post('xml')
  createFromXml(@Body() body: CreateFromXmlInput, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.createFromXml(body, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('manual')
  createManual(@Body() body: CreateManualInput, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.createManual(body, principal.userId);
  }

  @RequirePermission('REC.CANCELAR_RECEBIMENTO')
  @Post(':orderId/cancel')
  cancel(@Param('orderId') orderId: string, @Body() body: CancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.cancel(orderId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Get(':orderId')
  findById(@Param('orderId') orderId: string, @Query() query: FindQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.findById(orderId, query.tenant_id, query.warehouse_id, principal.userId);
  }

  // RN-REC-023 (REC.RECUSA_TOTAL) não tem código de permissão dedicado no
  // catálogo de 6 do DOC-04 §3 — REC.CANCELAR_RECEBIMENTO reaproveitado por
  // ser a permissão sensível mais próxima em severidade (mesmo padrão de
  // "reaproveitar a mais próxima quando o documento não define uma
  // dedicada", já usado em crossdock.controller.ts).
  @RequirePermission('REC.CANCELAR_RECEBIMENTO')
  @Post(':orderId/request-total-refusal')
  requestTotalRefusal(@Param('orderId') orderId: string, @Body() body: CancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.requestTotalRefusal(orderId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('REC.CANCELAR_RECEBIMENTO')
  @Post(':orderId/apply-total-refusal-decision')
  applyTotalRefusalDecision(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inboundOrderService.applyTotalRefusalDecision(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
