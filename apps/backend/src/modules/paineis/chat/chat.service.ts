// DOC-10 §4.4 RF-PAI-030, RN-PAI-031 [INVIOLÁVEL] — chat operacional.
//
// RN-PAI-031: "é PROIBIDO acionar qualquer operação a partir do chat" — a
// prova é estrutural, não um teste de comportamento negativo interminável:
// esta classe não injeta NENHUM service capaz de mudar estado de negócio
// (nem OperationFlowService, nem StockMovementService, nem
// OperationalExceptionService) — só DatabaseService/EventsService, os
// mesmos dois de qualquer módulo puramente informativo. Ver
// __tests__/chat.integration.spec.ts para a prova por inspeção da
// superfície pública.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';

const MAX_BODY_LENGTH = 2000;

export interface SendMessageInput {
  roomId: string;
  senderUserId: string;
  body: string;
  attachmentUrl?: string;
  mentionedUserIds?: string[];
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /** RF-PAI-030(a) — "uma por armazém, persistente". Idempotente (UNIQUE parcial, migration 0055). */
  async getOrCreateWarehouseShiftRoom(warehouseId: string, actorUserId: string): Promise<Record<string, unknown>> {
    return this.db.transactionAsWorker(async (client) => {
      const existing = await client.query(`SELECT * FROM wms.chat_room WHERE warehouse_id = $1 AND room_type = 'ARMAZEM_TURNO'`, [warehouseId]);
      if (existing.rows.length > 0) return existing.rows[0];

      const created = await client.query(
        `INSERT INTO wms.chat_room (tenant_id, warehouse_id, room_type, created_by) VALUES (NULL, $1, 'ARMAZEM_TURNO', $2) RETURNING *`,
        [warehouseId, actorUserId]
      );
      return created.rows[0];
    });
  }

  /** RF-PAI-030(b) — "criada sob demanda a partir do cartão/tela do fluxo", herda tenant_id da operação. Idempotente. */
  async getOrCreateOperationRoom(operationFlowId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<Record<string, unknown>> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    return this.db.transaction(ctx, async (client) => {
      const existing = await client.query(`SELECT * FROM wms.chat_room WHERE operation_flow_id = $1 AND room_type = 'OPERACAO'`, [operationFlowId]);
      if (existing.rows.length > 0) return existing.rows[0];

      const created = await client.query(
        `INSERT INTO wms.chat_room (tenant_id, warehouse_id, room_type, operation_flow_id, created_by) VALUES ($1,$2,'OPERACAO',$3,$4) RETURNING *`,
        [tenantId, warehouseId, operationFlowId, actorUserId]
      );
      return created.rows[0];
    });
  }

  /** RF-PAI-030 — texto até 2.000 chars, anexo opcional, menções notificam via tópico `chat:{sala}` (resolvido dinamicamente pelo fanout, ver realtime-fanout.worker.impl.ts). Mensagem IMUTÁVEL — sem update()/delete() nesta classe, de propósito. */
  async sendMessage(input: SendMessageInput): Promise<Record<string, unknown>> {
    if (!input.body || input.body.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_MESSAGE', detail: 'RF-PAI-030: mensagem não pode ser vazia' });
    }
    if (input.body.length > MAX_BODY_LENGTH) {
      throw new BadRequestException({ error: 'MESSAGE_TOO_LONG', detail: `RF-PAI-030: mensagem excede ${MAX_BODY_LENGTH} caracteres` });
    }

    return this.db.transactionAsWorker(async (client) => {
      const roomResult = await client.query(`SELECT * FROM wms.chat_room WHERE id = $1`, [input.roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new NotFoundException(`chat_room ${input.roomId} not found`);

      const messageResult = await client.query(
        `INSERT INTO wms.chat_message (room_id, tenant_id, warehouse_id, sender_user_id, body, attachment_url, mentioned_user_ids, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$4) RETURNING *`,
        [input.roomId, room.tenant_id, room.warehouse_id, input.senderUserId, input.body, input.attachmentUrl ?? null, input.mentionedUserIds ?? null]
      );
      const message = messageResult.rows[0];

      // room_id no payload: realtime-fanout.worker.impl.ts resolve o tópico
      // dinâmico `chat:{room_id}` a partir daqui (EVENT_TOPIC_MAPPING não
      // serve — 1 event_type só mapeia para 1 tópico fixo).
      await this.eventsService.publishInTransaction(client, {
        event_type: 'paineis.chat_mensagem',
        tenant_id: room.tenant_id,
        warehouse_id: room.warehouse_id,
        actor_user_id: input.senderUserId,
        // RF-PAI-030 "payload sem conteúdo — o conteúdo trafega no canal da
        // sala" (§4.6): o EVENTO de domínio (outbox/auditoria) não carrega o
        // texto da mensagem, só o necessário para notificar/rotear.
        payload: { room_id: input.roomId, message_id: message.id, mentioned_user_ids: input.mentionedUserIds ?? [] },
      });

      return message;
    });
  }

  /** `sender_name` via LEFT JOIN (mesmo padrão de OperationFlowService.getFlowState `updated_by_name`) — a tela não tem outra forma de exibir quem enviou, não existe endpoint de diretório de usuários nesta sessão. */
  async listMessages(roomId: string, tenantId: string | null, warehouseId: string, actorUserId: string): Promise<Array<Record<string, unknown>>> {
    const ctx: TenantContext = { tenant_id: tenantId ?? '00000000-0000-0000-0000-000000000000', user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query(
      ctx,
      `SELECT cm.*, u.name AS sender_name
       FROM wms.chat_message cm
       LEFT JOIN wms.user u ON u.id = cm.sender_user_id
       WHERE cm.room_id = $1
       ORDER BY cm.created_at ASC`,
      [roomId]
    );
    return result.rows;
  }
}
