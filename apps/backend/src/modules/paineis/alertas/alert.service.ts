// DOC-10 §4.2 RF-PAI-010, §5.2 — CRUD do centro de alertas. Dedup por
// (alert_type, source_entity, source_entity_id) — no máximo 1 alerta
// EMITIDO por origem (índice único parcial, migration 0055); reabertura só
// depois de RESOLVIDO. create()/resolve() são idempotentes por construção
// (ON CONFLICT), chamáveis livremente pelo materializador a cada evento sem
// duplicar.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';

export type AlertSeverity = 'INFO' | 'WARN' | 'CRIT';
export const ALERT_TYPES = [
  'EXCECAO_AGUARDANDO', 'EDGE_AGENT_OFFLINE', 'ESTOQUE_SEGURANCA_VIOLADO',
  'LOTE_A_VENCER', 'LOTE_VENCIDO', 'CROSSDOCK_TEMPO_EXCEDIDO',
  'TRANSBORDO_PENDENTE', 'CARTAO_ATRASADO', 'FALHA_INTEGRACAO',
  'DISPOSITIVO_CAMPO_OFFLINE',
  // DOC-08 RN-FIS-010 (Sessão 8A): prazo de regularização fiscal se
  // aproximando (WARN, 50/80%) ou vencido (CRIT, 100%/expirado).
  'PRAZO_FISCAL_EXPIRADO',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface CreateAlertInput {
  tenantId: string | null;
  warehouseId: string;
  severity: AlertSeverity;
  alertType: AlertType;
  title: string;
  message?: string;
  sourceEntity: string;
  sourceEntityId: string;
  sourceEventId?: string;
}

export interface ListAlertsInput {
  warehouseId: string;
  authorizedClientIds: string[] | null; // null = irrestrito (RN-SEG-011, mesmo raciocínio do painel)
  status?: 'EMITIDO' | 'RESOLVIDO';
  severity?: AlertSeverity;
  userId?: string; // para juntar leitura (RF-PAI-010 "marcação de lido por usuário")
}

@Injectable()
export class AlertService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /** RF-PAI-010 — cria (ou é no-op se já EMITIDO para a mesma origem, ON CONFLICT DO NOTHING). Publica paineis.alerta_emitido só quando de fato cria. */
  async create(input: CreateAlertInput): Promise<{ created: boolean; alertId: string | null }> {
    return this.db.transactionAsWorker(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO wms.alert (tenant_id, warehouse_id, severity, alert_type, title, message, source_entity, source_entity_id, source_event_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'00000000-0000-0000-0000-000000000001')
         ON CONFLICT (alert_type, source_entity, source_entity_id) WHERE status = 'EMITIDO' DO NOTHING
         RETURNING id`,
        [input.tenantId, input.warehouseId, input.severity, input.alertType, input.title, input.message ?? null, input.sourceEntity, input.sourceEntityId, input.sourceEventId ?? null]
      );
      if (result.rows.length === 0) return { created: false, alertId: null };

      const alertId = result.rows[0].id;
      await this.eventsService.publishInTransaction(client, {
        event_type: 'paineis.alerta_emitido',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: '00000000-0000-0000-0000-000000000001',
        payload: { alert_id: alertId, alert_type: input.alertType, severity: input.severity, source_entity: input.sourceEntity, source_entity_id: input.sourceEntityId },
      });
      return { created: true, alertId };
    });
  }

  /** §5.2 — "RESOLVIDO quando o objeto de origem sai da condição". Idempotente: alerta já RESOLVIDO/inexistente não é erro. */
  async resolveByOrigin(alertType: AlertType, sourceEntity: string, sourceEntityId: string): Promise<boolean> {
    const result = await this.db.transactionAsWorker((client) =>
      client.query(
        `UPDATE wms.alert SET status = 'RESOLVIDO', resolved_at = now() WHERE alert_type = $1 AND source_entity = $2 AND source_entity_id = $3 AND status = 'EMITIDO' RETURNING id`,
        [alertType, sourceEntity, sourceEntityId]
      )
    );
    return result.rows.length > 0;
  }

  /** RF-PAI-010 — lista consolidada, filtrada por RN-SEG-011 (mesmo padrão do painel: client_id NULL sempre visível, client_id específico só se autorizado). */
  async list(input: ListAlertsInput): Promise<Array<Record<string, unknown>>> {
    return this.db.transactionAsWorker(async (client) => {
      // Qualificado com `a.`: wms.alert_read TAMBÉM tem warehouse_id/tenant_id
      // (duplicados para a própria policy RLS dela, migration 0055) — sem o
      // prefixo, a coluna vira ambígua assim que o LEFT JOIN abaixo entra
      // (achado desta sessão, via verificação manual ponta a ponta).
      const conditions = ['a.warehouse_id = $1'];
      const params: unknown[] = [input.warehouseId];
      if (input.authorizedClientIds !== null) {
        params.push(input.authorizedClientIds);
        conditions.push(`(a.tenant_id IS NULL OR a.tenant_id = ANY($${params.length}::uuid[]))`);
      }
      if (input.status) {
        params.push(input.status);
        conditions.push(`a.status = $${params.length}`);
      }
      if (input.severity) {
        params.push(input.severity);
        conditions.push(`a.severity = $${params.length}`);
      }

      const readJoin = input.userId ? `LEFT JOIN wms.alert_read ar ON ar.alert_id = a.id AND ar.user_id = $${params.push(input.userId)}` : '';
      const result = await client.query(
        `SELECT a.*, ${input.userId ? 'ar.read_at IS NOT NULL' : 'false'} AS is_read
         FROM wms.alert a
         ${readJoin}
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.status ASC, a.severity = 'CRIT' DESC, a.severity = 'WARN' DESC, a.created_at DESC`,
        params
      );
      return result.rows;
    });
  }

  /** RF-PAI-010 — "marcação de lido por usuário". */
  async markRead(alertId: string, userId: string, tenantId: string | null, warehouseId: string): Promise<void> {
    await this.db.query(
      { tenant_id: tenantId ?? '00000000-0000-0000-0000-000000000000', user_id: userId, warehouse_id: warehouseId },
      `INSERT INTO wms.alert_read (alert_id, tenant_id, warehouse_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (alert_id, user_id) DO NOTHING`,
      [alertId, tenantId, warehouseId, userId]
    );
  }

  /** Badge de não-lidos do cabeçalho (RF-PAI-010). */
  async countUnread(warehouseId: string, authorizedClientIds: string[] | null, userId: string): Promise<number> {
    return this.db.transactionAsWorker(async (client) => {
      const conditions = ['a.warehouse_id = $1', `a.status = 'EMITIDO'`, 'ar.alert_id IS NULL'];
      const params: unknown[] = [warehouseId];
      if (authorizedClientIds !== null) {
        params.push(authorizedClientIds);
        conditions.push(`(a.tenant_id IS NULL OR a.tenant_id = ANY($${params.length}::uuid[]))`);
      }
      params.push(userId);
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM wms.alert a
         LEFT JOIN wms.alert_read ar ON ar.alert_id = a.id AND ar.user_id = $${params.length}
         WHERE ${conditions.join(' AND ')}`,
        params
      );
      return Number(result.rows[0].count);
    });
  }
}
