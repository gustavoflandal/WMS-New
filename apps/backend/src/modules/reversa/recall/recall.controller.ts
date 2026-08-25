// DOC-07 §4.4 RF-REV-030 — Recall de lote.
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { RecallService } from './recall.service.js';

interface TriggerRecallBody {
  tenant_id: string;
  warehouse_id: string;
  batch_id: string;
  reason: string;
}

@Controller('reversa/recall')
@UseGuards(PermissionGuard)
export class RecallController {
  constructor(@Inject(RecallService) private readonly recallService: RecallService) {}

  @RequirePermission('REV.RECALL')
  @Post()
  triggerRecall(@Body() body: TriggerRecallBody, @CurrentUser() principal: RequestPrincipal) {
    return this.recallService.triggerRecall(
      { tenantId: body.tenant_id, triggeringWarehouseId: body.warehouse_id, batchId: body.batch_id, reason: body.reason },
      principal.userId
    );
  }
}
