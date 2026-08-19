// DOC-06 §4.6 RN-EXP-051 [INVIOLÁVEL] — teste de regressão PERMANENTE do
// exemplo normativo (prompt, entregável 4): "10 UN × 1,200 kg + tara 0,350 =
// 12,350 kg; tolerância 2% -> faixa 12,103-12,597; leitura 12,480 -> aprovado;
// 12,900 -> exceção."
import { describe, expect, it } from 'vitest';
import { evaluateWeightTolerance } from '../weighing.util.js';

describe('weighing.util — RN-EXP-051 (exemplo normativo)', () => {
  const theoreticalKg = 10 * 1.2 + 0.35; // 12.350

  it('calcula a faixa exata do exemplo normativo: 12,103-12,597', () => {
    const result = evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: theoreticalKg });
    expect(result.lowerBoundKg).toBeCloseTo(12.103, 3);
    expect(result.upperBoundKg).toBeCloseTo(12.597, 3);
  });

  it('12,480 kg é aprovado (dentro da faixa)', () => {
    const result = evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.48 });
    expect(result.approved).toBe(true);
  });

  it('12,900 kg abre exceção (fora da faixa)', () => {
    const result = evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.9 });
    expect(result.approved).toBe(false);
  });

  it('os limites da faixa são aprovados (inclusivos)', () => {
    expect(evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.103 }).approved).toBe(true);
    expect(evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.597 }).approved).toBe(true);
  });

  it('imediatamente fora dos limites é reprovado', () => {
    expect(evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.102 }).approved).toBe(false);
    expect(evaluateWeightTolerance({ theoreticalKg, tolerancePct: 2, readKg: 12.598 }).approved).toBe(false);
  });

  it('não acumula erro de ponto flutuante (aritmética decimal fixa)', () => {
    // 0.1 + 0.2 !== 0.3 em float puro — prova que a escala fixa evita isso.
    const result = evaluateWeightTolerance({ theoreticalKg: 0.3, tolerancePct: 10, readKg: 0.1 + 0.2 });
    expect(result.deviationKg).toBe(0);
    expect(result.approved).toBe(true);
  });
});
