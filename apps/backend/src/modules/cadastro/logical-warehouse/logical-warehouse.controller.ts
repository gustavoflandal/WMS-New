// DOC-02 §5.1 — logical_warehouse. Permissão DAD.LOGICAL_WAREHOUSE_MANAGE
// (CLIENT_WAREHOUSE, DOC-12 migration 0016) — substitui o
// [LACUNA: RBAC DOC-12] da Sessão 2A.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, Delete, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  LogicalWarehouseService,
  CreateLogicalWarehouseInput,
  UpdateLogicalWarehouseInput,
} from './logical-warehouse.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/logical-warehouses')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class LogicalWarehouseController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(LogicalWarehouseService) private readonly service: LogicalWarehouseService) {}

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Audited({ entity: 'logical_warehouse', action: 'CREATE', requirementId: 'DOC-02 §5.1' })
  @Post()
  create(@Body() body: CreateLogicalWarehouseInput, @CurrentUser() principal: RequestPrincipal) {
    return this.service.create(body, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Get()
  listByTenant(@Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.service.listByTenant(tenantId, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.service.findById(id, tenantId, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Body() body: UpdateLogicalWarehouseInput,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.service.update(id, tenantId, body, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.service.deactivate(id, tenantId, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Post(':id/locations/:locationId')
  link(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Query('tenant_id') tenantId: string,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.service.link(id, locationId, tenantId, principal.userId);
  }

  @RequirePermission('DAD.LOGICAL_WAREHOUSE_MANAGE')
  @Delete(':id/locations/:locationId')
  unlink(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Query('tenant_id') tenantId: string,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.service.unlink(id, locationId, tenantId, principal.userId);
  }
}
