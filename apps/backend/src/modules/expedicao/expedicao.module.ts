// RNF-ARQ-001: Expedição (Dispatch/Shipping) module — DOC-06.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';
import { PerifericosModule } from '../perifericos/perifericos.module.js';

// Reinstanciados aqui (stateless, não exportados pelos módulos de origem) —
// mesmo padrão já usado em recebimento.module.ts para StockMovementService e
// em estoque.module.ts para DocumentNumberingService/PutawayEngineService.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../cadastro/lpn/lpn.service.js';
import { StockMovementService } from '../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../estoque/selection/stock-reservation.service.js';
import { InventoryPlanningService } from '../estoque/inventory/inventory-planning.service.js';

import { OutboundOrderController } from './order/outbound-order.controller.js';
import { OutboundOrderService } from './order/outbound-order.service.js';
import { OutboundFlowService } from './order/outbound-flow.service.js';
import { OutboundReversalService } from './order/outbound-reversal.service.js';
import { ReservationExpiryService } from './order/reservation-expiry.service.js';
import { WaveController } from './wave/wave.controller.js';
import { WaveService } from './wave/wave.service.js';
import { PickingTaskController } from './picking/picking-task.controller.js';
import { PickingTaskService } from './picking/picking-task.service.js';
import { PackageController } from './packing/package.controller.js';
import { PackageService } from './packing/package.service.js';
import { DispatchController } from './dispatch/dispatch.controller.js';
import { DispatchService } from './dispatch/dispatch.service.js';
import { LoadingController } from './loading/loading.controller.js';
import { LoadingService } from './loading/loading.service.js';
import { SaidaService } from './loading/saida.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, OperationFlowModule, PerifericosModule],
  controllers: [OutboundOrderController, WaveController, PickingTaskController, PackageController, DispatchController, LoadingController],
  providers: [
    DocumentNumberingService,
    LpnService,
    StockMovementService,
    StockSelectionService,
    StockReservationService,
    InventoryPlanningService,
    OutboundFlowService,
    OutboundOrderService,
    OutboundReversalService,
    ReservationExpiryService,
    PickingTaskService,
    WaveService,
    PackageService,
    DispatchService,
    LoadingService,
    SaidaService,
  ],
  exports: [
    OutboundOrderService,
    OutboundFlowService,
    OutboundReversalService,
    ReservationExpiryService,
    WaveService,
    PickingTaskService,
    PackageService,
    DispatchService,
    LoadingService,
    SaidaService,
  ],
})
export class ExpedicaoModule {}
