// DOC-15 RNF-COL-003 — registro do dispositivo de campo. GLOBAL (mesmo
// raciocínio de wms.peripheral_device, DOC-11 migration 0061): o
// dispositivo é infraestrutura do armazém, não dado de tenant.
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

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
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /**
   * RNF-COL-003: registra (ou atualiza `last_seen_at`/versão de) um device_id
   * já existente — idempotente por device_id. RNF-COL-050 [INVIOLÁVEL]: a
   * cada login (é aqui que o PWA registra/toca o dispositivo) confronta a
   * versão informada contra `COL.VERSAO_MINIMA` e devolve `versionBlocked` —
   * o bloqueio de novas execuções é responsabilidade do CLIENTE (COL-2B);
   * este método NUNCA recusa o registro por versão antiga, só sinaliza.
   */
  async registerOrTouch(input: RegisterFieldDeviceInput) {
    const existing = await this.db.queryGlobal(`SELECT * FROM wms.field_device WHERE device_id = $1`, [input.deviceId]);
    let device: Record<string, unknown>;

    if (existing.rows.length > 0) {
      const current = existing.rows[0];
      if (current.status === 'BLOCKED') {
        throw new ForbiddenException({ error: 'DEVICE_BLOCKED', detail: 'RNF-COL-003: este dispositivo foi bloqueado — contate o administrador (COL.DISPOSITIVO_GERIR)' });
      }
      const updated = await this.db.queryGlobal(
        `UPDATE wms.field_device SET last_seen_at = now(), app_version = COALESCE($2, app_version), user_agent = COALESCE($3, user_agent), updated_at = now(), updated_by = $4
         WHERE device_id = $1 RETURNING *`,
        [input.deviceId, input.appVersion ?? null, input.userAgent ?? null, input.actorUserId]
      );
      device = updated.rows[0];
    } else {
      const created = await this.db.queryGlobal(
        `INSERT INTO wms.field_device (device_id, warehouse_id, user_agent, app_version, last_seen_at, created_by)
         VALUES ($1,$2,$3,$4,now(),$5) RETURNING *`,
        [input.deviceId, input.warehouseId, input.userAgent ?? null, input.appVersion ?? null, input.actorUserId]
      );
      device = created.rows[0];

      await this.auditService.record({
        warehouseId: input.warehouseId,
        userId: input.actorUserId,
        origin: 'PWA',
        entity: 'field_device',
        entityId: device.id as string,
        action: 'CREATE',
        requirementId: 'DOC-15 RNF-COL-003',
        after: device,
      });
    }

    const versionBlocked = await this.isVersionBlocked((device.app_version as string | null) ?? input.appVersion ?? null);
    return { ...device, versionBlocked };
  }

  /**
   * RNF-COL-050 — compara a versão do dispositivo contra `COL.VERSAO_MINIMA`
   * (semver simples major.minor.patch, sem pré-release — suficiente para o
   * formato usado em COL.VERSAO_MINIMA, migration 0066). Sem versão
   * informada (dispositivo antigo demais para reportar) conta como
   * bloqueada — "sem versão" nunca é tratado como "versão nova".
   */
  async isVersionBlocked(appVersion: string | null): Promise<boolean> {
    // wms.app_parameter TEM RLS mesmo para linhas scope='GLOBAL' (achado
    // transversal, ver CLAUDE.md "Acesso a dados: RLS e queryGlobal()") —
    // queryGlobal() aqui devolveria 0 linhas em silêncio (ou lançaria a rede
    // de segurança fora de produção). Sem tenant_id disponível neste ponto
    // (registro de dispositivo é anterior a qualquer contexto de cliente),
    // lê via wms_worker (transactionAsWorker, BYPASSRLS), mesmo padrão de
    // CrossDockService.checkAging()/AlertMaterializationService.syncLateCards().
    const minVersion = await this.db.transactionAsWorker(async (client) => {
      const result = await client.query(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'COL.VERSAO_MINIMA'`);
      return result.rows[0]?.value as string | undefined;
    });
    if (!minVersion) return false;
    if (!appVersion) return true;
    return compareSemver(appVersion, minVersion) < 0;
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

  /**
   * RNF-COL-051 — "alerta para dispositivo sem contato > 24h com fila > 0".
   * wms.field_device é GLOBAL (sem tenant_id, mesmo raciocínio de
   * peripheral_device) — publica evento (`campo.dispositivo_sem_contato`,
   * consumido por AlertMaterializationService) em vez de chamar AlertService
   * diretamente, mesmo padrão de CrossDockService.checkAging() (evita
   * acoplar o módulo `campo` ao módulo `paineis`). Chamado pelo worker
   * (`FieldDeviceOfflineWorkerImpl`), não pela API.
   */
  async checkOfflineWithPendingQueue(): Promise<{ alertedDeviceIds: string[] }> {
    const alerted: string[] = [];

    await this.db.transactionAsWorker(async (client) => {
      const candidates = await client.query(
        `SELECT device_id, warehouse_id, queue_size FROM wms.field_device
         WHERE status = 'ACTIVE' AND queue_size IS NOT NULL AND queue_size > 0
           AND last_seen_at IS NOT NULL AND last_seen_at < now() - INTERVAL '24 hours'`
      );

      for (const row of candidates.rows) {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'campo.dispositivo_sem_contato',
          tenant_id: null,
          warehouse_id: row.warehouse_id,
          actor_user_id: SYSTEM_ACTOR,
          payload: { device_id: row.device_id, queue_size: row.queue_size },
        });
        alerted.push(row.device_id);
      }
    });

    return { alertedDeviceIds: alerted };
  }

  /**
   * RNF-COL-051 (telemetria mínima) — "versão, device_id, nível de bateria,
   * tamanho da fila, falhas de leitura por origem (físico/câmera)". COL-1
   * só reportava bateria (fila real só nasce nesta sessão, COL-2A);
   * queueSize/readFailures* passam a ser gravados quando informados.
   */
  async recordTelemetry(deviceId: string, batteryPct?: number, queueSize?: number, readFailuresPhysical?: number, readFailuresCamera?: number) {
    if (batteryPct !== undefined && (batteryPct < 0 || batteryPct > 100)) {
      throw new BadRequestException({ error: 'INVALID_BATTERY', detail: 'battery_pct deve estar entre 0 e 100' });
    }
    if (queueSize !== undefined && queueSize < 0) {
      throw new BadRequestException({ error: 'INVALID_QUEUE_SIZE', detail: 'queue_size não pode ser negativo' });
    }
    await this.db.queryGlobal(
      `UPDATE wms.field_device SET last_sync_at = now(), battery_pct = COALESCE($2, battery_pct),
         queue_size = COALESCE($3, queue_size),
         read_failures_physical = COALESCE($4, read_failures_physical),
         read_failures_camera = COALESCE($5, read_failures_camera)
       WHERE device_id = $1`,
      [deviceId, batteryPct ?? null, queueSize ?? null, readFailuresPhysical ?? null, readFailuresCamera ?? null]
    );
  }
}

/**
 * Compara duas versões `major.minor.patch` (sem pré-release/build metadata —
 * suficiente para o formato usado em COL.VERSAO_MINIMA). Retorna negativo se
 * `a` < `b`, positivo se `a` > `b`, 0 se iguais. Segmento ausente ou não
 * numérico conta como 0 (versão mal formada não deve derrubar o boot nem
 * travar o login — apenas compara o que dá para comparar).
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0);
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
