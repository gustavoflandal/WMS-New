// DOC-01 §4.6 RF-ARQ-052 — fila local de sincronização (IndexedDB, store
// `sync_queue` de field-db.ts). Cada confirmação (online OU offline) grava
// aqui ANTES de qualquer tentativa de rede — a fila é a fonte de verdade do
// que foi feito no dispositivo; a rede só entrega o que já está gravado.
import { getFieldDb, LocalSyncStatus, OfflineTaskType, QueuedOperation } from './field-db';

export interface EnqueueInput {
  operationId: string;
  tenantId: string;
  taskType: OfflineTaskType;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export async function enqueueOperation(input: EnqueueInput): Promise<QueuedOperation> {
  const db = await getFieldDb();
  const now = new Date().toISOString();
  const op: QueuedOperation = {
    operationId: input.operationId,
    tenantId: input.tenantId,
    taskType: input.taskType,
    taskId: input.taskId,
    payload: input.payload,
    deviceTimestamp: now,
    localStatus: 'LOCAL_PENDENTE',
    reason: null,
    createdAt: now,
    syncedAt: null,
  };
  await db.put('sync_queue', op);
  return op;
}

/** FIFO por dispositivo (RG-007/RN-ARQ-053: ordem de gravação, não de sincronização). */
export async function listPendingOperations(): Promise<QueuedOperation[]> {
  const db = await getFieldDb();
  const all = await db.getAllFromIndex('sync_queue', 'byStatus', 'LOCAL_PENDENTE');
  return all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function countPendingOperations(): Promise<number> {
  const db = await getFieldDb();
  return db.countFromIndex('sync_queue', 'byStatus', 'LOCAL_PENDENTE');
}

export async function listAllOperations(): Promise<QueuedOperation[]> {
  const db = await getFieldDb();
  const all = await db.getAll('sync_queue');
  return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function markOperationsSending(operationIds: string[]): Promise<void> {
  const db = await getFieldDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  for (const id of operationIds) {
    const op = await tx.store.get(id);
    if (op) {
      op.localStatus = 'ENVIANDO';
      await tx.store.put(op);
    }
  }
  await tx.done;
}

/** DOC-01 §5.2: "ENVIANDO -> LOCAL_PENDENTE: falha de rede (retry FIFO)". */
export async function revertOperationsToPending(operationIds: string[]): Promise<void> {
  const db = await getFieldDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  for (const id of operationIds) {
    const op = await tx.store.get(id);
    if (op) {
      op.localStatus = 'LOCAL_PENDENTE';
      await tx.store.put(op);
    }
  }
  await tx.done;
}

export async function resolveOperation(operationId: string, decision: LocalSyncStatus, reason: string | undefined): Promise<QueuedOperation | undefined> {
  const db = await getFieldDb();
  const op = await db.get('sync_queue', operationId);
  if (!op) return undefined;
  op.localStatus = decision;
  op.reason = reason ?? null;
  op.syncedAt = new Date().toISOString();
  await db.put('sync_queue', op);
  return op;
}
