// DOC-02 §5.2 — zone. Permissão DAD.PHYSICAL_STRUCTURE_MANAGE (WAREHOUSE,
// DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12] da Sessão 2A.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() (JWT, populado por PermissionGuard) — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ZoneService, CreateZoneInput, UpdateZoneInput } from './zone.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/zones')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class ZoneController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ZoneService) private readonly zoneService: ZoneService) {}

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'zone', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateZoneInput, @CurrentUser() principal: RequestPrincipal) {
    return this.zoneService.create(body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.zoneService.listByWarehouse(warehouseId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.zoneService.findById(id);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateZoneInput, @CurrentUser() principal: RequestPrincipal) {
    return this.zoneService.update(id, body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.zoneService.deactivate(id, principal.userId);
  }
}
