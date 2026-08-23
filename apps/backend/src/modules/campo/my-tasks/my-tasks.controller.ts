// DOC-15 §4.5 T1 — Minhas Tarefas.
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { MyTasksService } from './my-tasks.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

@Controller('campo/minhas-tarefas')
@UseGuards(PermissionGuard)
export class MyTasksController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(MyTasksService) private readonly myTasksService: MyTasksService) {}

  @RequirePermission('COL.OPERAR')
  @Get()
  list(@Query('warehouse_id') warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.myTasksService.listMyTasks(warehouseId, principal.userId);
  }
}
