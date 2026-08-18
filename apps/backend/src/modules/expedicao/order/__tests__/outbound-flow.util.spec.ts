// DOC-06 §4.2/§4.8/§5.1 — regra PURA do Fluxo Operacional do pedido:
// as 8 etapas de RN-EXP-010 na ordem normativa, o mapa de estados, o estorno
// por etapa (RN-EXP-070) e as janelas de cancelamento (RN-EXP-071).
import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_FLOW_STEPS,
  OUTBOUND_ORDER_STATUSES,
  STEP_COMPLETION_STATUS,
  STEP_REVERSAL_EXCEPTION,
  cancellationWindow,
  deriveDisplayStatus,
  isReversalForbidden,
  previousStep,
} from '../outbound-flow.util.js';

describe('RN-EXP-010 [INVIOLÁVEL] — 8 etapas fixas na ordem do §4.2', () => {
  it('a ordem das etapas é EXATAMENTE a da tabela normativa', () => {
    expect(OUTBOUND_FLOW_STEPS).toEqual(['PEDIDO', 'PICKING', 'EMBALAGEM', 'PESAGEM', 'EXPEDICAO', 'CARREGAMENTO', 'SAIDA', 'FIM']);
    expect(OUTBOUND_FLOW_STEPS).toHaveLength(8);
  });

  it('cada etapa mapeia para o estado do pedido da última coluna da tabela', () => {
    expect(STEP_COMPLETION_STATUS).toEqual({
      PEDIDO: 'RELEASED',
      PICKING: 'PICKED',
      EMBALAGEM: 'PACKED',
      PESAGEM: 'WEIGHED',
      EXPEDICAO: 'IN_DISPATCH',
      CARREGAMENTO: 'LOADED',
      SAIDA: 'GATE_OUT',
      FIM: 'COMPLETED',
    });
  });

  it('todo estado de conclusão pertence ao catálogo canônico do §5.1 (REG-GLO-004: nenhum estado inventado)', () => {
    for (const status of Object.values(STEP_COMPLETION_STATUS)) {
      expect(OUTBOUND_ORDER_STATUSES).toContain(status);
    }
  });

  it('RELEASED_EXPIRED NÃO é estado persistido — é substado derivado de RELEASED (§5.1)', () => {
    expect(OUTBOUND_ORDER_STATUSES).not.toContain('RELEASED_EXPIRED' as never);
    expect(deriveDisplayStatus('RELEASED', true)).toBe('RELEASED_EXPIRED');
    expect(deriveDisplayStatus('RELEASED', false)).toBe('RELEASED');
    // A flag só tem efeito sobre RELEASED — nunca reescreve outro estado.
    expect(deriveDisplayStatus('IN_PICKING', true)).toBe('IN_PICKING');
  });

  it('previousStep devolve a etapa anterior (destino do estorno) e null na primeira', () => {
    expect(previousStep('PICKING')).toBe('PEDIDO');
    expect(previousStep('CARREGAMENTO')).toBe('EXPEDICAO');
    expect(previousStep('PEDIDO')).toBeNull();
  });
});

describe('RN-EXP-070 [INVIOLÁVEL] — estorno por etapa (§4.8)', () => {
  it('a exceção exigida por etapa é a da tabela do §4.8', () => {
    expect(STEP_REVERSAL_EXCEPTION.PICKING).toBe('EXP.ESTORNO_PICKING');
    expect(STEP_REVERSAL_EXCEPTION.EMBALAGEM).toBe('EXP.ESTORNO_PICKING');
    expect(STEP_REVERSAL_EXCEPTION.PESAGEM).toBeNull(); // "não exige exceção"
    expect(STEP_REVERSAL_EXCEPTION.EXPEDICAO).toBe('EXP.ESTORNO_POS_FISCAL');
    expect(STEP_REVERSAL_EXCEPTION.CARREGAMENTO).toBe('EXP.ESTORNO_POS_FISCAL');
  });

  it('estorno após gate-out é PROIBIDO — por etapa e por estado do pedido', () => {
    expect(isReversalForbidden('SAIDA', 'LOADED')).toBe(true);
    expect(isReversalForbidden('FIM', 'COMPLETED')).toBe(true);
    // Mesmo estornando uma etapa anterior, se o pedido já saiu é proibido.
    expect(isReversalForbidden('CARREGAMENTO', 'GATE_OUT')).toBe(true);
    expect(isReversalForbidden('CARREGAMENTO', 'COMPLETED')).toBe(true);
    // Antes da saída, a etapa é estornável.
    expect(isReversalForbidden('CARREGAMENTO', 'LOADED')).toBe(false);
    expect(isReversalForbidden('PICKING', 'IN_PICKING')).toBe(false);
  });
});

describe('RN-EXP-071 — janelas de cancelamento', () => {
  it('DRAFT/RELEASED cancelam direto', () => {
    expect(cancellationWindow('DRAFT')).toBe('DIRECT');
    expect(cancellationWindow('RELEASED')).toBe('DIRECT');
  });

  it('do picking iniciado até antes da emissão fiscal exige EXP.CANCELAMENTO_TARDIO', () => {
    for (const status of ['IN_PICKING', 'PICKED', 'IN_PACKING', 'PACKED', 'WEIGHED']) {
      expect(cancellationWindow(status)).toBe('LATE_REQUIRES_EXCEPTION');
    }
  });

  it('após emissão fiscal exige estorno pós-fiscal', () => {
    for (const status of ['IN_DISPATCH', 'IN_LOADING', 'LOADED']) {
      expect(cancellationWindow(status)).toBe('POST_FISCAL_REQUIRES_REVERSAL');
    }
  });

  it('após gate-out é proibido (DOC-07)', () => {
    expect(cancellationWindow('GATE_OUT')).toBe('FORBIDDEN');
    expect(cancellationWindow('COMPLETED')).toBe('FORBIDDEN');
    expect(cancellationWindow('CANCELLED')).toBe('FORBIDDEN');
  });

  it('todo estado canônico tem uma janela definida (nenhum estado sem decisão)', () => {
    for (const status of OUTBOUND_ORDER_STATUSES) {
      expect(['DIRECT', 'LATE_REQUIRES_EXCEPTION', 'POST_FISCAL_REQUIRES_REVERSAL', 'FORBIDDEN']).toContain(cancellationWindow(status));
    }
  });
});
