// DOC-10 — módulo Painéis, Dashboards e Tempo Real.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { OperationsBoardService } from './operacoes/operations-board.service.js';
import { OperationsBoardController } from './operacoes/operations-board.controller.js';
import { BoardPreferenceService } from './operacoes/board-preference.service.js';
import { KpiComputationService } from './kpi/kpi-computation.service.js';
import { KpiMaterializationService } from './kpi/kpi-materialization.service.js';
import { KpiSnapshotService } from './kpi/kpi-snapshot.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { AlertService } from './alertas/alert.service.js';
import { AlertMaterializationService } from './alertas/alert-materialization.service.js';
import { AlertController } from './alertas/alert.controller.js';
import { ChatService } from './chat/chat.service.js';
import { ChatController } from './chat/chat.controller.js';

@Module({
  imports: [DatabaseModule, RbacModule, EventsModule, AuditModule],
  controllers: [OperationsBoardController, DashboardController, AlertController, ChatController],
  providers: [
    OperationsBoardService,
    BoardPreferenceService,
    KpiComputationService,
    KpiMaterializationService,
    KpiSnapshotService,
    DashboardService,
    AlertService,
    AlertMaterializationService,
    ChatService,
  ],
  exports: [OperationsBoardService, KpiComputationService, KpiMaterializationService, KpiSnapshotService, DashboardService, AlertService, AlertMaterializationService, ChatService],
})
export class PaineisModule {}
