// DOC-10 §4.5 RN-PAI-041 [INVIOLÁVEL] — exemplo normativo K-06 OTIF como
// teste de regressão permanente: 40 pedidos concluídos, 32 sem corte
// definitivo, 30 destes no prazo → 75,0% (pedido com corte não entra no
// numerador ainda que no prazo). Valor imutável.
import { describe, expect, it } from 'vitest';
import { calculateAccuracyPercent, calculateOtifPercent, calculatePercent, averageHours } from '../kpi-formula.util.js';

describe('calculateOtifPercent', () => {
  it('exemplo normativo §4.5 — 40 concluídos, 32 sem corte, 30 no prazo -> 75,0%', () => {
    expect(calculateOtifPercent(40, 30)).toBe(75.0);
  });

  it('0 pedidos concluídos no período -> 0%, não NaN', () => {
    expect(calculateOtifPercent(0, 0)).toBe(0);
  });

  it('100% quando todos concluídos estão sem corte e no prazo', () => {
    expect(calculateOtifPercent(10, 10)).toBe(100);
  });

  it('arredonda ao décimo mais próximo (1/3 -> 33,3%)', () => {
    expect(calculateOtifPercent(3, 1)).toBe(33.3);
  });
});

describe('calculatePercent', () => {
  it('denominador 0 -> 0, não Infinity/NaN', () => {
    expect(calculatePercent(5, 0)).toBe(0);
  });

  it('numerador 0 -> 0%', () => {
    expect(calculatePercent(0, 40)).toBe(0);
  });
});

describe('calculateAccuracyPercent (K-12, mesma fórmula de RF-EST-064)', () => {
  it('sem divergência -> 100%', () => {
    expect(calculateAccuracyPercent(0, 200)).toBe(100);
  });

  it('divergência de 5 sobre 100 contados -> 95,0%', () => {
    expect(calculateAccuracyPercent(5, 100)).toBe(95.0);
  });

  it('divergência negativa usa valor absoluto', () => {
    expect(calculateAccuracyPercent(-5, 100)).toBe(95.0);
  });

  it('nenhum endereço contado -> 100% (sem base para divergir)', () => {
    expect(calculateAccuracyPercent(0, 0)).toBe(100);
  });
});

describe('averageHours', () => {
  it('lista vazia -> 0, não NaN', () => {
    expect(averageHours([])).toBe(0);
  });

  it('converte ms para horas decimais com 2 casas', () => {
    expect(averageHours([3_600_000, 7_200_000])).toBe(1.5);
  });
});
