// DOC-02 §5.2 — yard_slot. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { YardSlotService, CreateYardSlotInput } from './yard-slot.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/yard-slots')
@UseGuards(NoAuthGuard)
export class YardSlotController {
  constructor(private readonly yardSlotService: YardSlotService) {}

  @Post()
  create(@Body() body: CreateYardSlotInput) {
    return this.yardSlotService.create(body);
  }

  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.yardSlotService.listByWarehouse(warehouseId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.yardSlotService.findById(id);
  }
}
