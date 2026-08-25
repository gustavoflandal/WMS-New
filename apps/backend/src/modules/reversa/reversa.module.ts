// RNF-ARQ-001: Logística Reversa module — DOC-07 (Sessão 9A: núcleo).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';
import { FiscalModule } from '../fiscal/fiscal.module.js';

// Reinstanciados aqui (stateless, não exportados pelos módulos de origem) —
// mesmo padrão já usado em expedicao.module.ts/estoque.module.ts/fiscal.module.ts.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { BatchService } from '../cadastro/batch/batch.service.js';
import { StockMovementService } from '../estoque/movement/stock-movement.service.js';

import { ReturnOrderController } from './return-order/return-order.controller.js';
import { ReturnOrderService } from './return-order/return-order.service.js';
import { ReturnTriageService } from './triage/return-triage.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, OperationFlowModule, FiscalModule],
  controllers: [ReturnOrderController],
  providers: [DocumentNumberingService, BatchService, StockMovementService, ReturnOrderService, ReturnTriageService],
  exports: [ReturnOrderService, ReturnTriageService],
})
export class ReversaModule {}
