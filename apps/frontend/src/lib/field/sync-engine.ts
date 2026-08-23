// DOC-01 §4.6 RF-COL-041 (sincronização oportunista) + RN-ARQ-053 (as 4
// decisões, aplicadas localmente à tarefa/fila) + DOC-01 §5.2 (máquina de
// estados: ENVIANDO -> decisão final, ou de volta a LOCAL_PENDENTE em falha
// de rede — "retry FIFO").
import { fieldApi, SyncOperationInputDto, SyncBatchResultDto } from './field-api';
import { getOrCreateFieldDeviceId } from './device-id';
import { countPendingOperations, listPendingOperations, markOperationsSending, resolveOperation, revertOperationsToPending } from './sync-queue-store';
import { setTaskLocalStatus } from './shift-package-store';
import { setLastSyncSuccessAt } from './sync-meta-store';

export interface SyncRunResult {
  ran: boolean;
  processed: number;
  versionBlocked: boolean;
  error?: string;
}

// Guarda de instância única — evita disparos concorrentes (evento `online` +
// botão manual + poll periódico todos chamando ao mesmo tempo).
let syncing = false;

export function isSyncing(): boolean {
  return syncing;
}

/**
 * RF-ARQ-052/RN-ARQ-053: envia a fila LOCAL_PENDENTE inteira em UM lote,
 * preservando a ordem FIFO de gravação (RG-007) — o backend processa nessa
 * mesma ordem. Aplica cada decisão devolvida à tarefa local correspondente:
 * APLICADA/DESCARTADA_DUPLICIDADE encerram a tarefa (DONE — no segundo caso,
 * "encerrada" significa resolvida por outro ator, não por este operador);
 * REJEITADA_TAREFA_INVALIDA/REJEITADA_REGRA devolvem a tarefa a PENDING
 * (retomável — o operador pode reexecutar ou a supervisão intervém).
 */
export async function syncNow(warehouseId: string, appVersion: string): Promise<SyncRunResult> {
  if (syncing) return { ran: false, processed: 0, versionBlocked: false };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ran: false, processed: 0, versionBlocked: false };

  syncing = true;
  try {
    const pending = await listPendingOperations();
    if (pending.length === 0) return { ran: false, processed: 0, versionBlocked: false };

    const deviceId = await getOrCreateFieldDeviceId();
    const operationIds = pending.map((op) => op.operationId);
    await markOperationsSending(operationIds);

    const operations: SyncOperationInputDto[] = pending.map((op) => ({
      operation_id: op.operationId,
      tenant_id: op.tenantId,
      task_type: op.taskType,
      task_id: op.taskId ?? undefined,
      payload: op.payload,
    }));

    let batch: SyncBatchResultDto;
    try {
      batch = await fieldApi.sincronizar({
        deviceId,
        warehouseId,
        appVersion,
        queueSize: await countPendingOperations(),
        operations,
      });
    } catch (err) {
      await revertOperationsToPending(operationIds);
      return { ran: true, processed: 0, versionBlocked: false, error: err instanceof Error ? err.message : 'Falha de rede' };
    }

    for (const result of batch.results) {
      await resolveOperation(result.operationId, result.decision, result.reason);
      const op = pending.find((p) => p.operationId === result.operationId);
      if (!op?.taskId) continue;
      if (result.decision === 'APLICADA' || result.decision === 'DESCARTADA_DUPLICIDADE') {
        await setTaskLocalStatus(op.taskId, 'DONE');
      } else {
        await setTaskLocalStatus(op.taskId, 'PENDING');
      }
    }

    await setLastSyncSuccessAt(new Date().toISOString());
    return { ran: true, processed: batch.results.length, versionBlocked: batch.versionBlocked };
  } finally {
    syncing = false;
  }
}
