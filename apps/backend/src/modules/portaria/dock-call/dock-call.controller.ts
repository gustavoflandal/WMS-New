// DOC-03 RF-POR-022 — POR.CHAMADA_DOCA. Auditoria feita explicitamente
// dentro do DockCallService — sem @Audited() aqui.
import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { DockCallService } from './dock-call.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ConfirmCallBody {
  queue_entry_id: string;
  dock_id: string;
  warehouse_id: string;
}

@Controller('portaria/dock-calls')
@UseGuards(PermissionGuard)
export class DockCallController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DockCallService) private readonly dockCallService: DockCallService) {}

  @RequirePermission('POR.CHAMADA_DOCA')
  @Get('suggest-next')
  suggestNext(@Query('warehouse_id') warehouseId: string, @Query('direction') direction: 'INBOUND' | 'OUTBOUND') {
    return this.dockCallService.suggestNext(warehouseId, direction);
  }

  @RequirePermission('POR.CHAMADA_DOCA')
  @Post('confirm')
  confirmCall(@Body() body: ConfirmCallBody, @CurrentUser() principal: RequestPrincipal) {
    return this.dockCallService.confirmCall(body.queue_entry_id, body.dock_id, body.warehouse_id, principal.userId);
  }
}
