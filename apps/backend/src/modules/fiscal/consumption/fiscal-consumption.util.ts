// DOC-08 §4.4 RN-FIS-030 — Ordem de consumo fiscal. Lógica PURA (sem I/O),
// mesmo espírito de stock-selection.util.ts (DOC-05): o service carrega os
// saldos fiscais candidatos e chama isto, tornando a ordenação e a alocação
// auditáveis/testáveis linha a linha, sem depender de fixture de banco para
// provar o exemplo normativo.

/** RN-FIS-030 — catálogo FECHADO de ordens de consumo. */
export const FISCAL_CONSUMPTION_ORDERS = ['FIFO_EMISSAO', 'LIFO_EMISSAO', 'MANUAL'] as const;
export type FiscalConsumptionOrder = (typeof FISCAL_CONSUMPTION_ORDERS)[number];

export function isFiscalConsumptionOrder(value: string): value is FiscalConsumptionOrder {
  return (FISCAL_CONSUMPTION_ORDERS as readonly string[]).includes(value);
}

/**
 * Um saldo fiscal candidato — uma linha de wms.fiscal_stock_balance já
 * reduzida ao que a ordenação/alocação precisam. Montado por
 * FiscalConsumptionService a partir de fiscal_stock_balance JOIN
 * fiscal_document (para issued_at/internal_number).
 */
export interface FiscalConsumptionCandidate {
  fiscalStockBalanceId: string;
  /** fiscal_document.id da Nota de Armazenagem que gerou este crédito (storage_remittance_invoice_id). */
  storageFiscalDocumentId: string;
  /** fiscal_document.internal_number — desempate de RN-FIS-030 ("menor número da nota"). */
  internalNumber: string;
  /** fiscal_document.issued_at — ISO 8601. Base de FIFO_EMISSAO/LIFO_EMISSAO. */
  issuedAt: string;
  /** qty_credited - qty_consumed - qty_pending_writeoff (RD-FIS-005/RN-FIS-070). */
  qtyAvailable: number;
}

/** Compara strings ISO — lexicográfico é cronológico e exato para timestamps ISO 8601 com mesmo fuso. */
function compareIsoAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareInternalNumberAsc(a: FiscalConsumptionCandidate, b: FiscalConsumptionCandidate): number {
  return a.internalNumber < b.internalNumber ? -1 : a.internalNumber > b.internalNumber ? 1 : 0;
}

/**
 * RN-FIS-030 [INVIOLÁVEL na parte FIFO_EMISSAO/LIFO_EMISSAO — a alternativa
 * MANUAL não usa esta ordenação, o Fiscal escolhe as notas explicitamente]:
 * - FIFO_EMISSAO: "consome as Notas de Armazenagem por data de emissão
 *   crescente; desempate: menor número da nota";
 * - LIFO_EMISSAO: "data de emissão decrescente" (mesmo desempate, adotado
 *   por simetria — DOC-08 não repete o desempate para LIFO_EMISSAO
 *   explicitamente, [LACUNA: DOC-08] menor).
 *
 * Não muta a entrada.
 */
export function orderFiscalCandidatesByPolicy(
  candidates: FiscalConsumptionCandidate[],
  policy: Exclude<FiscalConsumptionOrder, 'MANUAL'>
): FiscalConsumptionCandidate[] {
  const directionAsc = policy === 'FIFO_EMISSAO';
  return [...candidates].sort((a, b) => {
    const issuedCompare = directionAsc ? compareIsoAsc(a.issuedAt, b.issuedAt) : -compareIsoAsc(a.issuedAt, b.issuedAt);
    if (issuedCompare !== 0) return issuedCompare;
    return compareInternalNumberAsc(a, b);
  });
}

export interface FiscalAllocationResult {
  candidate: FiscalConsumptionCandidate;
  qtyAllocated: number;
}

export interface FiscalSelectionResult {
  allocations: FiscalAllocationResult[];
  /** Quantidade que os candidatos NÃO cobrem (0 = demanda integralmente atendida). */
  shortfall: number;
  /** Soma de qtyAvailable de TODOS os candidatos recebidos, antes da alocação — usado na mensagem de rejeição (RG-014 item 4/exemplo normativo). */
  totalAvailable: number;
}

/**
 * Exemplo normativo (RG-014/RN-FIS-030, teste de regressão permanente):
 * notas 1000234 (2026-05-01, 500), 2356899 (2026-06-10, 100), 3216544
 * (2026-07-02, 400); demanda 700 UN em FIFO_EMISSAO → 500 de 1000234 + 100
 * de 2356899 + 100 de 3216544; saldos finais 0/0/300.
 *
 * Candidatos DEVEM chegar já ordenados por orderFiscalCandidatesByPolicy()
 * (ou pré-selecionados manualmente, para MANUAL).
 */
export function allocateFiscalDemand(orderedCandidates: FiscalConsumptionCandidate[], demandQty: number): FiscalSelectionResult {
  const allocations: FiscalAllocationResult[] = [];
  let remaining = demandQty;
  let totalAvailable = 0;

  for (const candidate of orderedCandidates) {
    totalAvailable += candidate.qtyAvailable;
    if (remaining <= 0) continue;
    const qtyAllocated = Math.min(remaining, candidate.qtyAvailable);
    if (qtyAllocated <= 0) continue;
    allocations.push({ candidate, qtyAllocated });
    remaining -= qtyAllocated;
  }

  return { allocations, shortfall: remaining > 0 ? remaining : 0, totalAvailable };
}
