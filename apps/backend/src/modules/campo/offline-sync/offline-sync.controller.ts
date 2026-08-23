// DOC-01 §4.6 RF-ARQ-052/RN-ARQ-053 — recepção da fila offline de sincronização.
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { OfflineSyncService, OfflineOperationInput, OfflineTaskType } from './offline-sync.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface SyncOperationBody {
  operation_id: string;
  tenant_id: string;
  task_type: OfflineTaskType;
  task_id?: string;
  payload: Record<string, any>;
}

interface SyncBatchBody {
  device_id: string;
  warehouse_id: string;
  app_version?: string;
  battery_pct?: number;
  queue_size?: number;
  read_failures_physical?: number;
  read_failures_camera?: number;
  /** RN-ARQ-053: ordem FIFO por dispositivo — o array preserva a ordem de gravação (RG-007). */
  operations: SyncOperationBody[];
}

@Controller('campo/sincronizacao')
@UseGuards(PermissionGuard)
export class OfflineSyncController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(OfflineSyncService) private readonly offlineSyncService: OfflineSyncService) {}

  @RequirePermission('COL.OPERAR')
  @Post()
  sincronizar(@Body() body: SyncBatchBody, @CurrentUser() principal: RequestPrincipal) {
    const operations: OfflineOperationInput[] = body.operations.map((op) => ({
      operationId: op.operation_id,
      tenantId: op.tenant_id,
      taskType: op.task_type,
      taskId: op.task_id,
      payload: op.payload,
    }));
    return this.offlineSyncService.sincronizar({
      deviceId: body.device_id,
      warehouseId: body.warehouse_id,
      appVersion: body.app_version,
      batteryPct: body.battery_pct,
      queueSize: body.queue_size,
      readFailuresPhysical: body.read_failures_physical,
      readFailuresCamera: body.read_failures_camera,
      operations,
      actorUserId: principal.userId,
    });
  }
}
