// RNF-ARQ-030..033: Transactional outbox pattern [INVIOLÁVEL]
// Guarantees exactly-once event publishing via database-backed outbox
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import { uuidV7 } from '../identifiers/uuid-v7.util.js';

// RNF-ARQ-030: Event Envelope canonical form (DOC-01 §6.2)
export interface EventEnvelope {
  event_id?: string;
  event_type: string;
  occurred_at?: Date;
  // tenant_id: null apenas para eventos de domínio verdadeiramente GLOBAIS
  // (DOC-03 RD-POR-004: person_visit/visitor, sem client associável) —
  // migration 0031. Todo evento de entidade TENANT continua exigindo um
  // tenant_id real.
  tenant_id: string | null;
  warehouse_id: string;
  actor_user_id?: string;
  actor_origin?: string;
  payload: Record<string, any>;
  correlation_id?: string;
  causation_id?: string;
  requirement_ids?: string[];
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  /**
   * Publish event to outbox within transaction
   * RNF-ARQ-030: Event envelope persisted in same transaction as aggregate
   * RNF-ARQ-031: Outbox guarantees delivery via background worker
   *
   * [INVIOLÁVEL] This is the ONLY way to publish events.
   * Direct Redis Pub/Sub publishing from HTTP is impossible (no private constructor pattern in TS,
   * but enforced by design: EventsService only exposed via transaction callback)
   */
  async publishInTransaction(
    client: PoolClient,
    event: EventEnvelope
  ): Promise<string> {
    if (!client) {
      throw new BadRequestException(
        'publishInTransaction REQUIRES active transaction. Use db.transaction(ctx, tx => events.publishInTransaction(tx, event))'
      );
    }

    // Generate IDs if not provided.
    // RG-011: event_id é PRIMARY KEY de wms.event_outbox (sem DEFAULT no
    // banco — quem gera é aqui) e a outbox é a tabela de maior volume de
    // escrita do sistema, já que toda escrita de negócio publica evento na
    // mesma transação. É o caso em que a localidade de índice do v7 mais
    // rende. correlation_id NÃO é chave (é id de rastreio), segue v4.
    const eventId = event.event_id || uuidV7();
    const correlationId = event.correlation_id || uuid();

    // Insert into event_outbox (RNF-ARQ-030: Event Envelope schema)
    const occurredAt = event.occurred_at || new Date();
    // Payload: RNF-ARQ-030 uses 'payload', but old code might use 'data'
    const payload = event.payload || (event as any).data || {};
    const result = await client.query(
      `INSERT INTO wms.event_outbox (
        event_id, event_type, occurred_at, tenant_id, warehouse_id,
        actor_user_id, actor_origin, correlation_id, causation_id,
        requirement_ids, payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING event_id`,
      [
        eventId,
        event.event_type,
        occurredAt,
        event.tenant_id,
        event.warehouse_id,
        event.actor_user_id || null,
        event.actor_origin || null,
        correlationId,
        event.causation_id || null,
        event.requirement_ids || null,
        JSON.stringify(payload),
      ]
    );

    this.logger.debug(
      `Event published to outbox: ${event.event_type} (${eventId}) for tenant=${event.tenant_id} warehouse=${event.warehouse_id}`
    );

    return eventId;
  }

  /**
   * Mark event as published (called by outbox worker)
   * RNF-ARQ-031: Worker polls unpublished events and marks them published
   */
  async markPublished(
    client: PoolClient,
    eventId: string,
    tenantId: string
  ): Promise<void> {
    await client.query(
      `UPDATE wms.event_outbox
       SET published_at = NOW()
       WHERE event_id = $1 AND tenant_id = $2`,
      [eventId, tenantId]
    );
  }

  /**
   * Record failed event attempt
   * RNF-ARQ-032: Failed events retry up to 5 times before DLQ
   */
  async recordFailure(
    client: PoolClient,
    eventId: string,
    tenantId: string,
    error: string,
    retryCount: number
  ): Promise<void> {
    // Note: DLQ and retry tracking not yet implemented in DOC-01
    // Placeholder for future Sessão with full event lifecycle
    this.logger.debug(
      `Event failure recorded: ${eventId} attempt ${retryCount}: ${error}`
    );
  }
}
