// RNF-ARQ-001: Expedição (Dispatch/Shipping) module — DOC-06.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';

// Reinstanciados aqui (stateless, não exportados pelos módulos de origem) —
// mesmo padrão já usado em recebimento.module.ts para StockMovementService e
// em estoque.module.ts para DocumentNumberingService/PutawayEngineService.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { StockMovementService } from '../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../estoque/selection/stock-reservation.service.js';

import { OutboundOrderController } from './order/outbound-order.controller.js';
import { OutboundOrderService } from './order/outbound-order.service.js';
import { OutboundFlowService } from './order/outbound-flow.service.js';
import { OutboundReversalService } from './order/outbound-reversal.service.js';
import { ReservationExpiryService } from './order/reservation-expiry.service.js';
import { WaveController } from './wave/wave.controller.js';
import { WaveService } from './wave/wave.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, OperationFlowModule],
  controllers: [OutboundOrderController, WaveController],
  providers: [
    DocumentNumberingService,
    StockMovementService,
    StockSelectionService,
    StockReservationService,
    OutboundFlowService,
    OutboundOrderService,
    OutboundReversalService,
    ReservationExpiryService,
    WaveService,
  ],
  exports: [OutboundOrderService, OutboundFlowService, OutboundReversalService, ReservationExpiryService, WaveService],
})
export class ExpedicaoModule {}
