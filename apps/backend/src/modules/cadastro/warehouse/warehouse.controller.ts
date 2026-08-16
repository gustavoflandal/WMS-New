// DOC-02 §5.2 — warehouse. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { WarehouseService, CreateWarehouseInput, UpdateWarehouseInput } from './warehouse.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/warehouses')
@UseGuards(NoAuthGuard)
export class WarehouseController {
  constructor(private readonly warehouseService: WarehouseService) {}

  @Post()
  create(@Body() body: CreateWarehouseInput) {
    return this.warehouseService.create(body);
  }

  @Get()
  list() {
    return this.warehouseService.list();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.warehouseService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateWarehouseInput) {
    return this.warehouseService.update(id, body);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body('actor_user_id') actorUserId: string) {
    return this.warehouseService.deactivate(id, actorUserId);
  }
}
