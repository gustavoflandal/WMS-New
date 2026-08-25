// RNF-ARQ-001: Fiscal module (DOC-08) — Sessão 8A: ciclo do Estoque Fiscal
// (RG-014). Sessão 8B: motor de emissão NF-e real (DOC-08 §4.7).
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { StorageModule } from '../../core/storage/storage.module.js';
import { SecurityModule } from '../../core/security/security.module.js';

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

import { SEFAZ_CLIENT_PORT } from './emission/sefaz-client.port.js';
import { SefazSimulatorAdapter } from './emission/sefaz-simulator.adapter.js';
import { SefazSoapClientAdapter } from './emission/sefaz-soap-client.adapter.js';
import { FiscalIssuerService } from './emission/fiscal-issuer.service.js';
import { FiscalIssuerController } from './emission/fiscal-issuer.controller.js';
import { DanfeService } from './emission/danfe.service.js';
import { FiscalEmissionService } from './emission/fiscal-emission.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, StorageModule, SecurityModule],
  controllers: [FiscalModeController, StorageInvoiceController, StorageReturnInvoiceController, FiscalIssuerController],
  providers: [
    DocumentNumberingService,
    AlertService,
    FiscalModeService,
    StorageInvoiceService,
    FiscalConsumptionService,
    StorageReturnInvoiceService,
    WriteOffPendingService,
    InboundInvoiceFiscalService,
    SefazSimulatorAdapter,
    SefazSoapClientAdapter,
    {
      // §2.4 do prompt da 8B: `FIS.AMBIENTE` decide o adaptador por
      // EMITENTE em produção real; neste ambiente (sem acesso à SEFAZ) o
      // simulador é o padrão global, controlável por env var só para os
      // raros testes/uso manual do adaptador real isolado.
      provide: SEFAZ_CLIENT_PORT,
      useFactory: (simulator: SefazSimulatorAdapter, real: SefazSoapClientAdapter, configService: ConfigService) =>
        configService.get('FISCAL_SEFAZ_SIMULATOR', 'true') === 'false' ? real : simulator,
      inject: [SefazSimulatorAdapter, SefazSoapClientAdapter, ConfigService],
    },
    FiscalIssuerService,
    DanfeService,
    FiscalEmissionService,
  ],
  exports: [
    FiscalModeService,
    StorageInvoiceService,
    FiscalConsumptionService,
    StorageReturnInvoiceService,
    WriteOffPendingService,
    InboundInvoiceFiscalService,
    SefazSimulatorAdapter,
    FiscalIssuerService,
    DanfeService,
    FiscalEmissionService,
  ],
})
export class FiscalModule {}
