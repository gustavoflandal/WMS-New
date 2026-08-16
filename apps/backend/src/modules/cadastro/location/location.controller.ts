// DOC-02 §5.2 — location. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  LocationService,
  CreateLocationInput,
  BulkGenerateLocationsInput,
} from './location.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/locations')
@UseGuards(NoAuthGuard)
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @Post()
  create(@Body() body: CreateLocationInput) {
    return this.locationService.create(body);
  }

  /** RF-DAD-054: geração em massa de endereços por intervalo de coordenadas. */
  @Post('bulk-generate')
  bulkGenerate(@Body() body: BulkGenerateLocationsInput) {
    return this.locationService.bulkGenerate(body);
  }

  @Get()
  list(@Query('warehouse_id') warehouseId: string, @Query('code') code?: string) {
    if (code) {
      return this.locationService.findByCode(warehouseId, code);
    }
    return this.locationService.listByWarehouse(warehouseId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.locationService.findById(id);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body('actor_user_id') actorUserId: string) {
    return this.locationService.deactivate(id, actorUserId);
  }
}
