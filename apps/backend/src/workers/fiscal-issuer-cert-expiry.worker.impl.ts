// DOC-08 §4.7 RNF-FIS-063 — alerta de expiração de certificado A1 em
// 30/15/7 dias. Eleição de líder via lock Redis (mesmo padrão de
// InboundInvoiceDeadlineWorkerImpl). Perfil `scheduler`.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { DatabaseService } from '../core/database/database.service.js';
import { AlertService } from '../modules/paineis/alertas/alert.service.js';

export interface FiscalIssuerCertExpiryWorkerOptions {
  pollIntervalMs?: number;
}

const LOCK_RESOURCE = 'fiscal-issuer-cert-expiry:fiscal';
const LOCK_TIMEOUT_MS = 30000;
const ALERT_DAYS_THRESHOLDS = [30, 15, 7];

export class FiscalIssuerCertExpiryWorkerImpl {
  private readonly logger = new Logger(FiscalIssuerCertExpiryWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(private readonly db: DatabaseService, private readonly alertService: AlertService, private readonly cacheService: CacheService, options: FiscalIssuerCertExpiryWorkerOptions = {}) {
    // RNF-FIS-063 não especifica cadência — mesmo raciocínio diário de RN-FIS-010.
    this.pollIntervalMs = options.pollIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Fiscal issuer cert expiry worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Fiscal issuer cert expiry run error', error as Error);
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
    this.logger.log('Fiscal issuer cert expiry worker stopped');
  }

  async runOnce(referenceDate: Date = new Date()): Promise<{ ranAsLeader: boolean; alertedIssuerIds: string[] }> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) return { ranAsLeader: false, alertedIssuerIds: [] };

    try {
      const today = referenceDate.toISOString().slice(0, 10);
      const result = await this.db.transactionAsWorker((client) =>
        client.query<{ id: string; tenant_id: string; warehouse_id: string; cnpj: string; cert_expires_at: string }>(
          `SELECT id, tenant_id, warehouse_id, cnpj, cert_expires_at FROM wms.fiscal_issuer
           WHERE cert_expires_at IS NOT NULL AND (cert_expires_at::date - $1::date) = ANY($2::int[])`,
          [today, ALERT_DAYS_THRESHOLDS]
        )
      );

      const alerted: string[] = [];
      for (const row of result.rows) {
        const daysLeft = Math.round((new Date(row.cert_expires_at).getTime() - referenceDate.getTime()) / 86_400_000);
        await this.alertService.create({
          tenantId: row.tenant_id,
          warehouseId: row.warehouse_id,
          severity: daysLeft <= 7 ? 'CRIT' : 'WARN',
          alertType: 'CERTIFICADO_FISCAL_EXPIRANDO',
          title: `Certificado A1 expirando — ${row.cnpj}`,
          message: `RNF-FIS-063: o certificado A1 do emitente ${row.cnpj} expira em ${daysLeft} dia(s).`,
          sourceEntity: 'fiscal_issuer',
          sourceEntityId: row.id,
        });
        alerted.push(row.id);
      }
      return { ranAsLeader: true, alertedIssuerIds: alerted };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
