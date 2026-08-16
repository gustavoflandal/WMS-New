// DOC-03 §3 — permissão POR.CADASTRO_MOTORISTA_VISITANTE (mesmo escopo de
// motorista/visitante — §3 não separa uma permissão dedicada a veículo).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { VehicleService, UpsertVehicleInput } from './vehicle.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('portaria/vehicles')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class VehicleController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(VehicleService) private readonly vehicleService: VehicleService) {}

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Audited({ entity: 'vehicle', action: 'CREATE', requirementId: 'DOC-03 RF-POR-011' })
  @Post()
  upsert(@Body() body: UpsertVehicleInput, @CurrentUser() principal: RequestPrincipal) {
    return this.vehicleService.upsertByPlate(body, principal.userId);
  }

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Get()
  findByPlate(@Query('plate') plate: string) {
    return this.vehicleService.findByPlate(plate);
  }

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.vehicleService.findById(id);
  }
}
