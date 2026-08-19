// DOC-06 §4.7 RF-EXP-060 — Etapa Expedição (documental).
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { DispatchService } from './dispatch.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

@Controller('expedicao')
@UseGuards(PermissionGuard)
export class DispatchController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DispatchService) private readonly dispatchService: DispatchService) {}

  @RequirePermission('EXP.EXPEDICAO_LIBERAR')
  @Post('volumes/:id/staging')
  scanForStaging(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dispatchService.scanForStaging(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EXP.EXPEDICAO_LIBERAR')
  @Post('pedidos/:id/documentos-fiscais/confirmar')
  confirmFiscalDocuments(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dispatchService.confirmFiscalDocuments(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EXP.EXPEDICAO_LIBERAR')
  @Post('pedidos/:id/expedicao/concluir')
  attemptComplete(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dispatchService.attemptCompleteDispatchStep(id, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
