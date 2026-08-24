// DOC-08 §4.4 RN-FIS-030 — Ordem de consumo fiscal. Carrega os candidatos
// (join fiscal_stock_balance × fiscal_document) e delega a ordenação/
// alocação para a função pura (fiscal-consumption.util.ts), mesma separação
// I/O × regra pura já estabelecida em stock-selection.service.ts (DOC-05).
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import {
  FiscalConsumptionCandidate,
  FiscalConsumptionOrder,
  FiscalSelectionResult,
  allocateFiscalDemand,
  isFiscalConsumptionOrder,
  orderFiscalCandidatesByPolicy,
} from './fiscal-consumption.util.js';

const DEFAULT_ORDER: FiscalConsumptionOrder = 'FIFO_EMISSAO';

export interface SelectFiscalConsumptionInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  demandQty: number;
  /** RN-FIS-030 MANUAL: notas pré-selecionadas pelo Fiscal (mediante exceção FIS.CONSUMO_MANUAL), na ordem desejada. */
  manualFiscalDocumentIds?: string[];
}

@Injectable()
export class FiscalConsumptionService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * RN-FIS-030 — resolve `FIS.ORDEM_CONSUMO` por cliente × armazém
   * (app_parameter escopo CLIENT_WAREHOUSE), com fallback ao padrão de
   * instalação GLOBAL (decisão desta sessão, ver migration 0069 e o
   * relatório: NÃO é coluna nova em client_warehouse_settings — só é lida
   * na montagem da Nota de Devolução, não é caminho quente).
   */
  async resolveConsumptionOrder(client: PoolClient, tenantId: string, warehouseId: string): Promise<FiscalConsumptionOrder> {
    const specific = await client.query<{ value: string }>(
      `SELECT value FROM wms.app_parameter WHERE scope = 'CLIENT_WAREHOUSE' AND name = 'FIS.ORDEM_CONSUMO' AND warehouse_id = $1 AND client_id = $2`,
      [warehouseId, tenantId]
    );
    const raw = specific.rows[0]?.value ?? (await this.loadGlobalDefault(client));
    if (raw && isFiscalConsumptionOrder(raw)) return raw;
    return DEFAULT_ORDER;
  }

  private async loadGlobalDefault(client: PoolClient): Promise<string | undefined> {
    const result = await client.query<{ value: string }>(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'FIS.ORDEM_CONSUMO'`);
    return result.rows[0]?.value;
  }

  private async loadCandidates(client: PoolClient, tenantId: string, warehouseId: string, productId: string): Promise<FiscalConsumptionCandidate[]> {
    const result = await client.query<{
      id: string;
      storage_fiscal_document_id: string;
      internal_number: string;
      issued_at: string;
      available: string;
    }>(
      `SELECT fsb.id, fsb.storage_remittance_invoice_id AS storage_fiscal_document_id, fd.internal_number, fd.issued_at,
              (fsb.qty_credited - fsb.qty_consumed - fsb.qty_pending_writeoff) AS available
       FROM wms.fiscal_stock_balance fsb
       JOIN wms.fiscal_document fd ON fd.id = fsb.storage_remittance_invoice_id
       WHERE fsb.tenant_id = $1 AND fsb.warehouse_id = $2 AND fsb.product_id = $3
         AND (fsb.qty_credited - fsb.qty_consumed - fsb.qty_pending_writeoff) > 0`,
      [tenantId, warehouseId, productId]
    );
    return result.rows.map((row) => ({
      fiscalStockBalanceId: row.id,
      storageFiscalDocumentId: row.storage_fiscal_document_id,
      internalNumber: row.internal_number,
      issuedAt: row.issued_at,
      qtyAvailable: Number(row.available),
    }));
  }

  /**
   * RG-014/RN-FIS-030 — seleciona as notas de armazenagem que cobrem
   * `demandQty` do produto, na ordem configurada. Não grava efeito nenhum
   * (o consumo só é efetivado na autorização — RN-FIS-040); só lê e aloca
   * em memória, dentro da MESMA transação do chamador (StorageReturnInvoiceService).
   */
  async selectForConsumption(client: PoolClient, input: SelectFiscalConsumptionInput): Promise<FiscalSelectionResult & { order: FiscalConsumptionOrder }> {
    const candidates = await this.loadCandidates(client, input.tenantId, input.warehouseId, input.productId);

    if (input.manualFiscalDocumentIds && input.manualFiscalDocumentIds.length > 0) {
      const byDocId = new Map(candidates.map((c) => [c.storageFiscalDocumentId, c]));
      const manualOrdered: FiscalConsumptionCandidate[] = [];
      for (const docId of input.manualFiscalDocumentIds) {
        const candidate = byDocId.get(docId);
        if (!candidate) {
          throw new BadRequestException({
            error: 'MANUAL_FISCAL_DOCUMENT_NOT_AVAILABLE',
            detail: `RN-FIS-030: nota ${docId} não tem saldo fiscal disponível para o produto ${input.productId}`,
          });
        }
        manualOrdered.push(candidate);
      }
      const result = allocateFiscalDemand(manualOrdered, input.demandQty);
      return { ...result, order: 'MANUAL' };
    }

    const order = await this.resolveConsumptionOrder(client, input.tenantId, input.warehouseId);
    if (order === 'MANUAL') {
      throw new BadRequestException({
        error: 'FIS_CONSUMO_MANUAL_SELECTION_REQUIRED',
        detail: `RN-FIS-030: FIS.ORDEM_CONSUMO=MANUAL para este cliente × armazém exige seleção explícita de notas (manualFiscalDocumentIds)`,
      });
    }
    const ordered = orderFiscalCandidatesByPolicy(candidates, order);
    const result = allocateFiscalDemand(ordered, input.demandQty);
    return { ...result, order };
  }
}
