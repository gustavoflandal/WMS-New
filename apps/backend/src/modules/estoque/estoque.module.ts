// RNF-ARQ-001: Estoque (Stock) module — DOC-05.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { StockMovementService } from './movement/stock-movement.service.js';
import { StockBlockController } from './blocking/stock-block.controller.js';
import { StockBlockService } from './blocking/stock-block.service.js';
import { StockReclassificationController } from './blocking/stock-reclassification.controller.js';
import { StockReclassificationService } from './blocking/stock-reclassification.service.js';
import { ExpirationService } from './expiration/expiration.service.js';
import { ReplenishmentTaskController } from './replenishment/replenishment-task.controller.js';
import { ReplenishmentTaskService } from './replenishment/replenishment-task.service.js';
import { SafetyStockService } from './replenishment/safety-stock.service.js';
import { KanbanService } from './replenishment/kanban.service.js';
import { StockTransferController } from './transfer/stock-transfer.controller.js';
import { StockTransferService } from './transfer/stock-transfer.service.js';
// Reinstanciados aqui (não exportados por CadastroModule/RecebimentoModule)
// — stateless (só dependem de DatabaseService), mesmo padrão já usado em
// recebimento.module.ts para StockMovementService (na direção oposta).
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { PutawayEngineService } from '../recebimento/putaway/putaway-engine.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule],
  controllers: [StockBlockController, StockReclassificationController, ReplenishmentTaskController, StockTransferController],
  providers: [
    StockMovementService,
    StockBlockService,
    StockReclassificationService,
    ExpirationService,
    ReplenishmentTaskService,
    SafetyStockService,
    KanbanService,
    DocumentNumberingService,
    PutawayEngineService,
    StockTransferService,
  ],
  exports: [StockMovementService, StockBlockService, StockReclassificationService, ExpirationService, ReplenishmentTaskService, SafetyStockService, KanbanService, StockTransferService],
})
export class EstoqueModule {}
