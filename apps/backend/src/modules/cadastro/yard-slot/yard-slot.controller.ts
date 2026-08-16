// DOC-02 §5.2 — yard_slot. Permissão DAD.PHYSICAL_STRUCTURE_MANAGE
// (WAREHOUSE, DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12].
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { YardSlotService, CreateYardSlotInput } from './yard-slot.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/yard-slots')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class YardSlotController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(YardSlotService) private readonly yardSlotService: YardSlotService) {}

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Audited({ entity: 'yard_slot', action: 'CREATE', requirementId: 'DOC-02 §5.2' })
  @Post()
  create(@Body() body: CreateYardSlotInput, @CurrentUser() principal: RequestPrincipal) {
    return this.yardSlotService.create(body, principal.userId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.yardSlotService.listByWarehouse(warehouseId);
  }

  @RequirePermission('DAD.PHYSICAL_STRUCTURE_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.yardSlotService.findById(id);
  }
}
