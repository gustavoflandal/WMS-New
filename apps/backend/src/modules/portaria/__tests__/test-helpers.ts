// Helpers compartilhados pelos testes de integração de portaria (DOC-03).
// Segue o mesmo padrão dos testes de cadastro/workflow: instanciação direta
// dos services (new XService(...)), não via HTTP — evita a cascata de
// @Inject/DI sob Vitest já resolvida em cada service (todos já usam
// @Inject explícito), e é o estilo já usado por toda a suíte existente.
import { v4 as uuid } from 'uuid';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';

import { DriverService } from '../driver/driver.service.js';
import { VehicleService } from '../vehicle/vehicle.service.js';
import { VisitorService } from '../visitor/visitor.service.js';
import { PersonVisitService } from '../visitor/person-visit.service.js';
import { AppointmentWindowConfigService } from '../appointment-window-config/appointment-window-config.service.js';
import { AppointmentService } from '../appointment/appointment.service.js';
import { VehicleVisitService } from '../vehicle-visit/vehicle-visit.service.js';
import { GateInService } from '../gate-in/gate-in.service.js';
import { YardQueueService } from '../yard-queue/yard-queue.service.js';
import { DockCallService } from '../dock-call/dock-call.service.js';
import { GateOutService } from '../gate-out/gate-out.service.js';

export interface PortariaServices {
  auditService: AuditService;
  rbacService: RbacService;
  eventsService: EventsService;
  operationalExceptionService: OperationalExceptionService;
  driverService: DriverService;
  vehicleService: VehicleService;
  visitorService: VisitorService;
  personVisitService: PersonVisitService;
  windowConfigService: AppointmentWindowConfigService;
  appointmentService: AppointmentService;
  vehicleVisitService: VehicleVisitService;
  gateInService: GateInService;
  yardQueueService: YardQueueService;
  dockCallService: DockCallService;
  gateOutService: GateOutService;
}

export function setupPortariaServices(db: DatabaseService): PortariaServices {
  const auditService = new AuditService(db);
  const rbacService = new RbacService(db);
  const eventsService = new EventsService();
  const approvalAuthorityService = new ApprovalAuthorityService(db);
  const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
  const documentNumbering = new DocumentNumberingService(db);

  const driverService = new DriverService(db);
  const vehicleService = new VehicleService(db);
  const visitorService = new VisitorService(db);
  const personVisitService = new PersonVisitService(db, auditService);
  const windowConfigService = new AppointmentWindowConfigService(db);
  const appointmentService = new AppointmentService(db, eventsService, auditService, rbacService, documentNumbering);
  const vehicleVisitService = new VehicleVisitService(db);
  const yardQueueService = new YardQueueService(db, auditService, rbacService);
  const gateInService = new GateInService(
    db,
    eventsService,
    auditService,
    operationalExceptionService,
    vehicleService,
    driverService,
    vehicleVisitService,
    yardQueueService
  );
  const dockCallService = new DockCallService(db, eventsService, auditService, vehicleVisitService, yardQueueService);
  const gateOutService = new GateOutService(db, eventsService, auditService, operationalExceptionService, vehicleVisitService);

  return {
    auditService,
    rbacService,
    eventsService,
    operationalExceptionService,
    driverService,
    vehicleService,
    visitorService,
    personVisitService,
    windowConfigService,
    appointmentService,
    vehicleVisitService,
    gateInService,
    yardQueueService,
    dockCallService,
    gateOutService,
  };
}

const CPF_WEIGHTS_1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_WEIGHTS_2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

/** Gera um CPF com dígitos verificadores válidos (mesmo algoritmo de wms.is_valid_cpf), único a cada chamada. */
export function generateValidCpf(): string {
  let base: number[];
  do {
    base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  } while (base.every((d) => d === base[0]));
  const dv1 = checkDigit(base, CPF_WEIGHTS_1);
  const dv2 = checkDigit([...base, dv1], CPF_WEIGHTS_2);
  return [...base, dv1, dv2].join('');
}

/** Placa única no padrão Mercosul (AAA9A99) a cada chamada. */
export function randomMercosulPlate(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const rl = () => letters[Math.floor(Math.random() * letters.length)];
  const rd = () => Math.floor(Math.random() * 10).toString();
  return `${rl()}${rl()}${rl()}${rd()}${rl()}${rd()}${rd()}`;
}

export function randomVisitorDocument(): string {
  return 'DOC' + uuid().replace(/-/g, '').substring(0, 10).toUpperCase();
}
