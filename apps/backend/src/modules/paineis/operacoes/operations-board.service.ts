// DOC-10 §4.1 — RF-PAI-001 (conteúdo do painel), RF-PAI-002 (filtros/
// ordenação), RN-PAI-004 (atraso por SLA). CONSOME o contrato único de
// leitura de etapas criado na 6A (OperationFlowService) para o estado da
// trilha na tela do fluxo (RF-PAI-005) — este service só monta a LISTAGEM
// consolidada de cartões, que é uma pergunta diferente ("quais fluxos estão
// abertos, em que etapa, há quanto tempo") e não duplica a árvore de estado
// da RN-EXP-011.
//
// RF-PAI-001 "os tipos ainda não implementados simplesmente não aparecem,
// sem código morto": hoje só 2 entidades criam operation_flow
// (inbound_order via RECEBIMENTO, outbound_order via OutboundFlowService) —
// ver grep de createFlow() nesta base. Reversa (DOC-07), Transferência
// inter-armazém e Inventário (DOC-05) não abrem operation_flow ainda; a
// UNION abaixo ganha mais um braço no dia em que abrirem, sem mudar o resto
// da query.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';

export interface OperationCard {
  flowId: string;
  entity: string;
  entityId: string;
  cardType: string;
  documentNumber: string | null;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
  currentStepCode: string;
  stepStartedAt: string | null;
  timeInStepMinutes: number | null;
  hasPendingException: boolean;
  isLate: boolean;
}

export interface ListCardsInput {
  userId: string;
  warehouseId: string;
  /** RF-PAI-002 filtros combináveis */
  cardType?: string;
  clientId?: string;
  stepCode?: string;
  onlyWithException?: boolean;
  onlyLate?: boolean;
  createdFrom?: string;
  createdTo?: string;
  text?: string;
}

interface CardRow {
  flow_id: string;
  entity: string;
  entity_id: string;
  card_type: string | null;
  document_number: string | null;
  client_id: string | null;
  client_name: string | null;
  created_at: string;
  step_code: string;
  step_started_at: string | null;
  has_pending_exception: boolean;
}

@Injectable()
export class OperationsBoardService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  /**
   * RN-PAI-004 — mapa etapa->minutos, JSON em app_parameter (WAREHOUSE).
   * "Sem entrada = sem SLA". Lido pelo MESMO client de transactionAsWorker
   * de listCards() (BYPASSRLS) — não abre uma 2ª transação com contexto de
   * tenant: essa consulta já é cross-cliente por natureza (RN-SEG-011 foi
   * aplicado em código, não por RLS), e "qual client_id fictício usar para
   * satisfazer db.query(ctx,...)" não tem resposta certa quando o usuário é
   * irrestrito (authorizedClientIds === null).
   */
  private async resolveSlaMap(client: PoolClient, warehouseId: string): Promise<Record<string, number>> {
    const result = await client.query<{ value: string }>(
      `SELECT value FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND warehouse_id = $1 AND name = 'PAI.SLA_ETAPA_MIN'`,
      [warehouseId]
    );
    const raw = result.rows[0]?.value;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  /** RF-PAI-001/002 — lista os cartões do armazém, filtrados por RN-SEG-011 e pelos filtros combináveis, ordenados por RF-PAI-002. */
  async listCards(input: ListCardsInput): Promise<OperationCard[]> {
    const authorizedClientIds = await this.rbacService.resolveWarehouseAuthorizedClientIds(input.userId, input.warehouseId, 'PAI.PAINEL_OPERACOES');
    if (authorizedClientIds !== null && authorizedClientIds.length === 0) return [];

    // ctx só para leitura (SELECT) — usa qualquer client autorizado como
    // tenant_id da sessão; app_parameter WAREHOUSE não depende de qual
    // client_id está em app.tenant_ids (só checa scope+warehouse_id), e
    // operation_flow's RLS não é usada aqui pois esta é uma consulta
    // deliberadamente CROSS-CLIENT dentro do armazém (o painel mostra vários
    // clientes ao mesmo tempo) — roda via transactionAsWorker por esse
    // motivo (mesma razão de KPI/dashboard, não é RN-SEG-012 burlado: o
    // filtro RN-SEG-011 já foi aplicado acima, em código, antes de montar
    // a query).
    const { cardRows: rows, slaMap } = await this.db.transactionAsWorker(async (client) => {
      // f.status já é filtrado dentro da CTE `flows` (literal 'IN_PROGRESS');
      // não é uma coluna do resultado da CTE, então não entra nesta lista.
      const conditions: string[] = ['f.warehouse_id = $1'];
      const params: unknown[] = [input.warehouseId];

      if (authorizedClientIds !== null) {
        params.push(authorizedClientIds);
        conditions.push(`f.tenant_id = ANY($${params.length}::uuid[])`);
      }
      if (input.clientId) {
        params.push(input.clientId);
        conditions.push(`f.tenant_id = $${params.length}`);
      }
      if (input.cardType) {
        params.push(input.cardType);
        conditions.push(`d.card_type = $${params.length}`);
      }
      if (input.createdFrom) {
        params.push(input.createdFrom);
        conditions.push(`f.created_at >= $${params.length}`);
      }
      if (input.createdTo) {
        params.push(input.createdTo);
        conditions.push(`f.created_at <= $${params.length}`);
      }
      if (input.text) {
        params.push(`%${input.text}%`);
        conditions.push(`(d.document_number ILIKE $${params.length} OR c.legal_name ILIKE $${params.length})`);
      }

      const query = `
        WITH flows AS (
          SELECT id, tenant_id, entity, entity_id, warehouse_id, created_at
          FROM wms.operation_flow f
          WHERE f.status = 'IN_PROGRESS' AND f.warehouse_id = $1
        ),
        current_step AS (
          SELECT DISTINCT ON (fs.operation_flow_id)
            fs.operation_flow_id, fs.step_code, fs.started_at,
            (fs.blocking_exception_id IS NOT NULL AND oe.status IN ('PENDING', 'ESCALATED')) AS has_pending_exception
          FROM wms.flow_step fs
          LEFT JOIN wms.operational_exception oe ON oe.id = fs.blocking_exception_id
          WHERE fs.status = 'PENDING'
          ORDER BY fs.operation_flow_id, fs.sequence_order ASC
        ),
        documents AS (
          SELECT id, 'inbound_order'::text AS entity, number AS document_number, 'RECEBIMENTO'::text AS card_type FROM wms.inbound_order
          UNION ALL
          SELECT id, 'outbound_order'::text AS entity, number AS document_number, 'PEDIDO'::text AS card_type FROM wms.outbound_order
        )
        SELECT f.id AS flow_id, f.entity, f.entity_id, f.created_at, f.tenant_id AS client_id,
               c.legal_name AS client_name, d.document_number, d.card_type,
               cs.step_code, cs.started_at AS step_started_at, COALESCE(cs.has_pending_exception, false) AS has_pending_exception
        FROM flows f
        JOIN current_step cs ON cs.operation_flow_id = f.id
        LEFT JOIN documents d ON d.id = f.entity_id AND d.entity = f.entity
        LEFT JOIN wms.client c ON c.id = f.tenant_id
        WHERE ${conditions.join(' AND ')}
        ${input.stepCode ? `AND cs.step_code = $${params.push(input.stepCode)}` : ''}
        ${input.onlyWithException ? 'AND COALESCE(cs.has_pending_exception, false) = true' : ''}
      `;

      const cardRows = await client.query<CardRow>(query, params);
      const slaMap = await this.resolveSlaMap(client, input.warehouseId);
      return { cardRows, slaMap };
    });

    const now = Date.now();

    let cards: OperationCard[] = rows.rows.map((row) => {
      const stepStartedAtMs = row.step_started_at ? new Date(row.step_started_at).getTime() : null;
      const timeInStepMinutes = stepStartedAtMs !== null ? Math.floor((now - stepStartedAtMs) / 60000) : null;
      const slaMinutes = slaMap[row.step_code];
      const isLate = typeof slaMinutes === 'number' && timeInStepMinutes !== null && timeInStepMinutes > slaMinutes;

      return {
        flowId: row.flow_id,
        entity: row.entity,
        entityId: row.entity_id,
        cardType: row.card_type ?? row.entity,
        documentNumber: row.document_number,
        clientId: row.client_id,
        clientName: row.client_name,
        createdAt: row.created_at,
        currentStepCode: row.step_code,
        stepStartedAt: row.step_started_at,
        timeInStepMinutes,
        hasPendingException: row.has_pending_exception,
        isLate,
      };
    });

    if (input.onlyLate) {
      cards = cards.filter((c) => c.isLate);
    }

    // RF-PAI-002 — ordenação padrão: atrasados primeiro, depois maior tempo
    // na etapa atual.
    cards.sort((a, b) => {
      if (a.isLate !== b.isLate) return a.isLate ? -1 : 1;
      return (b.timeInStepMinutes ?? 0) - (a.timeInStepMinutes ?? 0);
    });

    return cards;
  }
}
