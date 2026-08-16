// DOC-02 §5.1 — logical_warehouse. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Delete, Query, UseGuards } from '@nestjs/common';
import {
  LogicalWarehouseService,
  CreateLogicalWarehouseInput,
  UpdateLogicalWarehouseInput,
} from './logical-warehouse.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/logical-warehouses')
@UseGuards(NoAuthGuard)
export class LogicalWarehouseController {
  constructor(private readonly service: LogicalWarehouseService) {}

  @Post()
  create(@Body() body: CreateLogicalWarehouseInput) {
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
  update(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body() body: UpdateLogicalWarehouseInput) {
    return this.service.update(id, tenantId, body);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body('actor_user_id') actorUserId: string) {
    return this.service.deactivate(id, tenantId, actorUserId);
  }

  @Post(':id/locations/:locationId')
  link(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Query('tenant_id') tenantId: string,
    @Body('actor_user_id') actorUserId: string
  ) {
    return this.service.link(id, locationId, tenantId, actorUserId);
  }

  @Delete(':id/locations/:locationId')
  unlink(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_user_id') actorUserId: string
  ) {
    return this.service.unlink(id, locationId, tenantId, actorUserId);
  }
}
