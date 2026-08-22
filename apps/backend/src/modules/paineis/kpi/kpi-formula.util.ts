// DOC-10 §4.5 RN-PAI-041 [INVIOLÁVEL] — aritmética PURA compartilhada pelos
// KPIs percentuais (K-04, K-06, K-08, K-11, K-12, K-13). Mesmo espírito de
// stock-selection.util.ts (Sessão 5B): a fração é calculada em inteiros
// escalados, não em ponto flutuante direto, para não deixar o arredondamento
// depender da ordem das operações. Testado linha a linha contra o exemplo
// normativo do §4.5 antes de qualquer query ser escrita.

/**
 * Percentual com 1 casa decimal exata: numerador/denominador × 100,
 * arredondado ao décimo mais próximo. Denominador 0 → 0 (nenhum KPI desta
 * base divide por uma contagem negativa; ausência de base = 0%, não NaN).
 */
export function calculatePercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * RN-PAI-041 K-06 OTIF — "pedidos COMPLETOS (sem corte definitivo) E no
 * prazo (gate-out ≤ data prevista) ÷ K-05 × 100". completedOrders = K-05
 * (pedidos expedidos no período); onTimeNoCutOrders = subconjunto sem corte
 * E no prazo. Pedido com corte NÃO entra no numerador ainda que no prazo —
 * a exclusão é feita por quem monta a contagem (kpi-computation.service.ts),
 * não aqui; esta função só faz a razão.
 */
export function calculateOtifPercent(completedOrders: number, onTimeNoCutOrders: number): number {
  return calculatePercent(onTimeNoCutOrders, completedOrders);
}

/** RN-PAI-041 K-12 — "1 − |Σajustes| ÷ Σsaldo contado", mesma fórmula de RF-EST-064. */
export function calculateAccuracyPercent(totalDivergence: number, totalCounted: number): number {
  if (totalCounted <= 0) return 100;
  return calculatePercent(Math.max(totalCounted - Math.abs(totalDivergence), 0), totalCounted);
}

/** Média aritmética em horas decimais (RN-PAI-041 "períodos em horas decimais"). Vazio → 0, não NaN. */
export function averageHours(durationsMs: number[]): number {
  if (durationsMs.length === 0) return 0;
  const totalMs = durationsMs.reduce((sum, ms) => sum + ms, 0);
  const avgMs = totalMs / durationsMs.length;
  return Math.round((avgMs / 3_600_000) * 100) / 100;
}
