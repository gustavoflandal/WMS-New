// DOC-12 §4.4 [INVIOLÁVEL] — RD-SEG-030 (estrutura), RN-SEG-031
// (imutabilidade — INSERT/SELECT apenas, garantido no banco pela migration
// 0019), RN-SEG-032 (cobertura obrigatória), RF-SEG-033 (consulta +
// exportação CSV).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export type AuditOrigin = 'WEB' | 'PWA' | 'PORTAL' | 'API' | 'EDGE' | 'SCHEDULER' | 'SYNC';
export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'STATUS_CHANGE'
  | 'MOVE'
  | 'APPROVE'
  | 'REJECT'
  | 'OVERRIDE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EXPORT'
  | 'PRINT';

export interface AuditEntry {
  tenantId?: string | null;
  warehouseId?: string | null; // NOT NULL exceto LOGIN/LOGOUT (RD-SEG-030 + desvio documentado na migration 0019)
  userId: string;
  origin: AuditOrigin;
  deviceId?: string | null;
  entity: string;
  entityId: string;
  action: AuditAction;
  requirementId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  correlationId?: string | null;
}

export interface AuditQueryFilters {
  from?: Date;
  to?: Date;
  userId?: string;
  entity?: string;
  action?: AuditAction;
  warehouseId?: string;
  tenantId?: string;
  correlationId?: string;
  limit?: number;
}

@Injectable()
export class AuditService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** RN-SEG-032: ponto único de escrita da trilha — todo módulo futuro deve chamar isto (ou o interceptor/@Audited). */
  async record(entry: AuditEntry): Promise<void> {
    await this.db.queryGlobal(
      `INSERT INTO wms.audit_log (
        tenant_id, warehouse_id, user_id, origin, device_id, entity, entity_id, action,
        requirement_id, before, after, reason, correlation_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entry.tenantId ?? null,
        entry.warehouseId ?? null,
        entry.userId,
        entry.origin,
        entry.deviceId ?? null,
        entry.entity,
        entry.entityId,
        entry.action,
        entry.requirementId ?? null,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.reason ?? null,
        entry.correlationId ?? null,
      ]
    );
  }

  /** RF-SEG-033: consulta com filtros. */
  async query(filters: AuditQueryFilters): Promise<any[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (filters.from) {
      conditions.push(`occurred_at >= $${i++}`);
      values.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`occurred_at <= $${i++}`);
      values.push(filters.to);
    }
    if (filters.userId) {
      conditions.push(`user_id = $${i++}`);
      values.push(filters.userId);
    }
    if (filters.entity) {
      conditions.push(`entity = $${i++}`);
      values.push(filters.entity);
    }
    if (filters.action) {
      conditions.push(`action = $${i++}`);
      values.push(filters.action);
    }
    if (filters.warehouseId) {
      conditions.push(`warehouse_id = $${i++}`);
      values.push(filters.warehouseId);
    }
    if (filters.tenantId) {
      conditions.push(`tenant_id = $${i++}`);
      values.push(filters.tenantId);
    }
    if (filters.correlationId) {
      conditions.push(`correlation_id = $${i++}`);
      values.push(filters.correlationId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 500, 5000);
    values.push(limit);

    const result = await this.db.queryGlobal(`SELECT * FROM wms.audit_log ${where} ORDER BY occurred_at DESC LIMIT $${i}`, values);
    return result.rows;
  }

  /** RF-SEG-033: "a própria exportação é auditada" — chamado pelo controller, que audita a chamada em seguida. */
  toCsv(rows: any[]): string {
    const columns = [
      'occurred_at',
      'tenant_id',
      'warehouse_id',
      'user_id',
      'origin',
      'device_id',
      'entity',
      'entity_id',
      'action',
      'requirement_id',
      'before',
      'after',
      'reason',
      'correlation_id',
    ];
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `"${str.replace(/"/g, '""')}"`;
    };
    const header = columns.join(',');
    const lines = rows.map((row) => columns.map((c) => escape(row[c])).join(','));
    return [header, ...lines].join('\n');
  }
}
