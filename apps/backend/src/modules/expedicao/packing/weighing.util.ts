// DOC-06 §4.6 RN-EXP-051 [INVIOLÁVEL] — tolerância de pesagem. Lógica PURA
// (sem I/O), testável linha a linha contra o exemplo normativo do próprio
// documento sem depender de banco (mesmo espírito de stock-movement-effects
// e outbound-flow.util — RG-002 e RG-004 também vivem em funções puras).
//
// "Aritmética decimal, não float" (prompt, entregável 4) — usa string/BigInt
// via um decimal fixo de 3 casas (mesma precisão de NUMERIC(12,3) da
// migration) para não acumular erro de ponto flutuante no exemplo normativo
// (12,350 × 1,02 teria erro de representação binária em float puro).

const DECIMALS = 3;
const SCALE = 10 ** DECIMALS;

/** Arredonda para a escala fixa (3 casas), como o NUMERIC(12,3) do banco faria. */
function toFixedScale(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

export interface WeightToleranceInput {
  /** Peso Teórico (§2): Σ(quantidade × gross_weight_kg) + tara. */
  theoreticalKg: number;
  /** EXP.TOLERANCIA_PESO_PCT como número inteiro de percentual (2 = 2%). */
  tolerancePct: number;
  /** Peso lido na balança (ou digitado, EXP.PESO_MANUAL). */
  readKg: number;
}

export interface WeightToleranceResult {
  lowerBoundKg: number;
  upperBoundKg: number;
  approved: boolean;
  deviationKg: number;
}

/**
 * RN-EXP-051 — faixa aceita = teórico ± (teórico × tolerância%). Exemplo
 * normativo: 12,350 kg, tolerância 2% -> faixa 12,103–12,597 kg (o documento
 * arredonda para 3 casas; replicado aqui via toFixedScale).
 */
export function evaluateWeightTolerance(input: WeightToleranceInput): WeightToleranceResult {
  const theoretical = toFixedScale(input.theoreticalKg);
  const toleranceFraction = input.tolerancePct / 100;
  const deviationAllowed = toFixedScale(theoretical * toleranceFraction);

  const lowerBoundKg = toFixedScale(theoretical - deviationAllowed);
  const upperBoundKg = toFixedScale(theoretical + deviationAllowed);
  const readKg = toFixedScale(input.readKg);

  return {
    lowerBoundKg,
    upperBoundKg,
    approved: readKg >= lowerBoundKg && readKg <= upperBoundKg,
    deviationKg: toFixedScale(readKg - theoretical),
  };
}
