// DOC-02 §5.2 — zone. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ZoneService, CreateZoneInput, UpdateZoneInput } from './zone.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/zones')
@UseGuards(NoAuthGuard)
export class ZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Post()
  create(@Body() body: CreateZoneInput) {
    return this.zoneService.create(body);
  }

  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.zoneService.listByWarehouse(warehouseId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.zoneService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateZoneInput) {
    return this.zoneService.update(id, body);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body('actor_user_id') actorUserId: string) {
    return this.zoneService.deactivate(id, actorUserId);
  }
}
