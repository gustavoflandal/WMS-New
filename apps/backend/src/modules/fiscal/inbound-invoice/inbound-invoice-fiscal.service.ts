// DOC-08 §4.2 RN-FIS-010 — controle do prazo de regularização fiscal. A NF
// de entrada (wms.inbound_invoice, DOC-04 migration 0036) e seu prazo
// (regularization_deadline) já existem — este serviço é o CONTROLE do
// prazo que DOC-04 deixou como [LACUNA: DOC-08 não existe nesta sessão]:
// alertas 50/80/100% (worker do scheduler) e a checagem "prazo expirado sem
// Nota de Armazenagem cobrindo" usada por OutboundOrderService.release()
// (RN-EXP-002 item 2 / RN-FIS-010 item 2 — bloqueio de SAÍDA fiscal).
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AlertService } from '../../paineis/alertas/alert.service.js';

const DEFAULT_ALERT_PERCENTAGES = [50, 80, 100];

export interface DeadlineCheckResult {
  alertedInvoiceIds: string[];
  expiredInvoiceIds: string[];
}

@Injectable()
export class InboundInvoiceFiscalService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AlertService) private readonly alertService: AlertService
  ) {}

  /**
   * RN-EXP-002 item 2 / RN-FIS-010 item 2 — "novas LIBERAÇÕES de pedido
   * contendo produtos com quantidade descoberta DAQUELE cliente ficam
   * bloqueadas... com mensagem específica de prazo expirado". Roda DENTRO
   * da transação/contexto de tenant já aberta pelo chamador (release()).
   *
   * "Descoberta" = existe ao menos 1 NF de entrada, com prazo VENCIDO, cuja
   * quantidade recebida do produto ainda não foi integralmente coberta por
   * Nota(s) de Armazenagem que a referenciam.
   */
  async hasExpiredUncoveredDeadline(client: PoolClient, tenantId: string, warehouseId: string, productId: string, todayIsoDate: string): Promise<boolean> {
    const result = await client.query(
      `SELECT ii.id
       FROM wms.inbound_invoice ii
       JOIN wms.inbound_order_item ioi ON ioi.inbound_order_id = ii.inbound_order_id AND ioi.product_id = $3
       WHERE ii.tenant_id = $1 AND ii.warehouse_id = $2 AND ii.regularization_deadline < $4::date
       GROUP BY ii.id
       HAVING SUM(ioi.qty_received) > COALESCE((
         SELECT SUM(fdi.qty) FROM wms.fiscal_document_item fdi
         JOIN wms.fiscal_document fd ON fd.id = fdi.fiscal_document_id
         WHERE fd.document_type = 'NOTA_ARMAZENAGEM' AND fdi.reference_inbound_invoice_id = ii.id AND fdi.product_id = $3
       ), 0)
       LIMIT 1`,
      [tenantId, warehouseId, productId, todayIsoDate]
    );
    return result.rows.length > 0;
  }

  /**
   * Job do scheduler (RN-FIS-010: "o scheduler DEVE emitir alertas... em
   * 50%, 80% e 100% do prazo"). Cross-tenant via transactionAsWorker, mesmo
   * padrão de ExpirationAlertWorkerImpl/CrossDockAgingWorkerImpl.
   */
  async checkDeadlines(referenceDate: Date = new Date()): Promise<DeadlineCheckResult> {
    const percentages = await this.resolveAlertPercentages();
    const today = referenceDate.toISOString().slice(0, 10);

    return this.db.transactionAsWorker(async (client) => {
      const alertedInvoiceIds = await this.alertApproaching(client, percentages, today);
      const expiredInvoiceIds = await this.alertExpired(client, today);
      return { alertedInvoiceIds, expiredInvoiceIds };
    });
  }

  private async resolveAlertPercentages(): Promise<number[]> {
    const result = await this.db.queryGlobal<{ value: string }>(
      `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'FIS.ALERTA_PRAZO_PERCENTUAIS'`
    );
    const raw = result.rows[0]?.value;
    if (!raw) return DEFAULT_ALERT_PERCENTAGES;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed;
    } catch {
      // valor mal formado — cai para o default.
    }
    return DEFAULT_ALERT_PERCENTAGES;
  }

  /**
   * Aritmética INTEIRA (dias), sem ponto flutuante: percentualElapsed =
   * FLOOR(diasDecorridos * 100 / diasTotais). Um match exato do percentual
   * do dia contra a lista configurada dispara o alerta daquele dia (mesmo
   * espírito de ExpirationService: "(expiration_date - today) = ANY(alertDays)").
   * Só considera invoices ainda NÃO integralmente cobertas (RN-FIS-010 só
   * faz sentido para NF de entrada com pendência real).
   */
  private async alertApproaching(client: PoolClient, percentages: number[], today: string): Promise<string[]> {
    if (percentages.length === 0) return [];
    const result = await client.query<{ id: string; tenant_id: string; warehouse_id: string; access_key: string }>(
      `SELECT ii.id, ii.tenant_id, ii.warehouse_id, ii.access_key
       FROM wms.inbound_invoice ii
       WHERE ii.regularization_deadline >= $1::date
         AND FLOOR((($1::date - ii.created_at::date) * 100.0) / GREATEST(ii.regularization_deadline - ii.created_at::date, 1)) = ANY($2::int[])`,
      [today, percentages]
    );

    const alerted: string[] = [];
    for (const row of result.rows) {
      await this.alertService.create({
        tenantId: row.tenant_id,
        warehouseId: row.warehouse_id,
        severity: 'WARN',
        alertType: 'PRAZO_FISCAL_EXPIRADO',
        title: `Prazo de regularização fiscal se aproximando — NF ${row.access_key}`,
        message: `RN-FIS-010: a NF de entrada ${row.access_key} se aproxima do prazo de regularização fiscal.`,
        sourceEntity: 'inbound_invoice',
        sourceEntityId: row.id,
      });
      alerted.push(row.id);
    }
    return alerted;
  }

  /** RN-FIS-010 item 3 — "item de painel CRIT é criado" para prazo já vencido. */
  private async alertExpired(client: PoolClient, today: string): Promise<string[]> {
    const result = await client.query<{ id: string; tenant_id: string; warehouse_id: string; access_key: string }>(
      `SELECT ii.id, ii.tenant_id, ii.warehouse_id, ii.access_key
       FROM wms.inbound_invoice ii
       WHERE ii.regularization_deadline < $1::date`,
      [today]
    );

    const expired: string[] = [];
    for (const row of result.rows) {
      const { created } = await this.alertService.create({
        tenantId: row.tenant_id,
        warehouseId: row.warehouse_id,
        severity: 'CRIT',
        alertType: 'PRAZO_FISCAL_EXPIRADO',
        title: `Prazo de regularização fiscal expirado — NF ${row.access_key}`,
        message: `RN-FIS-010: prazo de regularização fiscal expirado sem Nota de Armazenagem cobrindo a NF de entrada ${row.access_key}.`,
        sourceEntity: 'inbound_invoice',
        sourceEntityId: row.id,
      });
      if (created) expired.push(row.id);
    }
    return expired;
  }
}
