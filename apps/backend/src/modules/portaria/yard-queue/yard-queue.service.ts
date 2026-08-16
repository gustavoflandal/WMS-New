// DOC-03 §4.3 — Pátio e fila. RN-POR-021 [regra determinística]: pontuação
// calculada e persistida (auditável), reexecutada a cada mudança de estado.
import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import {
  computeYardQueueScore,
  DEFAULT_YARD_QUEUE_WEIGHTS,
  YardQueueScoringWeights,
} from '../shared/yard-queue-scoring.util.js';

interface QueueableVisit {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  blocking_reason: string | null;
  contains_perishable: boolean;
  contains_hazmat: boolean;
}

@Injectable()
export class YardQueueService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  /** RN-POR-021: pesos P1-P4 parametrizáveis por armazém (app_parameter GLOBAL, com fallback ao padrão do documento). */
  async getWeights(tenantId: string, warehouseId: string, actorUserId: string): Promise<YardQueueScoringWeights> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT name, value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name LIKE 'POR.PESO_PRIORIDADE_%'`
    );
    const map = Object.fromEntries(result.rows.map((r: { name: string; value: string }) => [r.name, Number(r.value)]));
    return {
      p1: map['POR.PESO_PRIORIDADE_P1'] ?? DEFAULT_YARD_QUEUE_WEIGHTS.p1,
      p2: map['POR.PESO_PRIORIDADE_P2'] ?? DEFAULT_YARD_QUEUE_WEIGHTS.p2,
      p3: map['POR.PESO_PRIORIDADE_P3'] ?? DEFAULT_YARD_QUEUE_WEIGHTS.p3,
      p4: map['POR.PESO_PRIORIDADE_P4'] ?? DEFAULT_YARD_QUEUE_WEIGHTS.p4,
    };
  }

  /**
   * RN-POR-021: calcula e persiste a pontuação (INSERT ou recálculo em
   * UPDATE — "reexecutado a cada mudança de estado"). onSchedule: só o
   * documento cita explicitamente a redução para 0 no caso FORA_DA_JANELA
   * aprovada — os demais casos (inclusive SEM_AGENDAMENTO/SEM_AGENDA)
   * mantêm no_horario=1 por omissão, não inventado.
   */
  async enqueueWithClient(
    client: PoolClient,
    visit: QueueableVisit,
    weights: YardQueueScoringWeights,
    actorUserId: string,
    manualPriority = false,
    manualPriorityReason: string | null = null
  ) {
    const scoring = computeYardQueueScore(
      {
        onSchedule: visit.blocking_reason !== 'FORA_DA_JANELA',
        perishable: visit.contains_perishable,
        hazmat: visit.contains_hazmat,
        manualPriority,
      },
      weights
    );

    const result = await client.query(
      `INSERT INTO wms.yard_queue_entry (
        tenant_id, warehouse_id, vehicle_visit_id, direction,
        score, score_no_horario, score_perecivel, score_hazmat, score_prioridade_manual,
        manual_priority_reason, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (vehicle_visit_id) DO UPDATE SET
        score = $5, score_no_horario = $6, score_perecivel = $7, score_hazmat = $8, score_prioridade_manual = $9,
        manual_priority_reason = $10, status = 'WAITING', updated_at = now(), updated_by = $11
      RETURNING *`,
      [
        visit.tenant_id,
        visit.warehouse_id,
        visit.id,
        visit.direction,
        scoring.score,
        scoring.scoreNoHorario,
        scoring.scorePerecivel,
        scoring.scoreHazmat,
        scoring.scorePrioridadeManual,
        manualPriorityReason,
        actorUserId,
      ]
    );
    return result.rows[0];
  }

  /**
   * RN-POR-021: marcação de prioridade manual — motivo obrigatório,
   * permissão POR.FILA_PRIORIZAR, recalcula e persiste a pontuação.
   */
  async setManualPriority(entryId: string, warehouseId: string, reason: string, actorUserId: string) {
    const canPrioritize = await this.rbacService.hasPermission(actorUserId, 'POR.FILA_PRIORIZAR', { warehouseId });
    if (!canPrioritize) {
      throw new ForbiddenException({ error: 'MISSING_PERMISSION', detail: 'RN-POR-021: POR.FILA_PRIORIZAR é exigida para marcar prioridade manual' });
    }

    // Cross-tenant: a fila é do armazém, não de um único cliente (mesma
    // limitação estrutural de leitura documentada em listQueue() abaixo).
    const before = await this.db.transactionAsWorker(async (client) => {
      const result = await client.query('SELECT * FROM wms.yard_queue_entry WHERE id = $1', [entryId]);
      if (result.rows.length === 0) throw new NotFoundException(`yard_queue_entry ${entryId} not found`);
      return result.rows[0];
    });

    const weights = await this.getWeights(before.tenant_id, warehouseId, actorUserId);
    const scoring = computeYardQueueScore(
      {
        onSchedule: before.score_no_horario > 0,
        perishable: before.score_perecivel > 0,
        hazmat: before.score_hazmat > 0,
        manualPriority: true,
      },
      weights
    );

    const after = await this.db.transactionAsWorker(async (client) => {
      const result = await client.query(
        `UPDATE wms.yard_queue_entry SET score = $2, score_prioridade_manual = $3, manual_priority_reason = $4, updated_at = now(), updated_by = $5
         WHERE id = $1 RETURNING *`,
        [entryId, scoring.score, scoring.scorePrioridadeManual, reason, actorUserId]
      );
      return result.rows[0];
    });

    await this.auditService.record({
      tenantId: before.tenant_id,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'yard_queue_entry',
      entityId: entryId,
      action: 'UPDATE',
      requirementId: 'DOC-03 RN-POR-021',
      reason,
      before,
      after,
    });

    return after;
  }

  /**
   * RF-POR-020: painel de pátio em tempo real (tópico "patio"). A fila é
   * FÍSICA do armazém — todos os clientes disputam a MESMA fila — então a
   * listagem precisa ser cross-tenant.
   *
   * [DÉBITO: RG-001/DOC-00 descreve "modo multi-tenant explícito (lista de
   * tenants autorizados)" para staff interno, mas NENHUMA policy RLS já
   * escrita (Sessões 1.5 a 4) implementa comparação contra uma LISTA de
   * tenant_ids — app.tenant_ids é sempre comparado a um ÚNICO UUID (gap já
   * documentado em core/rbac/rbac.service.ts, "[ACHADO ARQUITETURAL]", não
   * introduzido nesta sessão). Sem esse mecanismo, a única forma de listar
   * a fila cross-tenant com o código existente é via transactionAsWorker
   * (BYPASSRLS, ADR-006) — desenho pensado para workers em background, aqui
   * reaproveitado para uma LEITURA (nunca escrita) disparada por requisição
   * HTTP de staff interno. Resolver corretamente exige reescrever as
   * policies RLS de todas as tabelas TENANT para `tenant_id = ANY(...)`,
   * mudança cross-cutting fora do escopo desta sessão.]
   */
  async listQueue(warehouseId: string, direction: 'INBOUND' | 'OUTBOUND') {
    return this.db.transactionAsWorker(async (client) => {
      const result = await client.query(
        `SELECT q.*, vv.arrived_at, vv.vehicle_id, vv.driver_id, v.plate
         FROM wms.yard_queue_entry q
         JOIN wms.vehicle_visit vv ON vv.id = q.vehicle_visit_id
         JOIN wms.vehicle v ON v.id = vv.vehicle_id
         WHERE q.warehouse_id = $1 AND q.direction = $2 AND q.status = 'WAITING'
         ORDER BY q.score DESC, q.created_at ASC`,
        [warehouseId, direction]
      );
      return result.rows;
    });
  }

  /** Chamado pelo primeiro da fila ser removido (DockCallService). */
  async markCalledWithClient(client: PoolClient, entryId: string, actorUserId: string) {
    const result = await client.query(
      `UPDATE wms.yard_queue_entry SET status = 'CALLED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [entryId, actorUserId]
    );
    return result.rows[0];
  }
}
