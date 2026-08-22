// DOC-05 §4.7 RN-EST-062 [INVIOLÁVEL] — árvore de decisão das 3 rodadas de
// contagem. Inclui os DOIS exemplos normativos do §6 como teste de
// regressão permanente.
import { describe, expect, it } from 'vitest';
import { assertRoundIsExpected, evaluateCountRounds } from '../inventory-round-decision.util.js';

describe('evaluateCountRounds', () => {
  it('nenhuma rodada registrada -> aguarda a 1ª', () => {
    expect(evaluateCountRounds(100, [])).toEqual({ status: 'AWAITING_ROUND', nextRound: 1 });
  });

  it('1ª rodada bate com o sistema -> concluído sem ajuste', () => {
    const outcome = evaluateCountRounds(100, [{ roundNumber: 1, countedQty: 100, countedBy: 'joao' }]);
    expect(outcome).toEqual({ status: 'COMPLETED' });
  });

  it('1ª rodada diverge -> aguarda a 2ª, exige operador diferente', () => {
    const outcome = evaluateCountRounds(100, [{ roundNumber: 1, countedQty: 95, countedBy: 'joao' }]);
    expect(outcome).toEqual({ status: 'AWAITING_ROUND', nextRound: 2, requiresDifferentOperatorThan: 'joao' });
  });

  it('2ª rodada bate com o sistema -> concluído sem ajuste', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 100, countedBy: 'maria' },
    ]);
    expect(outcome).toEqual({ status: 'COMPLETED' });
  });

  it('exemplo normativo DOC-05 §6 — sistema 100, 1ª 95 (João), 2ª 95 (Maria) -> divergência confirmada de -5', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 95, countedBy: 'maria' },
    ]);
    expect(outcome).toEqual({ status: 'DIVERGENCE_CONFIRMED', divergence: -5 });
  });

  it('2ª rodada difere da 1ª e do sistema -> aguarda a 3ª, exige LIDER_TURNO', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 98, countedBy: 'maria' },
    ]);
    expect(outcome).toEqual({ status: 'AWAITING_ROUND', nextRound: 3, requiresRole: 'LIDER_TURNO' });
  });

  it('exemplo normativo DOC-05 §6 — sistema 100, 1ª 95, 2ª 98, 3ª (LIDER_TURNO) 98 -> divergência confirmada de -2', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 98, countedBy: 'maria' },
      { roundNumber: 3, countedQty: 98, countedBy: 'lider' },
    ]);
    expect(outcome).toEqual({ status: 'DIVERGENCE_CONFIRMED', divergence: -2 });
  });

  it('3ª rodada bate com o sistema mesmo divergindo de 1ª e 2ª -> concluído sem ajuste (resultado da 3ª prevalece)', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 98, countedBy: 'maria' },
      { roundNumber: 3, countedQty: 100, countedBy: 'lider' },
    ]);
    expect(outcome).toEqual({ status: 'COMPLETED' });
  });

  it('3ª rodada prevalece mesmo batendo com a 1ª (não com o sistema) -> divergência confirmada pelo valor da 3ª', () => {
    const outcome = evaluateCountRounds(100, [
      { roundNumber: 1, countedQty: 95, countedBy: 'joao' },
      { roundNumber: 2, countedQty: 98, countedBy: 'maria' },
      { roundNumber: 3, countedQty: 95, countedBy: 'lider' },
    ]);
    expect(outcome).toEqual({ status: 'DIVERGENCE_CONFIRMED', divergence: -5 });
  });
});

describe('assertRoundIsExpected', () => {
  it('aceita a 1ª rodada quando nenhuma existe', () => {
    expect(() => assertRoundIsExpected(100, [], 1, 'joao')).not.toThrow();
  });

  it('rejeita rodada fora de sequência', () => {
    expect(() => assertRoundIsExpected(100, [], 2, 'joao')).toThrow('UNEXPECTED_ROUND_NUMBER:1');
  });

  it('rejeita a 2ª rodada pelo MESMO operador da 1ª (RN-EST-062)', () => {
    const rounds = [{ roundNumber: 1 as const, countedQty: 95, countedBy: 'joao' }];
    expect(() => assertRoundIsExpected(100, rounds, 2, 'joao')).toThrow('SAME_OPERATOR_ROUND2');
  });

  it('aceita a 2ª rodada por operador diferente', () => {
    const rounds = [{ roundNumber: 1 as const, countedQty: 95, countedBy: 'joao' }];
    expect(() => assertRoundIsExpected(100, rounds, 2, 'maria')).not.toThrow();
  });

  it('rejeita nova rodada quando a célula já está resolvida (1ª bateu com o sistema)', () => {
    const rounds = [{ roundNumber: 1 as const, countedQty: 100, countedBy: 'joao' }];
    expect(() => assertRoundIsExpected(100, rounds, 2, 'maria')).toThrow('CELL_ALREADY_RESOLVED');
  });
});
