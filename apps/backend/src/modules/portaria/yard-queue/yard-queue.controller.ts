// DOC-03 RF-POR-020/RN-POR-021 — painel de pátio (leitura: qualquer usuário
// autenticado do armazém, sem permissão dedicada em §3) e priorização
// manual (POR.FILA_PRIORIZAR).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { YardQueueService } from './yard-queue.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { Authenticated } from '../../../core/rbac/decorators/authenticated.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ManualPriorityBody {
  reason: string;
  warehouse_id: string;
}

@Controller('portaria/yard-queue')
@UseGuards(PermissionGuard)
export class YardQueueController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(YardQueueService) private readonly yardQueueService: YardQueueService) {}

  @Authenticated()
  @Get()
  listQueue(@Query('warehouse_id') warehouseId: string, @Query('direction') direction: 'INBOUND' | 'OUTBOUND') {
    return this.yardQueueService.listQueue(warehouseId, direction);
  }

  @RequirePermission('POR.FILA_PRIORIZAR')
  @Post(':id/manual-priority')
  setManualPriority(@Param('id') id: string, @Body() body: ManualPriorityBody, @CurrentUser() principal: RequestPrincipal) {
    return this.yardQueueService.setManualPriority(id, body.warehouse_id, body.reason, principal.userId);
  }
}
