// DOC-01 §4.6 RF-ARQ-052 — ponto ÚNICO de confirmação usado por T2-T6: grava
// a operação na fila local (idempotente por operationId, UUID v7 gerado
// aqui — RG-009) e marca a tarefa como QUEUED ANTES de qualquer tentativa de
// rede (offline-first: a confirmação vale mesmo sem conexão). Depois tenta
// sincronizar de forma oportunista, sem bloquear a UI (RF-COL-041).
import { uuidV7, OfflineTaskType } from './field-db';
import { enqueueOperation } from './sync-queue-store';
import { markTaskQueued } from './shift-package-store';
import { syncNow } from './sync-engine';

export interface ConfirmTaskInput {
  /** null só para TRANSFERENCIA (RF-EST-050 ad-hoc, sem tarefa dirigida pré-aprovisionada). */
  taskId: string | null;
  tenantId: string;
  taskType: OfflineTaskType;
  payload: Record<string, unknown>;
  warehouseId: string;
  appVersion: string;
}

export async function confirmTask(input: ConfirmTaskInput): Promise<string> {
  const operationId = uuidV7();
  await enqueueOperation({
    operationId,
    tenantId: input.tenantId,
    taskType: input.taskType,
    taskId: input.taskId,
    payload: input.payload,
  });
  if (input.taskId) await markTaskQueued(input.taskId, operationId);
  void syncNow(input.warehouseId, input.appVersion);
  return operationId;
}
