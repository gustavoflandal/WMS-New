// DOC-08 §4.7 RNF-FIS-061 — monitor de disponibilidade SEFAZ (poll a cada
// 5 min, perfil `scheduler`), eleição de líder via lock Redis (mesmo padrão
// de ExpirationAlertWorkerImpl/InboundInvoiceDeadlineWorkerImpl). Varre
// emitentes em CONTINGENCIA_SVC cross-tenant (wms_worker, SELECT) e reverte
// para NORMAL, por emitente, via escrita tenant-scoped (wms_app).
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { DatabaseService, TenantContext } from '../core/database/database.service.js';
import { SefazClientPort } from '../modules/fiscal/emission/sefaz-client.port.js';

export interface FiscalSefazAvailabilityWorkerOptions {
  pollIntervalMs?: number;
}

const LOCK_RESOURCE = 'fiscal-sefaz-availability:fiscal';
const LOCK_TIMEOUT_MS = 30000;
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export class FiscalSefazAvailabilityWorkerImpl {
  private readonly logger = new Logger(FiscalSefazAvailabilityWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly sefazClient: SefazClientPort,
    private readonly cacheService: CacheService,
    options: FiscalSefazAvailabilityWorkerOptions = {}
  ) {
    // RNF-FIS-061: "monitor de disponibilidade (verificação a cada 5 min)".
    this.pollIntervalMs = options.pollIntervalMs ?? 5 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Fiscal SEFAZ availability worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Fiscal SEFAZ availability run error', error as Error);
      }
      if (this.running) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    this.logger.log('Fiscal SEFAZ availability worker stopped');
  }

  async runOnce(): Promise<{ ranAsLeader: boolean; recoveredIssuerIds: string[] }> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) return { ranAsLeader: false, recoveredIssuerIds: [] };

    try {
      const candidates = await this.db.transactionAsWorker((client) =>
        client.query<{ id: string; tenant_id: string; warehouse_id: string; ambiente: 'HOMOLOGACAO' | 'PRODUCAO'; address_state: string | null }>(
          `SELECT fi.id, fi.tenant_id, fi.warehouse_id, fi.ambiente, w.address_state
           FROM wms.fiscal_issuer fi JOIN wms.warehouse w ON w.id = fi.warehouse_id
           WHERE fi.transmission_mode = 'CONTINGENCIA_SVC'`
        )
      );

      const recovered: string[] = [];
      for (const issuer of candidates.rows) {
        const uf = issuer.address_state ?? 'SP';
        const available = await this.sefazClient.checkAvailability(uf, issuer.ambiente);
        if (!available) continue;

        const ctx: TenantContext = { tenant_id: issuer.tenant_id, user_id: SYSTEM_ACTOR, warehouse_id: issuer.warehouse_id };
        await this.db.query(
          ctx,
          `UPDATE wms.fiscal_issuer SET transmission_mode = 'NORMAL', consecutive_failures = 0, contingencia_since = NULL, updated_at = now()
           WHERE id = $1 AND transmission_mode = 'CONTINGENCIA_SVC'`,
          [issuer.id]
        );
        recovered.push(issuer.id);
        this.logger.log(`RNF-FIS-061: emitente ${issuer.id} normalizado (SEFAZ ${uf} disponível novamente)`);
      }

      return { ranAsLeader: true, recoveredIssuerIds: recovered };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
