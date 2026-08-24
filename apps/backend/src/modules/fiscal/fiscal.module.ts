// RNF-ARQ-001: Fiscal module (DOC-08) — Sessão 8A: ciclo do Estoque Fiscal
// (RG-014). O motor de emissão NF-e real (DOC-08 §4.7) é da Sessão 8B.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';

// Reinstanciados aqui (stateless, não exportados pelos módulos de origem) —
// mesmo padrão já usado em estoque.module.ts/expedicao.module.ts.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';
import { AlertService } from '../paineis/alertas/alert.service.js';

import { FiscalModeService } from './fiscal-mode/fiscal-mode.service.js';
import { FiscalModeController } from './fiscal-mode/fiscal-mode.controller.js';
import { StorageInvoiceService } from './storage-invoice/storage-invoice.service.js';
import { StorageInvoiceController } from './storage-invoice/storage-invoice.controller.js';
import { FiscalConsumptionService } from './consumption/fiscal-consumption.service.js';
import { StorageReturnInvoiceService } from './storage-return-invoice/storage-return-invoice.service.js';
import { StorageReturnInvoiceController } from './storage-return-invoice/storage-return-invoice.controller.js';
import { WriteOffPendingService } from './write-off/write-off-pending.service.js';
import { InboundInvoiceFiscalService } from './inbound-invoice/inbound-invoice-fiscal.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule],
  controllers: [FiscalModeController, StorageInvoiceController, StorageReturnInvoiceController],
  providers: [
    DocumentNumberingService,
    AlertService,
    FiscalModeService,
    StorageInvoiceService,
    FiscalConsumptionService,
    StorageReturnInvoiceService,
    WriteOffPendingService,
    InboundInvoiceFiscalService,
  ],
  exports: [
    FiscalModeService,
    StorageInvoiceService,
    FiscalConsumptionService,
    StorageReturnInvoiceService,
    WriteOffPendingService,
    InboundInvoiceFiscalService,
  ],
})
export class FiscalModule {}
