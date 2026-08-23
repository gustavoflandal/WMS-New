// DOC-01 §4.6 RNF-ARQ-054 — função pura (sem IndexedDB/DOM), determinística.
import { describe, it, expect } from 'vitest';
import { evaluateQueueGate, queueGateMessage, MAX_QUEUE_SIZE } from '../queue-gate.js';

const NOW = new Date('2026-01-15T12:00:00Z').getTime();

describe('DOC-01 RNF-ARQ-054 — gate de bloqueio por limite de fila/tempo desde a sincronização', () => {
  it('não bloqueia com fila pequena e sincronização recente', () => {
    const result = evaluateQueueGate({ pendingCount: 3, lastSyncSuccessAt: new Date(NOW - 60_000).toISOString(), now: NOW });
    expect(result).toEqual({ blocked: false, reason: null });
  });

  it('Gherkin "Limite de fila bloqueia com clareza": com 500 já pendentes, a 501ª tentativa é bloqueada', () => {
    const at499 = evaluateQueueGate({ pendingCount: MAX_QUEUE_SIZE - 1, lastSyncSuccessAt: null, now: NOW });
    expect(at499.blocked).toBe(false);

    const at500 = evaluateQueueGate({ pendingCount: MAX_QUEUE_SIZE, lastSyncSuccessAt: null, now: NOW });
    expect(at500).toEqual({ blocked: true, reason: 'QUEUE_SIZE' });
  });

  it('bloqueia com mais de 8h desde a última sincronização bem-sucedida, mesmo com fila pequena', () => {
    const nineHoursAgo = new Date(NOW - 9 * 60 * 60 * 1000).toISOString();
    const result = evaluateQueueGate({ pendingCount: 1, lastSyncSuccessAt: nineHoursAgo, now: NOW });
    expect(result).toEqual({ blocked: true, reason: 'STALE_SYNC' });
  });

  it('exatamente 8h não bloqueia (limite é "mais de 8h")', () => {
    const eightHoursAgo = new Date(NOW - 8 * 60 * 60 * 1000).toISOString();
    const result = evaluateQueueGate({ pendingCount: 1, lastSyncSuccessAt: eightHoursAgo, now: NOW });
    expect(result.blocked).toBe(false);
  });

  it('nunca sincronizou (lastSyncSuccessAt null): só o limite de tamanho se aplica', () => {
    const result = evaluateQueueGate({ pendingCount: 10, lastSyncSuccessAt: null, now: NOW });
    expect(result).toEqual({ blocked: false, reason: null });
  });

  it('queueGateMessage: mensagem clara por motivo, null quando não bloqueado', () => {
    expect(queueGateMessage({ blocked: false, reason: null })).toBeNull();
    expect(queueGateMessage({ blocked: true, reason: 'QUEUE_SIZE' })).toMatch(/500/);
    expect(queueGateMessage({ blocked: true, reason: 'STALE_SYNC' })).toMatch(/8h/);
  });
});
