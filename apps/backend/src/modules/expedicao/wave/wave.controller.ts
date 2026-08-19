// DOC-06 §4.3 RF-EXP-020 — Ondas.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { WaveService } from './wave.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface CreateWaveBody extends TenantWarehouseBody {
  outbound_order_ids: string[];
  filters?: Record<string, unknown>;
}

interface ReleaseImplicitBody extends TenantWarehouseBody {
  order_id: string;
}

@Controller('expedicao/ondas')
@UseGuards(PermissionGuard)
export class WaveController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(WaveService) private readonly waveService: WaveService) {}

  @RequirePermission('EXP.ONDA_GERIR')
  @Post()
  create(@Body() body: CreateWaveBody, @CurrentUser() principal: RequestPrincipal) {
    return this.waveService.create({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      outboundOrderIds: body.outbound_order_ids,
      filters: body.filters,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.ONDA_GERIR')
  @Post(':id/liberar')
  release(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.waveService.release(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  /** §4.3 — "onda unitária implícita": libera um pedido para picking sem agrupá-lo manualmente numa onda. */
  @RequirePermission('EXP.PEDIDO_LIBERAR')
  @Post('liberar-unitaria')
  releaseImplicit(@Body() body: ReleaseImplicitBody, @CurrentUser() principal: RequestPrincipal) {
    return this.waveService.releaseImplicit(body.order_id, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
