// DOC-02 §5.2 — storage_equipment. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { StorageEquipmentService, CreateStorageEquipmentInput } from './storage-equipment.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/storage-equipment')
@UseGuards(NoAuthGuard)
export class StorageEquipmentController {
  constructor(private readonly storageEquipmentService: StorageEquipmentService) {}

  @Post()
  create(@Body() body: CreateStorageEquipmentInput) {
    return this.storageEquipmentService.create(body);
  }

  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.storageEquipmentService.listByWarehouse(warehouseId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.storageEquipmentService.findById(id);
  }

  @Post(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body('status') status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE',
    @Body('actor_user_id') actorUserId: string
  ) {
    return this.storageEquipmentService.setStatus(id, status, actorUserId);
  }
}
