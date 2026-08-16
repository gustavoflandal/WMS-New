// DOC-02 §5.1 — client_warehouse_settings. Permissão
// DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE (CLIENT_WAREHOUSE, DOC-12 migration
// 0016) — substitui o [LACUNA: RBAC DOC-12] da Sessão 2A.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ClientWarehouseSettingsService,
  CreateClientWarehouseSettingsInput,
  UpdateClientWarehouseSettingsInput,
} from './client-warehouse-settings.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/client-warehouse-settings')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class ClientWarehouseSettingsController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ClientWarehouseSettingsService) private readonly service: ClientWarehouseSettingsService) {}

  @RequirePermission('DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE')
  @Audited({ entity: 'client_warehouse_settings', action: 'CREATE', requirementId: 'DOC-02 §5.1' })
  @Post()
  create(@Body() body: CreateClientWarehouseSettingsInput, @CurrentUser() principal: RequestPrincipal) {
    return this.service.create(body, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE')
  @Get()
  listByTenant(@Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.service.listByTenant(tenantId, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.service.findById(id, tenantId, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Body() body: UpdateClientWarehouseSettingsInput,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.service.update(id, tenantId, body, principal.userId);
  }
}
