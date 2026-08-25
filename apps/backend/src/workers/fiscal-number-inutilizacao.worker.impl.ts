// DOC-08 §4.7 RNF-FIS-060 — inutilização mensal de números de NF-e pulados
// por falha. Escopo desta sessão: documentos em DENIED (§5.1 "número
// consumido, pedido bloqueado p/ tratamento" — o único estado em que o
// DOC-08 afirma textualmente que o número foi consumido sem nunca ter sido
// autorizado). Documentos DRAFT/SIGNED/TRANSMITTED "presos" indefinidamente
// não têm limiar de abandono definido pelo DOC-08 — [LACUNA: DOC-08] não
// tratado por este worker, registrado aqui em vez de inventar um prazo.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { DatabaseService, TenantContext } from '../core/database/database.service.js';
import { FileStorageService } from '../core/storage/file-storage.service.js';

export interface FiscalNumberInutilizacaoWorkerOptions {
  pollIntervalMs?: number;
}

const LOCK_RESOURCE = 'fiscal-number-inutilizacao:fiscal';
const LOCK_TIMEOUT_MS = 30000;
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export class FiscalNumberInutilizacaoWorkerImpl {
  private readonly logger = new Logger(FiscalNumberInutilizacaoWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly fileStorageService: FileStorageService,
    private readonly cacheService: CacheService,
    options: FiscalNumberInutilizacaoWorkerOptions = {}
  ) {
    // RNF-FIS-060: "scheduler mensal" — configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Fiscal number inutilização worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Fiscal number inutilização run error', error as Error);
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
    this.logger.log('Fiscal number inutilização worker stopped');
  }

  async runOnce(): Promise<{ ranAsLeader: boolean; inutilizedDocumentIds: string[] }> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) return { ranAsLeader: false, inutilizedDocumentIds: [] };

    try {
      const candidates = await this.db.transactionAsWorker((client) =>
        client.query<{ id: string; tenant_id: string; warehouse_id: string; nfe_number: number; nfe_serie: number; fiscal_issuer_id: string }>(
          `SELECT fd.id, fd.tenant_id, fd.warehouse_id, fd.nfe_number, fd.nfe_serie, fd.fiscal_issuer_id
           FROM wms.fiscal_document fd
           WHERE fd.status = 'DENIED' AND fd.nfe_number IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM wms.fiscal_document_event e WHERE e.fiscal_document_id = fd.id AND e.event_type = 'INUTILIZACAO')`
        )
      );

      const inutilized: string[] = [];
      for (const doc of candidates.rows) {
        const ctx: TenantContext = { tenant_id: doc.tenant_id, user_id: SYSTEM_ACTOR, warehouse_id: doc.warehouse_id };
        const eventXml = `<inutilizacao fiscalDocumentId="${doc.id}" nNF="${doc.nfe_number}" serie="${doc.nfe_serie}" at="${new Date().toISOString()}"/>`;
        const xmlStorageKey = await this.fileStorageService.upload('fiscal_document_event', doc.id, 'inutilizacao.xml', 'text/xml', Buffer.from(eventXml));

        await this.db.query(
          ctx,
          `INSERT INTO wms.fiscal_document_event (tenant_id, fiscal_document_id, event_type, xml_storage_key, reason, created_by)
           VALUES ($1,$2,'INUTILIZACAO',$3,$4,$5)`,
          [doc.tenant_id, doc.id, xmlStorageKey, `RNF-FIS-060: numeração ${doc.nfe_serie}/${doc.nfe_number} inutilizada — nota DENIED sem autorização`, SYSTEM_ACTOR]
        );
        inutilized.push(doc.id);
        this.logger.log(`RNF-FIS-060: número ${doc.nfe_serie}/${doc.nfe_number} (fiscal_document ${doc.id}) inutilizado`);
      }

      return { ranAsLeader: true, inutilizedDocumentIds: inutilized };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  /**
   * `setTimeout` só aceita até 2^31-1 ms (~24,8 dias) — um `ms` maior
   * "estoura" silenciosamente e o Node dispara em ~1ms (achado real ao
   * verificar via `docker compose up`: o default de 30 dias deste worker
   * mensal caía num loop apertado, gerando um `TimeoutOverflowWarning` e
   * centenas de tentativas por segundo). Encadeia esperas menores até
   * completar `ms`.
   */
  private async sleep(ms: number): Promise<void> {
    const MAX_TIMEOUT_MS = 2 ** 31 - 1;
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, chunk));
      remaining -= chunk;
    }
  }
}
