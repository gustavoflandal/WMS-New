// DOC-02 §5.1 — client_warehouse_settings. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ClientWarehouseSettingsService,
  CreateClientWarehouseSettingsInput,
  UpdateClientWarehouseSettingsInput,
} from './client-warehouse-settings.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/client-warehouse-settings')
@UseGuards(NoAuthGuard)
export class ClientWarehouseSettingsController {
  constructor(private readonly service: ClientWarehouseSettingsService) {}

  @Post()
  create(@Body() body: CreateClientWarehouseSettingsInput) {
    return this.service.create(body);
  }

  @Get()
  listByTenant(@Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string) {
    return this.service.listByTenant(tenantId, actorUserId);
  }

  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string) {
    return this.service.findById(id, tenantId, actorUserId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body() body: UpdateClientWarehouseSettingsInput) {
    return this.service.update(id, tenantId, body);
  }
}
