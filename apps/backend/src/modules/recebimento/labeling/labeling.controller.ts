// DOC-04 §4.4 — Etiquetagem e paletização. Auditoria feita explicitamente
// dentro do LabelingService (before/after reais) — nenhuma rota aqui usa
// @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { LabelingService, PalletContentInput } from './labeling.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface FormPalletBody extends TenantWarehouseBody {
  pallet_type: string;
  contents: PalletContentInput[];
}

interface ReleaseQuarantineBody extends TenantWarehouseBody {
  reason: string;
}

interface ProgressQuery {
  tenant_id: string;
  warehouse_id: string;
}

@Controller('recebimento')
@UseGuards(PermissionGuard)
export class LabelingController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(LabelingService) private readonly labelingService: LabelingService) {}

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-orders/:orderId/start-labeling')
  startLabeling(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelingService.startLabeling(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Post('inbound-orders/:orderId/pallets')
  formPallet(@Param('orderId') orderId: string, @Body() body: FormPalletBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelingService.formPallet(orderId, body.tenant_id, body.warehouse_id, body.pallet_type, body.contents, principal.userId);
  }

  @RequirePermission('REC.CONFERIR')
  @Get('inbound-orders/:orderId/labeling-progress')
  getLabelingProgress(@Param('orderId') orderId: string, @Query() query: ProgressQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.labelingService.getLabelingProgress(orderId, query.tenant_id, query.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.LIBERAR_QUARENTENA')
  @Post('batches/:batchId/release-quarantine')
  releaseQuarantine(@Param('batchId') batchId: string, @Body() body: ReleaseQuarantineBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelingService.releaseQuarantine(batchId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }
}
