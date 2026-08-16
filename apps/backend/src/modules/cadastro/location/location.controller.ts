// DOC-02 §5.2 — location. Permissão DAD.PHYSICAL_STRUCTURE_MANAGE
// (WAREHOUSE, DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12].
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  LocationService,
  CreateLocationInput,
  BulkGenerateLocationsInput,
} from './location.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/locations')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class LocationController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(LocationService) private readonly locationService: LocationService) {}

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'location', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateLocationInput, @CurrentUser() principal: RequestPrincipal) {
    return this.locationService.create(body, principal.userId);
  }

  /** RF-DAD-054: geração em massa de endereços por intervalo de coordenadas. */
  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'location', action: 'CREATE', requirementId: 'RF-DAD-054' })
  @Post('bulk-generate')
  bulkGenerate(@Body() body: BulkGenerateLocationsInput, @CurrentUser() principal: RequestPrincipal) {
    return this.locationService.bulkGenerate(body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get()
  list(@Query('warehouse_id') warehouseId: string, @Query('code') code?: string) {
    if (code) {
      return this.locationService.findByCode(warehouseId, code);
    }
    return this.locationService.listByWarehouse(warehouseId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.locationService.findById(id);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.locationService.deactivate(id, principal.userId);
  }
}
