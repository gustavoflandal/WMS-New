// DOC-02 §5.2 — storage_equipment. Permissão DAD.PHYSICAL_STRUCTURE_MANAGE
// (WAREHOUSE, DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12].
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { StorageEquipmentService, CreateStorageEquipmentInput } from './storage-equipment.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/storage-equipment')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class StorageEquipmentController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StorageEquipmentService) private readonly storageEquipmentService: StorageEquipmentService) {}

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'storage_equipment', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateStorageEquipmentInput, @CurrentUser() principal: RequestPrincipal) {
    return this.storageEquipmentService.create(body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.storageEquipmentService.listByWarehouse(warehouseId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.storageEquipmentService.findById(id);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Post(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body('status') status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE',
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.storageEquipmentService.setStatus(id, status, principal.userId);
  }
}
