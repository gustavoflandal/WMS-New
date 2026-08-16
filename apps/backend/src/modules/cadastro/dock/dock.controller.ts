// DOC-02 §5.2 — dock. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DockService, CreateDockInput } from './dock.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/docks')
@UseGuards(NoAuthGuard)
export class DockController {
  constructor(private readonly dockService: DockService) {}

  @Post()
  create(@Body() body: CreateDockInput) {
    return this.dockService.create(body);
  }

  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.dockService.listByWarehouse(warehouseId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.dockService.findById(id);
  }
}
