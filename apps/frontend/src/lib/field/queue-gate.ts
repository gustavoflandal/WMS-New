// DOC-01 §4.6 RNF-ARQ-054 — "SE a fila local exceder 500 operações OU 8h
// desde a sincronização bem-sucedida, ENTÃO o PWA DEVE bloquear novas
// execuções offline até sincronizar, preservando a fila existente." Função
// PURA (sem IndexedDB/DOM) para teste determinístico — quem chama decide de
// onde vêm `pendingCount`/`lastSyncSuccessAt` (sync-queue-store.ts/field-db.ts).
export const MAX_QUEUE_SIZE = 500;
export const MAX_HOURS_SINCE_SYNC = 8;

export interface QueueGateInput {
  /** Operações já na fila LOCAL_PENDENTE ANTES da tentativa de confirmar uma nova. */
  pendingCount: number;
  lastSyncSuccessAt: string | null;
  now?: number;
}

export type QueueGateReason = 'QUEUE_SIZE' | 'STALE_SYNC';

export interface QueueGateResult {
  blocked: boolean;
  reason: QueueGateReason | null;
}

/**
 * Bloqueia a PRÓXIMA confirmação (não a sincronização da fila existente,
 * RNF-ARQ-054 é explícito: "preservando a fila existente"). Gherkin (DOC-15
 * §6): com 500 operações já pendentes, a 501ª tentativa é bloqueada — o
 * limiar é "pendingCount já em 500", não "depois de passar de 500".
 */
export function evaluateQueueGate(input: QueueGateInput): QueueGateResult {
  if (input.pendingCount >= MAX_QUEUE_SIZE) {
    return { blocked: true, reason: 'QUEUE_SIZE' };
  }

  // "8h desde a sincronização bem-sucedida" pressupõe que já houve uma
  // sincronização — sem nenhuma ainda (dispositivo novo, primeiro turno),
  // só o limite de tamanho acima se aplica.
  if (input.lastSyncSuccessAt) {
    const now = input.now ?? Date.now();
    const hoursSince = (now - new Date(input.lastSyncSuccessAt).getTime()) / (1000 * 60 * 60);
    if (hoursSince > MAX_HOURS_SINCE_SYNC) {
      return { blocked: true, reason: 'STALE_SYNC' };
    }
  }

  return { blocked: false, reason: null };
}

export function queueGateMessage(result: QueueGateResult): string | null {
  if (!result.blocked) return null;
  if (result.reason === 'QUEUE_SIZE') {
    return `Fila local atingiu o limite de ${MAX_QUEUE_SIZE} operações. Sincronize para continuar executando tarefas.`;
  }
  return `Mais de ${MAX_HOURS_SINCE_SYNC}h sem sincronizar. Conecte-se e sincronize para continuar executando tarefas.`;
}
