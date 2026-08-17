// DOC-04 §4.3 — Descarga e conferência. Auditoria feita explicitamente
// dentro do CheckingService (before/after reais) — nenhuma rota aqui usa
// @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CheckingService } from './checking.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface CountBody extends TenantWarehouseBody {
  checking_id: string;
  qty_counted: number;
  conferente_user_id: string;
}

interface AvariaBody extends TenantWarehouseBody {
  checking_id: string;
  qty_damaged: number;
  photo_keys: string[];
}

interface TrocaBody extends TenantWarehouseBody {
  checking_id: string;
  missing_item_id: string;
  excess_item_id: string;
  qty: number;
}

interface DecideBody extends TenantWarehouseBody {
  decision: 'APPROVE' | 'REJECT';
  reason: string;
  destination?: 'RECEIVED_BLOCKED' | 'REFUSED_ITEM' | 'RECEIVED_DAMAGED';
}

@Controller('recebimento')
@UseGuards(PermissionGuard)
export class CheckingController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(CheckingService) private readonly checkingService: CheckingService) {}

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-orders/:orderId/start-unloading')
  startUnloading(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.startUnloading(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-orders/:orderId/start-checking')
  startChecking(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.startChecking(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-order-items/:itemId/count')
  countFirstRound(@Param('itemId') itemId: string, @Body() body: CountBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.countFirstRound(body.checking_id, itemId, body.qty_counted, body.conferente_user_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.RECONTAR')
  @Post('inbound-order-items/:itemId/recount')
  recount(@Param('itemId') itemId: string, @Body() body: CountBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.recount(body.checking_id, itemId, body.qty_counted, body.conferente_user_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-order-items/:itemId/avaria')
  registerAvaria(@Param('itemId') itemId: string, @Body() body: AvariaBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.registerAvaria(body.checking_id, itemId, body.qty_damaged, body.photo_keys, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('checkings/:checkingId/troca')
  registerTroca(@Param('checkingId') checkingId: string, @Body() body: TrocaBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.registerTroca(checkingId, body.missing_item_id, body.excess_item_id, body.qty, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.ENCERRAR_CONFERENCIA')
  @Post('discrepancies/:discrepancyId/decide')
  decideDiscrepancy(@Param('discrepancyId') discrepancyId: string, @Body() body: DecideBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.decideDiscrepancy(discrepancyId, body.tenant_id, body.warehouse_id, principal.userId, body.decision, body.reason, body.destination);
  }

  @RequirePermission('REC.ENCERRAR_CONFERENCIA')
  @Post('inbound-orders/:orderId/close-checking')
  closeChecking(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.checkingService.closeChecking(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
