// DOC-02 §5.2 — warehouse. Permissão DAD.WAREHOUSE_MANAGE (GLOBAL, DOC-12
// migration 0016) — substitui o [LACUNA: RBAC DOC-12] da Sessão 2A.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { WarehouseService, CreateWarehouseInput, UpdateWarehouseInput } from './warehouse.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/warehouses')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class WarehouseController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(WarehouseService) private readonly warehouseService: WarehouseService) {}

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Audited({ entity: 'warehouse', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateWarehouseInput, @CurrentUser() principal: RequestPrincipal) {
    return this.warehouseService.create(body, principal.userId);
  }

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Get()
  list() {
    return this.warehouseService.list();
  }

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.warehouseService.findById(id);
  }

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateWarehouseInput, @CurrentUser() principal: RequestPrincipal) {
    return this.warehouseService.update(id, body, principal.userId);
  }

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.warehouseService.deactivate(id, principal.userId);
  }
}
