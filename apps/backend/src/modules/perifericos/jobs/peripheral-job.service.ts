// DOC-11 RNF-PER-002 [INVIOLÁVEL] — protocolo de job do Edge Agent:
// envelope, máquina de estados, idempotência por job_id, retry assimétrico
// (§5.1 [INVIOLÁVEL]: só PRINT_*).
//
// Depende de LabelTemplateService (renderização de ZPL) mas NÃO o
// contrário — LabelTemplateService nunca importa este service, evitando
// ciclo (ver comentário em labels/label-template.service.ts). O controller
// que orquestra "solicitar impressão de teste" injeta os dois.
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EdgeAgentConnectionRegistry } from '../gateway/edge-agent-connection.registry.js';
import { LabelTemplateService } from '../labels/label-template.service.js';

export type PeripheralJobType = 'PRINT_ZPL' | 'PRINT_PDF' | 'WEIGH' | 'GATE_OPEN' | 'LPR_STATUS';
export type PeripheralJobState = 'PENDENTE' | 'ENVIADO' | 'EXECUTANDO' | 'CONCLUIDO' | 'FALHA' | 'EXPIRADO';
export type PeripheralErrorCode = 'DEVICE_OFFLINE' | 'TIMEOUT' | 'PROTOCOL_ERROR' | 'PAPER_OUT' | 'RIBBON_OUT' | 'SERIAL_UNAVAILABLE';

const PRINT_JOB_TYPES: PeripheralJobType[] = ['PRINT_ZPL', 'PRINT_PDF'];

export interface CreateJobInput {
  edgeAgentId: string;
  peripheralDeviceId: string;
  deviceCode: string;
  jobType: PeripheralJobType;
  warehouseId: string;
  tenantId?: string | null;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  actorUserId: string;
  labelTemplateId?: string | null;
  printEntity?: string | null;
  printEntityId?: string | null;
  reprintSeq?: number;
  reason?: string | null;
}

export interface CreatePrintJobInput {
  edgeAgentId: string;
  peripheralDeviceId: string;
  deviceCode: string;
  warehouseId: string;
  tenantId?: string | null;
  templateCode: 'LPN_PALETE' | 'LPN_VOLUME' | 'ENDERECO' | 'LOTE_INTERNO';
  fields: Record<string, string>;
  printEntity: string;
  printEntityId: string;
  actorUserId: string;
  reason?: string | null;
}

export interface AgentResultInput {
  jobId: string;
  status: 'EXECUTANDO' | 'CONCLUIDO' | 'FALHA';
  result?: Record<string, unknown>;
  errorCode?: PeripheralErrorCode;
}

const TERMINAL_STATES: PeripheralJobState[] = ['CONCLUIDO', 'FALHA', 'EXPIRADO'];

@Injectable()
export class PeripheralJobService {
  private readonly logger = new Logger(PeripheralJobService.name);

  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(EdgeAgentConnectionRegistry) private readonly registry: EdgeAgentConnectionRegistry,
    @Inject(LabelTemplateService) private readonly labelTemplateService: LabelTemplateService
  ) {}

  /** RNF-PER-002: cria o job e tenta despachar imediatamente; se offline, PRINT_* fica PENDENTE na fila (RF-PER-021); os demais falham rápido (ver createAndAwaitJob). */
  async createJob(input: CreateJobInput) {
    const timeoutMs = input.timeoutMs ?? 15000;
    const isPrint = PRINT_JOB_TYPES.includes(input.jobType);
    const expiresAt = isPrint
      ? new Date(Date.now() + (await this.getPrintQueueValidityMinutes()) * 60_000)
      : new Date(Date.now() + timeoutMs);

    const result = await this.db.queryGlobal(
      `INSERT INTO wms.peripheral_job (
         edge_agent_id, peripheral_device_id, device_code, job_type, tenant_id, warehouse_id, payload,
         timeout_ms, expires_at, created_by, label_template_id, print_entity, print_entity_id, reprint_seq
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.edgeAgentId,
        input.peripheralDeviceId,
        input.deviceCode,
        input.jobType,
        input.tenantId ?? null,
        input.warehouseId,
        JSON.stringify(input.payload),
        timeoutMs,
        expiresAt,
        input.actorUserId,
        input.labelTemplateId ?? null,
        input.printEntity ?? null,
        input.printEntityId ?? null,
        input.reprintSeq ?? 0,
      ]
    );
    const job = result.rows[0];

    if (input.jobType === 'PRINT_ZPL' || input.jobType === 'PRINT_PDF') {
      await this.auditService.record({
        warehouseId: input.warehouseId,
        userId: input.actorUserId,
        origin: 'EDGE',
        entity: 'peripheral_job',
        entityId: job.job_id,
        action: 'PRINT',
        requirementId: (job.reprint_seq ?? 0) > 0 ? 'DOC-11 RF-PER-021' : 'DOC-11 RNF-PER-002',
        reason: input.reason ?? null,
        after: job,
      });
    }

    await this.tryDispatch(job.job_id);
    return this.findById(job.job_id);
  }

  /** RF-PER-020/021: renderiza o template ATIVO e cria o job PRINT_ZPL — a marca RE1/RE2 é calculada aqui (RF-PER-021). */
  async createLabelPrintJob(input: CreatePrintJobInput) {
    const template = await this.labelTemplateService.getActiveTemplate(input.templateCode);
    const reprintSeq = await this.nextReprintSeq(input.printEntity, input.printEntityId);
    const fields = { ...input.fields, reprint_mark: reprintSeq > 0 ? `RE${reprintSeq}` : '' };
    const zpl = this.labelTemplateService.render(template, fields);

    return this.createJob({
      edgeAgentId: input.edgeAgentId,
      peripheralDeviceId: input.peripheralDeviceId,
      deviceCode: input.deviceCode,
      jobType: 'PRINT_ZPL',
      warehouseId: input.warehouseId,
      tenantId: input.tenantId,
      payload: { zpl, template_code: input.templateCode, template_version: template.version },
      actorUserId: input.actorUserId,
      labelTemplateId: template.id,
      printEntity: input.printEntity,
      printEntityId: input.printEntityId,
      reprintSeq,
      reason: input.reason ?? null,
    });
  }

  /** RN-PER-020: imprime uma cópia de TESTE do template (qualquer status — normalmente DRAFT) para aprovação antes da ativação. */
  async createTestPrintJob(input: {
    templateId: string;
    fields: Record<string, string>;
    edgeAgentId: string;
    peripheralDeviceId: string;
    deviceCode: string;
    warehouseId: string;
    tenantId?: string | null;
    actorUserId: string;
  }) {
    const template = await this.labelTemplateService.getById(input.templateId);
    const zpl = this.labelTemplateService.render(template, { ...input.fields, reprint_mark: '' });

    return this.createJob({
      edgeAgentId: input.edgeAgentId,
      peripheralDeviceId: input.peripheralDeviceId,
      deviceCode: input.deviceCode,
      jobType: 'PRINT_ZPL',
      warehouseId: input.warehouseId,
      tenantId: input.tenantId,
      payload: { zpl, template_code: template.code, template_version: template.version, is_test_print: true },
      actorUserId: input.actorUserId,
      labelTemplateId: template.id,
      printEntity: 'label_template_test',
      printEntityId: template.id,
    });
  }

  /** RF-PER-021: quantas vezes esta entidade já foi impressa com sucesso (0 = ainda não impressa; N = próxima é a Nª reimpressão). */
  async nextReprintSeq(printEntity: string, printEntityId: string): Promise<number> {
    const result = await this.db.queryGlobal<{ count: string }>(
      `SELECT COUNT(*) AS count FROM wms.peripheral_job
       WHERE print_entity = $1 AND print_entity_id = $2 AND job_type = 'PRINT_ZPL' AND state = 'CONCLUIDO'`,
      [printEntity, printEntityId]
    );
    return Number(result.rows[0].count);
  }

  /**
   * RNF-PER-002/§5.1: cria o job e aguarda SINCRONAMENTE um estado terminal
   * (uso: WEIGH/GATE_OPEN a partir de um handler HTTP, onde o operador está
   * parado esperando). Agent offline no momento da criação falha IMEDIATO
   * com DEVICE_OFFLINE — WEIGH/GATE_OPEN não entram na fila de 30 min de
   * RF-PER-021 (essa fila é só para PRINT_*, ver §5.1: "pesagem e cancela
   * são re-solicitadas pelo operador").
   */
  async createAndAwaitJob(input: Omit<CreateJobInput, 'jobType'> & { jobType: 'WEIGH' | 'GATE_OPEN' | 'LPR_STATUS' }, maxWaitMs?: number) {
    if (!this.registry.isOnline(input.edgeAgentId)) {
      const timeoutMs = input.timeoutMs ?? 15000;
      const job = await this.db.queryGlobal(
        `INSERT INTO wms.peripheral_job (
           edge_agent_id, peripheral_device_id, device_code, job_type, tenant_id, warehouse_id, payload,
           timeout_ms, state, error_code, expires_at, completed_at, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'FALHA','DEVICE_OFFLINE', now(), now(), $9) RETURNING *`,
        [input.edgeAgentId, input.peripheralDeviceId, input.deviceCode, input.jobType, input.tenantId ?? null, input.warehouseId, JSON.stringify(input.payload), timeoutMs, input.actorUserId]
      );
      return job.rows[0];
    }

    const created = await this.createJob(input);
    if (TERMINAL_STATES.includes(created.state)) return created; // resposta já chegou antes mesmo de começar a esperar

    const timeoutMs = input.timeoutMs ?? 15000;
    const waitMs = maxWaitMs ?? timeoutMs + 2000;
    const deadline = Date.now() + waitMs;
    const pollIntervalMs = 50;

    // Poll simples em vez de um mecanismo de "waiter" por evento: mais
    // simples, sem corrida entre "resposta chega antes do waiter existir" e
    // "resposta chega depois" — applyAgentResult() sempre persiste no banco
    // primeiro, então reler o estado é sempre a fonte da verdade, venha a
    // resposta rápido (agent local) ou não (rede real).
    let current = created;
    while (!TERMINAL_STATES.includes(current.state) && Date.now() < deadline) {
      await this.sleep(pollIntervalMs);
      current = await this.findById(created.job_id);
    }
    return current;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** RNF-PER-002: envia o envelope se o agent estiver conectado; senão, deixa PENDENTE (fila). */
  async tryDispatch(jobId: string): Promise<boolean> {
    const job = await this.findById(jobId);
    if (job.state !== 'PENDENTE') return false;

    const envelope = {
      job_id: job.job_id,
      job_type: job.job_type,
      device_code: job.device_code,
      timeout_ms: job.timeout_ms,
      payload: job.payload,
      issued_at: new Date().toISOString(),
    };

    const sent = this.registry.send(job.edge_agent_id, 'job', envelope);
    if (!sent) return false;

    await this.db.queryGlobal(`UPDATE wms.peripheral_job SET state = 'ENVIADO', issued_at = now() WHERE job_id = $1`, [job.job_id]);
    return true;
  }

  /** RF-PER-021: "ao reconectar o agent devem ser executados na ordem" — dispara PENDENTE em ordem de criação. */
  async dispatchPendingForAgent(edgeAgentId: string): Promise<void> {
    const result = await this.db.queryGlobal<{ job_id: string }>(
      `SELECT job_id FROM wms.peripheral_job WHERE edge_agent_id = $1 AND state = 'PENDENTE' ORDER BY created_at ASC`,
      [edgeAgentId]
    );
    for (const row of result.rows) {
      await this.tryDispatch(row.job_id);
    }
  }

  /** RNF-PER-002/§5.1: aplica a resposta do agent — retry assimétrico só para PRINT_*, nunca WEIGH/GATE_OPEN. */
  async applyAgentResult(input: AgentResultInput): Promise<void> {
    const job = await this.findById(input.jobId).catch(() => null);
    if (!job) {
      this.logger.warn(`applyAgentResult: job ${input.jobId} not found (idempotência de reenvio: agent respondendo a job desconhecido)`);
      return;
    }

    if (input.status === 'EXECUTANDO') {
      if (job.state === 'ENVIADO') {
        await this.db.queryGlobal(`UPDATE wms.peripheral_job SET state = 'EXECUTANDO' WHERE job_id = $1`, [input.jobId]);
      }
      return;
    }

    if (input.status === 'CONCLUIDO') {
      await this.db.transactionAsWorker(async (client) => {
        await client.query(`UPDATE wms.peripheral_job SET state = 'CONCLUIDO', result = $2, completed_at = now() WHERE job_id = $1`, [
          input.jobId,
          JSON.stringify(input.result ?? {}),
        ]);
        await this.eventsService.publishInTransaction(client, {
          event_type: 'perifericos.job_concluido',
          tenant_id: job.tenant_id,
          warehouse_id: job.warehouse_id,
          actor_user_id: job.created_by,
          payload: { job_id: job.job_id, job_type: job.job_type, device_code: job.device_code },
        });
      });
      return;
    }

    // FALHA — §5.1 [INVIOLÁVEL]: retry automático (máx. 3) SOMENTE para PRINT_*.
    const isPrint = PRINT_JOB_TYPES.includes(job.job_type);
    const canRetry = isPrint && job.retry_count < job.max_retries;

    if (canRetry) {
      await this.db.queryGlobal(
        `UPDATE wms.peripheral_job SET state = 'PENDENTE', retry_count = retry_count + 1, error_code = $2, issued_at = NULL WHERE job_id = $1`,
        [input.jobId, input.errorCode ?? 'PROTOCOL_ERROR']
      );
      await this.tryDispatch(input.jobId); // mesmo job_id — reenvio idempotente (RG-009/RNF-PER-002)
      return;
    }

    await this.db.transactionAsWorker(async (client) => {
      await client.query(`UPDATE wms.peripheral_job SET state = 'FALHA', error_code = $2, completed_at = now() WHERE job_id = $1`, [
        input.jobId,
        input.errorCode ?? 'PROTOCOL_ERROR',
      ]);
      await this.eventsService.publishInTransaction(client, {
        event_type: 'perifericos.job_falha',
        tenant_id: job.tenant_id,
        warehouse_id: job.warehouse_id,
        actor_user_id: job.created_by,
        payload: { job_id: job.job_id, job_type: job.job_type, device_code: job.device_code, error_code: input.errorCode ?? 'PROTOCOL_ERROR', retries_exhausted: isPrint },
      });
    });
  }

  /** Watchdog (worker, poll de 5s): jobs ENVIADO/EXECUTANDO cujo timeout_ms já passou viram FALHA/TIMEOUT (mesma porta de retry assimétrico). */
  async sweepTimedOutJobs(): Promise<number> {
    const result = await this.db.queryGlobal<{ job_id: string }>(
      `SELECT job_id FROM wms.peripheral_job
       WHERE state IN ('ENVIADO', 'EXECUTANDO') AND issued_at IS NOT NULL
         AND issued_at + (timeout_ms::text || ' milliseconds')::interval < now()`
    );
    for (const row of result.rows) {
      await this.applyAgentResult({ jobId: row.job_id, status: 'FALHA', errorCode: 'TIMEOUT' });
    }
    return result.rows.length;
  }

  /** RF-PER-021: jobs PENDENTE além da validade da fila (30 min) expiram com alerta. */
  async sweepExpiredJobs(): Promise<number> {
    const result = await this.db.queryGlobal<{ job_id: string; tenant_id: string | null; warehouse_id: string; job_type: string; device_code: string; created_by: string }>(
      `SELECT job_id, tenant_id, warehouse_id, job_type, device_code, created_by FROM wms.peripheral_job
       WHERE state = 'PENDENTE' AND expires_at < now()`
    );
    for (const job of result.rows) {
      await this.db.transactionAsWorker(async (client) => {
        await client.query(`UPDATE wms.peripheral_job SET state = 'EXPIRADO', completed_at = now() WHERE job_id = $1`, [job.job_id]);
        // §4.8: catálogo fechado não tem evento dedicado a EXPIRADO — reaproveita
        // perifericos.job_falha (mesma necessidade de alerta do RF-PER-021 Gherkin).
        await this.eventsService.publishInTransaction(client, {
          event_type: 'perifericos.job_falha',
          tenant_id: job.tenant_id,
          warehouse_id: job.warehouse_id,
          actor_user_id: job.created_by,
          payload: { job_id: job.job_id, job_type: job.job_type, device_code: job.device_code, error_code: 'EXPIRADO' },
        });
      });
    }
    return result.rows.length;
  }

  async findById(jobId: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.peripheral_job WHERE job_id = $1`, [jobId]);
    const job = result.rows[0];
    if (!job) throw new NotFoundException(`peripheral_job ${jobId} not found`);
    return job;
  }

  private async getPrintQueueValidityMinutes(): Promise<number> {
    const result = await this.db.queryGlobal(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'PER.PRINT_FILA_VALIDADE_MIN'`);
    return Number(result.rows[0]?.value ?? 30);
  }
}
