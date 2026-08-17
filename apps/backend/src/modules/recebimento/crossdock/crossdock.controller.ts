// DOC-04 §4.6 — Cross-docking. Auditoria feita explicitamente dentro do
// CrossDockService (before/after reais) — nenhuma rota aqui usa
// @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CrossDockService } from './crossdock.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface LinkBody {
  tenant_id: string;
  warehouse_id: string;
  outbound_order_reference: string;
  qty: number;
}

interface FormPalletBody {
  tenant_id: string;
  warehouse_id: string;
  pallet_type: string;
  link_ids: string[];
}

interface CancelLinkBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
}

@Controller('recebimento/crossdock')
@UseGuards(PermissionGuard)
export class CrossDockController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(CrossDockService) private readonly crossDockService: CrossDockService) {}

  // RN-REC-050 cita "vínculo manual por LIDER_TURNO" mas o catálogo de 6
  // permissões do DOC-04 §3 não tem um código dedicado para isso, e
  // LIDER_TURNO não recebeu REC.CONFERIR na migration 0033 (só
  // ATRACAR/LIBERAR_DOCA/ENCERRAR_CONFERENCIA) — [LACUNA: DOC-04 não
  // define a permissão exata]. REC.CONFERIR usado por ser a mais próxima
  // semanticamente (mesmo ator que processa a Ordem/ASN).
  @RequirePermission('REC.CONFERIR')
  @Post('inbound-order-items/:itemId/link')
  linkToOutboundOrder(@Param('itemId') itemId: string, @Body() body: LinkBody, @CurrentUser() principal: RequestPrincipal) {
    return this.crossDockService.linkToOutboundOrder(itemId, body.tenant_id, body.warehouse_id, body.outbound_order_reference, body.qty, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('pallets')
  formCrossDockPallet(@Body() body: FormPalletBody, @CurrentUser() principal: RequestPrincipal) {
    return this.crossDockService.formCrossDockPallet(body.tenant_id, body.warehouse_id, body.pallet_type, body.link_ids, principal.userId);
  }

  @RequirePermission('REC.CANCELAR_RECEBIMENTO')
  @Post('links/:linkId/cancel')
  cancelLink(@Param('linkId') linkId: string, @Body() body: CancelLinkBody, @CurrentUser() principal: RequestPrincipal) {
    return this.crossDockService.cancelLink(linkId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }
}
