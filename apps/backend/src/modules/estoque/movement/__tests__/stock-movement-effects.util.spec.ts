// Entregável 7 (Sessão 5A) — "teste parametrizado provando que cada um dos
// tipos de movement_type produz o efeito EXATO de partição" (RN-EST-001,
// DOC-05 §4.1). Cobre os 18 códigos do catálogo fechado.
import { describe, expect, it } from 'vitest';
import { MOVEMENT_TYPES, MovementType, resolveMovementBucketEffect } from '../stock-movement-effects.util.js';

describe('resolveMovementBucketEffect - RN-EST-001 catálogo fechado (18 tipos)', () => {
  it('catálogo tem exatamente 18 códigos distintos', () => {
    expect(new Set(MOVEMENT_TYPES).size).toBe(18);
    expect(MOVEMENT_TYPES.length).toBe(18);
  });

  const fixedCases: Array<[MovementType, { bucketFrom: string | null; bucketTo: string | null }]> = [
    ['RESERVA', { bucketFrom: 'AVAILABLE', bucketTo: 'RESERVED' }],
    ['LIBERACAO_RESERVA', { bucketFrom: 'RESERVED', bucketTo: 'AVAILABLE' }],
    ['PICKING', { bucketFrom: 'RESERVED', bucketTo: null }],
    ['TRANSFERENCIA_SAIDA_ARMAZEM', { bucketFrom: 'AVAILABLE', bucketTo: 'IN_TRANSIT' }],
    ['BLOQUEIO', { bucketFrom: 'AVAILABLE', bucketTo: 'BLOCKED' }],
    ['DESBLOQUEIO', { bucketFrom: 'BLOCKED', bucketTo: 'AVAILABLE' }],
    ['LIBERACAO_QUARENTENA', { bucketFrom: 'QUARANTINE', bucketTo: 'AVAILABLE' }],
  ];

  it.each(fixedCases)('%s tem efeito fixo %j (ignora override)', (movementType, expected) => {
    expect(resolveMovementBucketEffect(movementType)).toEqual(expected);
    // Override não muda nada em tipo fixo — o catálogo é fechado.
    expect(resolveMovementBucketEffect(movementType, { bucketFrom: 'DAMAGED', bucketTo: 'DAMAGED' })).toEqual(expected);
  });

  it('PUTAWAY / TRANSFERENCIA_INTERNA / REPOSICAO: mesma parcela nos dois lados, escolhida pelo chamador', () => {
    for (const movementType of ['PUTAWAY', 'TRANSFERENCIA_INTERNA', 'REPOSICAO'] as MovementType[]) {
      expect(resolveMovementBucketEffect(movementType, { bucketFrom: 'AVAILABLE' })).toEqual({ bucketFrom: 'AVAILABLE', bucketTo: 'AVAILABLE' });
      expect(resolveMovementBucketEffect(movementType, { bucketFrom: 'QUARANTINE' })).toEqual({ bucketFrom: 'QUARANTINE', bucketTo: 'QUARANTINE' });
      expect(() => resolveMovementBucketEffect(movementType)).toThrow();
    }
  });

  it('ENTRADA_RECEBIMENTO: crédito puro, bucketTo obrigatório (DOC-04 decide o destino)', () => {
    expect(resolveMovementBucketEffect('ENTRADA_RECEBIMENTO', { bucketTo: 'AVAILABLE' })).toEqual({ bucketFrom: null, bucketTo: 'AVAILABLE' });
    expect(resolveMovementBucketEffect('ENTRADA_RECEBIMENTO', { bucketTo: 'QUARANTINE' })).toEqual({ bucketFrom: null, bucketTo: 'QUARANTINE' });
    expect(() => resolveMovementBucketEffect('ENTRADA_RECEBIMENTO')).toThrow();
  });

  it('ENTRADA_REVERSA: crédito puro, bucketTo obrigatório (triagem DOC-07)', () => {
    expect(resolveMovementBucketEffect('ENTRADA_REVERSA', { bucketTo: 'QUARANTINE' })).toEqual({ bucketFrom: null, bucketTo: 'QUARANTINE' });
    expect(() => resolveMovementBucketEffect('ENTRADA_REVERSA')).toThrow();
  });

  it('TRANSFERENCIA_ENTRADA_ARMAZEM: sempre limpa IN_TRANSIT de origem, bucketTo obrigatório', () => {
    expect(resolveMovementBucketEffect('TRANSFERENCIA_ENTRADA_ARMAZEM', { bucketTo: 'AVAILABLE' })).toEqual({
      bucketFrom: 'IN_TRANSIT',
      bucketTo: 'AVAILABLE',
    });
    expect(() => resolveMovementBucketEffect('TRANSFERENCIA_ENTRADA_ARMAZEM')).toThrow();
  });

  it('RECLASSIFICACAO_AVARIA: bucketTo sempre DAMAGED, bucketFrom obrigatório', () => {
    expect(resolveMovementBucketEffect('RECLASSIFICACAO_AVARIA', { bucketFrom: 'AVAILABLE' })).toEqual({ bucketFrom: 'AVAILABLE', bucketTo: 'DAMAGED' });
    expect(resolveMovementBucketEffect('RECLASSIFICACAO_AVARIA', { bucketFrom: 'BLOCKED' })).toEqual({ bucketFrom: 'BLOCKED', bucketTo: 'DAMAGED' });
    expect(() => resolveMovementBucketEffect('RECLASSIFICACAO_AVARIA')).toThrow();
  });

  it('AJUSTE_INVENTARIO_POS/NEG: crédito/débito em AVAILABLE por padrão', () => {
    expect(resolveMovementBucketEffect('AJUSTE_INVENTARIO_POS')).toEqual({ bucketFrom: null, bucketTo: 'AVAILABLE' });
    expect(resolveMovementBucketEffect('AJUSTE_INVENTARIO_NEG')).toEqual({ bucketFrom: 'AVAILABLE', bucketTo: null });
  });

  it('DESCARTE: débito puro, bucketFrom obrigatório (damaged/blocked)', () => {
    expect(resolveMovementBucketEffect('DESCARTE', { bucketFrom: 'DAMAGED' })).toEqual({ bucketFrom: 'DAMAGED', bucketTo: null });
    expect(resolveMovementBucketEffect('DESCARTE', { bucketFrom: 'BLOCKED' })).toEqual({ bucketFrom: 'BLOCKED', bucketTo: null });
    expect(() => resolveMovementBucketEffect('DESCARTE')).toThrow();
  });

  it('SAIDA_EXPEDICAO: débito de RESERVED por padrão (DOC-06)', () => {
    expect(resolveMovementBucketEffect('SAIDA_EXPEDICAO')).toEqual({ bucketFrom: 'RESERVED', bucketTo: null });
    expect(resolveMovementBucketEffect('SAIDA_EXPEDICAO', { bucketFrom: 'AVAILABLE' })).toEqual({ bucketFrom: 'AVAILABLE', bucketTo: null });
  });

  it('todo tipo do catálogo é reconhecido pelo resolver (nenhum cai no default)', () => {
    for (const movementType of MOVEMENT_TYPES) {
      expect(() => resolveMovementBucketEffect(movementType, { bucketFrom: 'AVAILABLE', bucketTo: 'AVAILABLE' })).not.toThrow();
    }
  });
});
