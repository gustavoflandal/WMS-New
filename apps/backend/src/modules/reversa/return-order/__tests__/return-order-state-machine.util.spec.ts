import { describe, expect, it } from 'vitest';
import { InvalidReturnOrderTransitionError, resolveReturnOrderTransition } from '../return-order-state-machine.util.js';

describe('DOC-07 §5.1 — return_order state machine', () => {
  it('percorre o ciclo feliz completo', () => {
    expect(resolveReturnOrderTransition('REQUESTED', 'AUTORIZAR')).toBe('AUTHORIZED');
    expect(resolveReturnOrderTransition('AUTHORIZED', 'CHEGADA_VINCULADA')).toBe('IN_RECEIPT');
    expect(resolveReturnOrderTransition('IN_RECEIPT', 'DESCARGA_CONCLUIDA')).toBe('IN_TRIAGE');
    expect(resolveReturnOrderTransition('IN_TRIAGE', 'TRIAGEM_COMPLETA')).toBe('IN_DISPOSITION');
    expect(resolveReturnOrderTransition('IN_DISPOSITION', 'DESTINACOES_EFETIVADAS')).toBe('COMPLETED');
  });

  it('nega a partir de REQUESTED', () => {
    expect(resolveReturnOrderTransition('REQUESTED', 'NEGAR')).toBe('DENIED');
  });

  it('cancela a partir de AUTHORIZED (antes da chegada)', () => {
    expect(resolveReturnOrderTransition('AUTHORIZED', 'CANCELAR')).toBe('CANCELLED');
  });

  it('rejeita transição não prevista no diagrama', () => {
    expect(() => resolveReturnOrderTransition('COMPLETED', 'AUTORIZAR')).toThrow(InvalidReturnOrderTransitionError);
    expect(() => resolveReturnOrderTransition('IN_TRIAGE', 'CANCELAR')).toThrow(InvalidReturnOrderTransitionError);
    expect(() => resolveReturnOrderTransition('DENIED', 'AUTORIZAR')).toThrow(InvalidReturnOrderTransitionError);
  });
});
