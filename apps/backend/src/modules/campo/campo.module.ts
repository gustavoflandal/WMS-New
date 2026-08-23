// DOC-15 (Sessão COL-1) — plataforma PWA de coletor: registro de
// dispositivo, PIN de re-bloqueio, e as 3 telas online (T1/T7/T8).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { AuthModule } from '../../core/auth/auth.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';

import { FieldDeviceService } from './field-device/field-device.service.js';
import { FieldDeviceController } from './field-device/field-device.controller.js';
import { PinService } from './pin/pin.service.js';
import { PinController } from './pin/pin.controller.js';
import { MyTasksService } from './my-tasks/my-tasks.service.js';
import { MyTasksController } from './my-tasks/my-tasks.controller.js';
import { StockSearchService } from './stock-search/stock-search.service.js';
import { StockSearchController } from './stock-search/stock-search.controller.js';
import { SyncStatusService } from './sync-status/sync-status.service.js';
import { SyncStatusController } from './sync-status/sync-status.controller.js';
import { ShiftPackageService } from './shift-package/shift-package.service.js';
import { ShiftPackageController } from './shift-package/shift-package.controller.js';
import { OfflineSyncService } from './offline-sync/offline-sync.service.js';
import { OfflineSyncController } from './offline-sync/offline-sync.controller.js';
import { RecebimentoModule } from '../recebimento/recebimento.module.js';
import { EstoqueModule } from '../estoque/estoque.module.js';
import { ExpedicaoModule } from '../expedicao/expedicao.module.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, AuthModule, EventsModule, WorkflowModule, RecebimentoModule, EstoqueModule, ExpedicaoModule],
  controllers: [FieldDeviceController, PinController, MyTasksController, StockSearchController, SyncStatusController, ShiftPackageController, OfflineSyncController],
  providers: [FieldDeviceService, PinService, MyTasksService, StockSearchService, SyncStatusService, ShiftPackageService, OfflineSyncService],
  exports: [FieldDeviceService, PinService, MyTasksService, StockSearchService, SyncStatusService, ShiftPackageService, OfflineSyncService],
})
export class CampoModule {}
