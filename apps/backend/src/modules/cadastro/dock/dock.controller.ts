// DOC-02 §5.2 — dock. Permissão DAD.PHYSICAL_STRUCTURE_MANAGE (WAREHOUSE,
// DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12].
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { DockService, CreateDockInput } from './dock.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/docks')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class DockController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DockService) private readonly dockService: DockService) {}

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'dock', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateDockInput, @CurrentUser() principal: RequestPrincipal) {
    return this.dockService.create(body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.dockService.listByWarehouse(warehouseId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.dockService.findById(id);
  }
}
