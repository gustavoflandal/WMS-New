// RNF-ARQ-001: Recebimento (Receiving) module — DOC-04.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';
import { StorageModule } from '../../core/storage/storage.module.js';

// Reinstanciados aqui (não exportados por CadastroModule) — stateless,
// mesmo padrão já usado em portaria.module.ts (DOC-03) para
// DocumentNumberingService.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../cadastro/lpn/lpn.service.js';
import { PalletService } from '../cadastro/pallet/pallet.service.js';
import { BatchService } from '../cadastro/batch/batch.service.js';

import { DockController } from './dock/dock.controller.js';
import { DockService } from './dock/dock.service.js';
import { InboundOrderController } from './inbound-order/inbound-order.controller.js';
import { InboundOrderService } from './inbound-order/inbound-order.service.js';
import { CheckingController } from './checking/checking.controller.js';
import { CheckingService } from './checking/checking.service.js';
import { LabelingController } from './labeling/labeling.controller.js';
import { LabelingService } from './labeling/labeling.service.js';
import { CrossDockController } from './crossdock/crossdock.controller.js';
import { CrossDockService } from './crossdock/crossdock.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, OperationFlowModule, StorageModule],
  controllers: [DockController, InboundOrderController, CheckingController, LabelingController, CrossDockController],
  providers: [
    DocumentNumberingService,
    LpnService,
    PalletService,
    BatchService,
    DockService,
    InboundOrderService,
    CheckingService,
    LabelingService,
    CrossDockService,
  ],
  exports: [DockService, InboundOrderService, CheckingService, LabelingService, CrossDockService],
})
export class RecebimentoModule {}
