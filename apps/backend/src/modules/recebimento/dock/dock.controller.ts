// DOC-04 §4.1 — Docas. Auditoria de STATUS_CHANGE feita explicitamente
// dentro do DockService (before/after reais) — nenhuma rota aqui usa
// @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DockService } from './dock.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface DockVehicleBody {
  inbound_order_id: string;
  tenant_id: string;
  warehouse_id: string;
  checked_seal_in?: string | null;
}

interface ReleaseDockBody {
  warehouse_id: string;
}

interface SuggestQuery {
  warehouse_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  vehicle_type: string;
  preferred_zone_ids?: string;
}

@Controller('recebimento/docks')
@UseGuards(PermissionGuard)
export class DockController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DockService) private readonly dockService: DockService) {}

  @RequirePermission('REC.ATRACAR')
  @Post('dock-vehicle')
  dockVehicle(@Body() body: DockVehicleBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dockService.dockVehicle(body.inbound_order_id, body.tenant_id, body.warehouse_id, body.checked_seal_in ?? null, principal.userId);
  }

  @RequirePermission('REC.LIBERAR_DOCA')
  @Post(':dockId/release')
  releaseDock(@Param('dockId') dockId: string, @Body() body: ReleaseDockBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dockService.releaseDock(dockId, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REC.ATRACAR')
  @Get('suggest')
  suggestDock(@Query() query: SuggestQuery) {
    const preferredZoneIds = query.preferred_zone_ids ? query.preferred_zone_ids.split(',').filter(Boolean) : [];
    return this.dockService.suggestDock(query.warehouse_id, query.direction, query.vehicle_type, preferredZoneIds);
  }
}
