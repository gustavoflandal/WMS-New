// DOC-11 RNF-PER-001 — Registro e autenticação de Edge Agent. Estende
// wms.edge_agent (Sessão 1, migration 0007) SEM duplicar a tabela: só
// adiciona o fluxo de pareamento (token de alta entropia, hash SHA-256
// armazenado — RD-ARQ-003) que nunca existiu (a tabela só era populada
// manualmente/por seed até esta sessão).
import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';

export interface RegisterEdgeAgentInput {
  warehouseId: string;
  deviceName: string;
  deviceType?: string;
  serialNumber?: string;
  actorUserId: string;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class EdgeAgentAdminService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão do módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /**
   * RNF-PER-001: pareamento de um novo Edge Agent — gera um token de 32
   * bytes aleatórios, retorna o valor EM TEXTO PLANO uma única vez (como
   * uma API key) e persiste só o hash. Requer PER.GESTAO_DISPOSITIVOS
   * (verificado pelo controller via PermissionGuard).
   */
  async registerAgent(input: RegisterEdgeAgentInput): Promise<{ edgeAgentId: string; token: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    const result = await this.db.queryGlobal(
      `INSERT INTO wms.edge_agent (warehouse_id, device_name, device_type, serial_number, token_hash, status, paired_at, paired_by)
       VALUES ($1,$2,$3,$4,$5,'OFFLINE', now(), $6) RETURNING edge_agent_id`,
      [input.warehouseId, input.deviceName, input.deviceType ?? null, input.serialNumber ?? null, tokenHash, input.actorUserId]
    );
    const edgeAgentId = result.rows[0].edge_agent_id;

    await this.auditService.record({
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'WEB',
      entity: 'edge_agent',
      entityId: edgeAgentId,
      action: 'CREATE',
      requirementId: 'DOC-11 RNF-PER-001',
      after: { edge_agent_id: edgeAgentId, device_name: input.deviceName, warehouse_id: input.warehouseId },
    });

    return { edgeAgentId, token: rawToken };
  }

  /**
   * RNF-PER-001: autentica a conexão WebSocket outbound do agent pelo hash
   * do token apresentado. Retorna null (não lança) para credencial
   * inválida — o chamador (gateway) decide como reagir (desconectar).
   */
  async authenticate(rawToken: string): Promise<{ edgeAgentId: string; warehouseId: string } | null> {
    const tokenHash = hashToken(rawToken);
    const result = await this.db.queryGlobal<{ edge_agent_id: string; warehouse_id: string }>(
      `SELECT edge_agent_id, warehouse_id FROM wms.edge_agent WHERE token_hash = $1`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { edgeAgentId: row.edge_agent_id, warehouseId: row.warehouse_id };
  }

  /** RNF-PER-001: transição de status na conexão/desconexão/heartbeat perdido. */
  async setStatus(edgeAgentId: string, status: 'ONLINE' | 'OFFLINE', actorUserId: string): Promise<void> {
    // $2 é usado 2x com tipos diferentes (coluna enum device_status E
    // comparação de texto) — sem cast explícito em AMBOS os usos, o
    // Postgres não consegue unificar o tipo do parâmetro ("inconsistent
    // types deduced for parameter $2", achado ao rodar a suíte real).
    const result = await this.db.queryGlobal(
      `UPDATE wms.edge_agent SET status = $2::wms.device_status, last_heartbeat = CASE WHEN $2::text = 'ONLINE' THEN now() ELSE last_heartbeat END, updated_at = now() WHERE edge_agent_id = $1 RETURNING warehouse_id`,
      [edgeAgentId, status]
    );
    if (result.rows.length === 0) throw new NotFoundException(`edge_agent ${edgeAgentId} not found`);

    await this.auditService.record({
      warehouseId: result.rows[0].warehouse_id,
      userId: actorUserId,
      origin: 'EDGE',
      entity: 'edge_agent',
      entityId: edgeAgentId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-11 RNF-PER-001',
      after: { status },
    });
  }

  async touchHeartbeat(edgeAgentId: string): Promise<void> {
    await this.db.queryGlobal(`UPDATE wms.edge_agent SET last_heartbeat = now() WHERE edge_agent_id = $1`, [edgeAgentId]);
  }

  /**
   * RNF-PER-001: "2 heartbeats perdidos (15s cada) = OFFLINE com alerta" —
   * cobre o caso de partição de rede (o socket nunca dispara
   * handleDisconnect; sem isto o agent ficaria ONLINE para sempre no banco).
   * 30s = 2×15s.
   */
  async sweepStaleHeartbeats(): Promise<number> {
    const result = await this.db.queryGlobal<{ edge_agent_id: string; warehouse_id: string }>(
      `UPDATE wms.edge_agent SET status = 'OFFLINE', updated_at = now()
       WHERE status = 'ONLINE' AND (last_heartbeat IS NULL OR last_heartbeat < now() - INTERVAL '30 seconds')
       RETURNING edge_agent_id, warehouse_id`
    );
    for (const row of result.rows) {
      await this.db.transactionAsWorker(async (client) => {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'perifericos.agent_offline',
          tenant_id: null,
          warehouse_id: row.warehouse_id,
          payload: { edge_agent_id: row.edge_agent_id, reason: 'HEARTBEAT_TIMEOUT' },
        });
      });
    }
    return result.rows.length;
  }
}
