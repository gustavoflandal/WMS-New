// DOC-15 RNF-COL-003 — registro do dispositivo de campo. GLOBAL (mesmo
// raciocínio de wms.peripheral_device, DOC-11 migration 0061): o
// dispositivo é infraestrutura do armazém, não dado de tenant.
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';

export interface RegisterFieldDeviceInput {
  deviceId: string;
  warehouseId: string;
  userAgent?: string;
  appVersion?: string;
  actorUserId: string;
}

@Injectable()
export class FieldDeviceService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** RNF-COL-003: registra (ou atualiza `last_seen_at`/versão de) um device_id já existente — idempotente por device_id. */
  async registerOrTouch(input: RegisterFieldDeviceInput) {
    const existing = await this.db.queryGlobal(`SELECT * FROM wms.field_device WHERE device_id = $1`, [input.deviceId]);
    if (existing.rows.length > 0) {
      const device = existing.rows[0];
      if (device.status === 'BLOCKED') {
        throw new ForbiddenException({ error: 'DEVICE_BLOCKED', detail: 'RNF-COL-003: este dispositivo foi bloqueado — contate o administrador (COL.DISPOSITIVO_GERIR)' });
      }
      const updated = await this.db.queryGlobal(
        `UPDATE wms.field_device SET last_seen_at = now(), app_version = COALESCE($2, app_version), user_agent = COALESCE($3, user_agent), updated_at = now(), updated_by = $4
         WHERE device_id = $1 RETURNING *`,
        [input.deviceId, input.appVersion ?? null, input.userAgent ?? null, input.actorUserId]
      );
      return updated.rows[0];
    }

    const created = await this.db.queryGlobal(
      `INSERT INTO wms.field_device (device_id, warehouse_id, user_agent, app_version, last_seen_at, created_by)
       VALUES ($1,$2,$3,$4,now(),$5) RETURNING *`,
      [input.deviceId, input.warehouseId, input.userAgent ?? null, input.appVersion ?? null, input.actorUserId]
    );
    const device = created.rows[0];

    await this.auditService.record({
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'PWA',
      entity: 'field_device',
      entityId: device.id,
      action: 'CREATE',
      requirementId: 'DOC-15 RNF-COL-003',
      after: device,
    });

    return device;
  }

  /** RNF-COL-003: bloqueio administrativo (COL.DISPOSITIVO_GERIR) — sessões derrubadas, sincronização existente permitida, novas execuções negadas. */
  async block(id: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.queryGlobal(`UPDATE wms.field_device SET status = 'BLOCKED', blocked_at = now(), blocked_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [
      id,
      actorUserId,
    ]);
    if (result.rows.length === 0) throw new NotFoundException(`field_device ${id} not found`);

    await this.auditService.record({
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'field_device',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-15 RNF-COL-003',
      after: result.rows[0],
    });

    return result.rows[0];
  }

  async findByDeviceId(deviceId: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.field_device WHERE device_id = $1`, [deviceId]);
    if (result.rows.length === 0) throw new NotFoundException(`field_device ${deviceId} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.field_device WHERE warehouse_id = $1 ORDER BY last_seen_at DESC NULLS LAST`, [warehouseId]);
    return result.rows;
  }

  /** RNF-COL-051 (telemetria mínima): tamanho de fila é sempre 0 em COL-1 (fila real é COL-2) — reportado assim mesmo, não simulado. */
  async recordTelemetry(deviceId: string, batteryPct?: number) {
    if (batteryPct !== undefined && (batteryPct < 0 || batteryPct > 100)) {
      throw new BadRequestException({ error: 'INVALID_BATTERY', detail: 'battery_pct deve estar entre 0 e 100' });
    }
    await this.db.queryGlobal(`UPDATE wms.field_device SET last_sync_at = now(), battery_pct = COALESCE($2, battery_pct) WHERE device_id = $1`, [deviceId, batteryPct ?? null]);
  }
}
