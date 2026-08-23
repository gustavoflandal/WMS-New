// RNF-ARQ-001: Portaria (Gate-in/Gate-out) module — DOC-03.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { EventsModule } from '../../core/events/events.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { PerifericosModule } from '../perifericos/perifericos.module.js';

import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';

import { DriverController } from './driver/driver.controller.js';
import { DriverService } from './driver/driver.service.js';
import { VehicleController } from './vehicle/vehicle.controller.js';
import { VehicleService } from './vehicle/vehicle.service.js';
import { VisitorController } from './visitor/visitor.controller.js';
import { VisitorService } from './visitor/visitor.service.js';
import { PersonVisitService } from './visitor/person-visit.service.js';
import { AppointmentWindowConfigController } from './appointment-window-config/appointment-window-config.controller.js';
import { AppointmentWindowConfigService } from './appointment-window-config/appointment-window-config.service.js';
import { AppointmentController } from './appointment/appointment.controller.js';
import { AppointmentService } from './appointment/appointment.service.js';
import { VehicleVisitService } from './vehicle-visit/vehicle-visit.service.js';
import { GateInController } from './gate-in/gate-in.controller.js';
import { GateInService } from './gate-in/gate-in.service.js';
import { YardQueueController } from './yard-queue/yard-queue.controller.js';
import { YardQueueService } from './yard-queue/yard-queue.service.js';
import { DockCallController } from './dock-call/dock-call.controller.js';
import { DockCallService } from './dock-call/dock-call.service.js';
import { GateOutController } from './gate-out/gate-out.controller.js';
import { GateOutService } from './gate-out/gate-out.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, PerifericosModule],
  controllers: [
    DriverController,
    VehicleController,
    VisitorController,
    AppointmentWindowConfigController,
    AppointmentController,
    GateInController,
    YardQueueController,
    DockCallController,
    GateOutController,
  ],
  providers: [
    // DocumentNumberingService: reinstanciado aqui (não exportado por
    // CadastroModule) — stateless, depende só de DatabaseService.
    DocumentNumberingService,
    DriverService,
    VehicleService,
    VisitorService,
    PersonVisitService,
    AppointmentWindowConfigService,
    AppointmentService,
    VehicleVisitService,
    GateInService,
    YardQueueService,
    DockCallService,
    GateOutService,
  ],
  exports: [AppointmentService, VehicleVisitService, GateInService, GateOutService, YardQueueService, DockCallService],
})
export class PortariaModule {}
