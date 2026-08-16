// DOC-12 §4.5/§5.1 — Motor de Workflow de Aprovação. Máquina de estados
// PENDING/ESCALATED/APPROVED/REJECTED/EXPIRED. RN-SEG-042 (efeito
// suspensivo), RN-SEG-043 (segregação de funções), RF-SEG-044 (notificação
// via tópico "alertas", reaproveitando o pipeline outbox->fanout já
// implementado — não chama o gateway diretamente).
import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { EventsService } from '../events/events.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApprovalAuthorityService } from './approval-authority.service.js';

export interface CreateExceptionInput {
  tenantId: string;
  exceptionType: string;
  warehouseId: string;
  entity: string;
  entityId: string;
  qty?: number;
  valueBrl?: number;
  reasonRequest?: string;
  requestedBy: string;
}

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

@Injectable()
export class OperationalExceptionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvalAuthorityService: ApprovalAuthorityService,
    private readonly eventsService: EventsService,
    private readonly auditService: AuditService
  ) {}

  async create(input: CreateExceptionInput) {
    const typeResult = await this.db.queryGlobal('SELECT * FROM wms.exception_type WHERE code = $1', [input.exceptionType]);
    const type = typeResult.rows[0];
    if (!type) throw new NotFoundException(`exception_type ${input.exceptionType} not found`);
    if (type.requires_reason && !input.reasonRequest) {
      throw new BadRequestException({ error: 'REASON_REQUIRED', detail: `RD-SEG-040: reason_request é obrigatório para ${input.exceptionType}` });
    }

    // RN-SEG-021: escala se exceder TODAS as alçadas configuradas no armazém.
    const escalate = await this.approvalAuthorityService.exceedsAllConfiguredAuthorities(
      input.exceptionType,
      input.warehouseId,
      input.qty ?? null,
      input.valueBrl ?? null
    );
    const status = escalate ? 'ESCALATED' : 'PENDING';

    const exception = await this.db.transaction(
      { tenant_id: input.tenantId, user_id: input.requestedBy, warehouse_id: input.warehouseId },
      async (client) => {
        const result = await client.query(
          `INSERT INTO wms.operational_exception (
            tenant_id, exception_type, warehouse_id, entity, entity_id, qty, value_brl,
            reason_request, status, requested_by, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
          [
            input.tenantId,
            input.exceptionType,
            input.warehouseId,
            input.entity,
            input.entityId,
            input.qty ?? null,
            input.valueBrl ?? null,
            input.reasonRequest ?? null,
            status,
            input.requestedBy,
          ]
        );
        const row = result.rows[0];

        // RF-SEG-044: notifica no tópico "alertas" via pipeline outbox -> fanout já existente.
        await this.eventsService.publishInTransaction(client, {
          event_type: escalate ? 'seguranca.excecao_escalada' : 'seguranca.excecao_criada',
          tenant_id: input.tenantId,
          warehouse_id: input.warehouseId,
          actor_user_id: input.requestedBy,
          payload: { exception_id: row.id, exception_type: input.exceptionType, status, qty: input.qty ?? null, value_brl: input.valueBrl ?? null },
        });

        return row;
      }
    );

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.requestedBy,
      origin: 'API',
      entity: 'operational_exception',
      entityId: exception.id,
      action: 'CREATE',
      after: exception,
      reason: input.reasonRequest ?? null,
    });

    return exception;
  }

  /**
   * RN-SEG-021 (alçada) + RN-SEG-042 (efeito suspensivo/máquina de
   * estados) + RN-SEG-043 (segregação de funções — solicitante não decide
   * a própria exceção; passos distintos exigem aprovadores distintos).
   */
  async decide(exceptionId: string, tenantId: string, warehouseId: string, decidedBy: string, decision: 'APPROVE' | 'REJECT', reason: string) {
    const updated = await this.db.transaction({ tenant_id: tenantId, user_id: decidedBy, warehouse_id: warehouseId }, async (client) => {
      const excResult = await client.query('SELECT * FROM wms.operational_exception WHERE id = $1 FOR UPDATE', [exceptionId]);
      const exception = excResult.rows[0];
      if (!exception) throw new NotFoundException(`operational_exception ${exceptionId} not found`);
      if (!['PENDING', 'ESCALATED'].includes(exception.status)) {
        throw new ConflictException({ error: 'EXCEPTION_ALREADY_DECIDED', detail: `status atual: ${exception.status}` });
      }

      // RN-SEG-043: solicitante não aprova a própria exceção.
      if (exception.requested_by === decidedBy) {
        throw new ForbiddenException({ error: 'SELF_APPROVAL_DENIED', detail: 'RN-SEG-043: solicitante não pode decidir a própria exceção' });
      }

      // RN-SEG-043: fluxo de 2 passos exige aprovadores distintos ENTRE SI (não repete a mesma pessoa em dois passos).
      const previousDecisions = await client.query('SELECT decided_by FROM wms.operational_exception_decision WHERE operational_exception_id = $1', [
        exceptionId,
      ]);
      if (previousDecisions.rows.some((d: { decided_by: string }) => d.decided_by === decidedBy)) {
        throw new ForbiddenException({ error: 'DUPLICATE_APPROVER', detail: 'RN-SEG-043: este aprovador já decidiu um passo anterior desta exceção' });
      }

      // RN-SEG-021: valida alçada. Exceção ESCALATED exige GESTOR_ARMAZEM no armazém.
      if (exception.status === 'ESCALATED') {
        const managerCheck = await client.query(
          `SELECT 1 FROM wms.user_role_assignment ura
           JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE' AND r.code = 'GESTOR_ARMAZEM'
           WHERE ura.user_id = $1 AND ura.warehouse_id = $2`,
          [decidedBy, exception.warehouse_id]
        );
        if (managerCheck.rows.length === 0) {
          throw new ForbiddenException({ error: 'ESCALATION_REQUIRES_MANAGER', detail: 'RN-SEG-021: exceção escalada exige decisão de GESTOR_ARMAZEM' });
        }
      } else {
        const authority = await this.approvalAuthorityService.getUserAuthority(decidedBy, exception.exception_type, exception.warehouse_id);
        if (!authority || !this.approvalAuthorityService.authorityCovers(authority, exception.qty, exception.value_brl)) {
          throw new ForbiddenException({ error: 'INSUFFICIENT_AUTHORITY', detail: 'RN-SEG-021: alçada insuficiente para esta exceção' });
        }
      }

      const typeResult = await client.query('SELECT default_steps FROM wms.exception_type WHERE code = $1', [exception.exception_type]);
      const defaultSteps: number = typeResult.rows[0].default_steps;
      const step: number = exception.current_step;

      await client.query(
        `INSERT INTO wms.operational_exception_decision (tenant_id, operational_exception_id, step, decision, decided_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, exceptionId, step, decision, decidedBy, reason]
      );

      let finalStatus: string = exception.status;
      let nextStep = step;
      let isFinal = false;

      if (decision === 'REJECT') {
        finalStatus = 'REJECTED';
        isFinal = true;
      } else if (step < defaultSteps) {
        // RN-SEG-043: passo aprovado, mas ainda faltam passos — permanece
        // pendente/escalado, aguardando o PRÓXIMO aprovador (distinto).
        nextStep = step + 1;
      } else {
        finalStatus = 'APPROVED';
        isFinal = true;
      }

      const updateResult = await client.query(
        `UPDATE wms.operational_exception SET
           status = $2, current_step = $3,
           decided_by = CASE WHEN $4 THEN $5::uuid ELSE decided_by END,
           decided_at = CASE WHEN $4 THEN now() ELSE decided_at END,
           reason_decision = CASE WHEN $4 THEN $6 ELSE reason_decision END,
           updated_at = now(), updated_by = $5
         WHERE id = $1 RETURNING *`,
        [exceptionId, finalStatus, nextStep, isFinal, decidedBy, reason]
      );
      const row = updateResult.rows[0];

      if (isFinal) {
        await this.eventsService.publishInTransaction(client, {
          event_type: finalStatus === 'APPROVED' ? 'seguranca.excecao_aprovada' : 'seguranca.excecao_rejeitada',
          tenant_id: tenantId,
          warehouse_id: exception.warehouse_id,
          actor_user_id: decidedBy,
          payload: { exception_id: exceptionId, status: finalStatus },
        });
      }

      return row;
    });

    await this.auditService.record({
      tenantId,
      warehouseId: updated.warehouse_id,
      userId: decidedBy,
      origin: 'API',
      entity: 'operational_exception',
      entityId: exceptionId,
      action: decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
      reason,
      after: updated,
    });

    return updated;
  }

  /**
   * RN-SEG-042 [INVIOLÁVEL]: efeito suspensivo — a operação de origem
   * permanece bloqueada enquanto existir exceção PENDING/ESCALATED para
   * essa entidade. [DEBITO: integração real com o bloqueio do Fluxo
   * Operacional (RG-002, Painel de Operações) depende do motor de
   * Fluxo Operacional do DOC-06, inexistente nesta sessão — este método é
   * o ponto de extensão que os módulos futuros devem chamar antes de
   * avançar qualquer etapa.]
   */
  async isBlocking(tenantId: string, entity: string, entityId: string): Promise<boolean> {
    const result = await this.db.query({ tenant_id: tenantId, user_id: SYSTEM_ACTOR }, `SELECT 1 FROM wms.operational_exception WHERE entity = $1 AND entity_id = $2 AND status IN ('PENDING', 'ESCALATED')`, [
      entity,
      entityId,
    ]);
    return result.rows.length > 0;
  }

  /**
   * Scheduler: expira exceções vencidas (auto_expire_hours). Roda
   * cross-tenant via transactionAsWorker (ADR-006, BYPASSRLS) — mesmo
   * padrão do outbox-publisher, apropriado aqui pois é um job de
   * manutenção em background, não uma requisição de um usuário.
   */
  async expireOverdue(): Promise<{ expiredIds: string[] }> {
    const expired: Array<{ id: string; tenant_id: string; warehouse_id: string; requested_by: string }> = [];

    await this.db.transactionAsWorker(async (client) => {
      // FOR UPDATE OF oe (não FOR UPDATE puro): sem o OF, o lock se
      // aplicaria a TODAS as tabelas do JOIN, exigindo privilégio de
      // UPDATE também em wms.exception_type (catálogo de leitura, só
      // SELECT concedido a wms_worker — migration 0018) — wms_worker
      // recebeu "permission denied for table exception_type" até este
      // ajuste. Só operational_exception precisa ser travada.
      const candidates = await client.query(
        `SELECT oe.id, oe.tenant_id, oe.warehouse_id, oe.requested_by
         FROM wms.operational_exception oe
         JOIN wms.exception_type et ON et.code = oe.exception_type
         WHERE oe.status IN ('PENDING', 'ESCALATED')
           AND oe.created_at < now() - (et.auto_expire_hours || ' hours')::interval
         FOR UPDATE OF oe SKIP LOCKED`
      );

      for (const row of candidates.rows) {
        await client.query(
          `UPDATE wms.operational_exception SET status = 'EXPIRED', reason_decision = 'EXPIRADA', decided_at = now(), updated_at = now() WHERE id = $1`,
          [row.id]
        );
        await this.eventsService.publishInTransaction(client, {
          event_type: 'seguranca.excecao_rejeitada',
          tenant_id: row.tenant_id,
          warehouse_id: row.warehouse_id,
          actor_user_id: SYSTEM_ACTOR,
          payload: { exception_id: row.id, status: 'EXPIRED', reason: 'EXPIRADA' },
        });
        expired.push(row);
      }
    });

    for (const row of expired) {
      await this.auditService.record({
        tenantId: row.tenant_id,
        warehouseId: row.warehouse_id,
        userId: SYSTEM_ACTOR,
        origin: 'SCHEDULER',
        entity: 'operational_exception',
        entityId: row.id,
        action: 'REJECT',
        reason: 'EXPIRADA',
      });
    }

    return { expiredIds: expired.map((e) => e.id) };
  }
}
