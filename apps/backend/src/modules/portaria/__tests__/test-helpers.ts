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
import { EdgeAgentConnectionRegistry } from '../../perifericos/gateway/edge-agent-connection.registry.js';
import { LabelTemplateService } from '../../perifericos/labels/label-template.service.js';
import { PeripheralJobService } from '../../perifericos/jobs/peripheral-job.service.js';
import { PeripheralDeviceService } from '../../perifericos/devices/peripheral-device.service.js';
import { LprService } from '../../perifericos/lpr/lpr.service.js';

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
  peripheralDeviceService: PeripheralDeviceService;
  peripheralJobService: PeripheralJobService;
  lprService: LprService;
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
  const personVisitService = new PersonVisitService(db, auditService, eventsService);
  const windowConfigService = new AppointmentWindowConfigService(db);
  const appointmentService = new AppointmentService(db, eventsService, auditService, rbacService, documentNumbering);
  const vehicleVisitService = new VehicleVisitService(db);
  const yardQueueService = new YardQueueService(db, auditService, rbacService);

  // DOC-11 (Sessão 8): cadeia de periféricos, instanciada da mesma forma
  // direta usada por todo este helper — gate-in/gate-out passaram a
  // depender dela para RF-POR-010/014.
  const edgeAgentConnectionRegistry = new EdgeAgentConnectionRegistry();
  const labelTemplateService = new LabelTemplateService(db, auditService);
  const peripheralJobService = new PeripheralJobService(db, eventsService, auditService, edgeAgentConnectionRegistry, labelTemplateService);
  const peripheralDeviceService = new PeripheralDeviceService(db, auditService);
  const lprService = new LprService(db, eventsService);

  const gateInService = new GateInService(
    db,
    eventsService,
    auditService,
    operationalExceptionService,
    vehicleService,
    driverService,
    vehicleVisitService,
    yardQueueService,
    peripheralDeviceService,
    peripheralJobService,
    lprService
  );
  const dockCallService = new DockCallService(db, eventsService, auditService, vehicleVisitService, yardQueueService);
  const gateOutService = new GateOutService(db, eventsService, auditService, operationalExceptionService, vehicleVisitService, peripheralDeviceService, peripheralJobService);

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
    peripheralDeviceService,
    peripheralJobService,
    lprService,
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

/**
 * [[wms-midnight-flaky-window-config-test]] — appointment_window_config só
 * guarda TIME (start_time/end_time, colunas TIME, constraint end_time >
 * start_time) + uma window_date separada. Muitos testes deste módulo (e de
 * recebimento/inbound-order) reinventavam "uma janela em torno de agora"
 * localmente com `new Date(now + offset)` formatado só como hora-do-dia
 * (`toTimeString().slice(0,8)`) — perto da meia-noite local, os dois
 * extremos caem em datas de calendário DIFERENTES mas eram gravados como se
 * fossem do mesmo dia, violando a constraint. Fix: clampa cada extremidade
 * à borda do dia de `reference` em vez de deixá-la vazar para o dia
 * anterior/seguinte. Único helper compartilhado — substitui as N cópias
 * quase-idênticas que existiam por arquivo de teste.
 */
export function buildTimeWindow(
  startOffsetMinutes: number,
  endOffsetMinutes: number,
  reference: Date = new Date()
): { weekday: number; start_time: string; end_time: string; window_date: string } {
  const dayStart = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), 0, 0, 0);
  const dayEnd = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), 23, 59, 59);
  const startCandidate = new Date(reference.getTime() + startOffsetMinutes * 60000);
  const endCandidate = new Date(reference.getTime() + endOffsetMinutes * 60000);
  const start = startCandidate < dayStart ? dayStart : startCandidate;
  const end = endCandidate > dayEnd ? dayEnd : endCandidate;
  const fmtTime = (d: Date) => d.toTimeString().slice(0, 8);
  const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { weekday: reference.getDay(), start_time: fmtTime(start), end_time: fmtTime(end), window_date: fmtDate(reference) };
}
