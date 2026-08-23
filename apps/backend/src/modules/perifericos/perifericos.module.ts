// DOC-11 — Etiquetas e Periféricos (WMS Edge Agent). RNF-ARQ-001.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';

import { EdgeAgentAdminService } from './devices/edge-agent-admin.service.js';
import { PeripheralDeviceService } from './devices/peripheral-device.service.js';
import { PeripheralDeviceController } from './devices/peripheral-device.controller.js';
import { LabelTemplateService } from './labels/label-template.service.js';
import { LabelTemplateController } from './labels/label-template.controller.js';
import { LprService } from './lpr/lpr.service.js';
import { EdgeAgentConnectionRegistry } from './gateway/edge-agent-connection.registry.js';
import { EdgeAgentGateway } from './gateway/edge-agent.gateway.js';
import { PeripheralJobService } from './jobs/peripheral-job.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule],
  controllers: [PeripheralDeviceController, LabelTemplateController],
  providers: [
    EdgeAgentAdminService,
    PeripheralDeviceService,
    LabelTemplateService,
    LprService,
    EdgeAgentConnectionRegistry,
    PeripheralJobService,
    EdgeAgentGateway,
  ],
  exports: [EdgeAgentAdminService, PeripheralDeviceService, LabelTemplateService, LprService, PeripheralJobService, EdgeAgentConnectionRegistry],
})
export class PerifericosModule {}
