// DOC-01 §4.6 RF-ARQ-051 — persistência local do Pacote de Turno (IndexedDB,
// store `tasks` de field-db.ts). Upsert por taskId: uma atualização do
// pacote NUNCA apaga uma tarefa local nem descarta progresso já salvo (RF-
// COL-021) — se uma tarefa sumir do pull (reatribuída/cancelada/concluída
// por outro ator), a decisão correta (DESCARTADA_DUPLICIDADE/REJEITADA_
// TAREFA_INVALIDA) é responsabilidade da sincronização (RN-ARQ-053), não
// deste store.
import { getFieldDb, SINGLETON_KEY, FieldTaskType, LocalTask, ShiftPackageMeta } from './field-db';

export interface RemoteShiftPackageTask {
  taskType: FieldTaskType;
  taskId: string;
  tenantId: string;
  status: string;
  lpn: string | null;
  productSku: string | null;
  productDescription: string | null;
  locationCode: string | null;
  locationCodeOrigin: string | null;
  checkingId: string | null;
  qty: number | null;
  createdAt: string;
}

export interface RemoteShiftPackage {
  warehouseId: string;
  userId: string;
  packageVersion: string;
  maxTasks: number;
  truncated: boolean;
  taskCount: number;
  tasks: RemoteShiftPackageTask[];
}

export async function saveShiftPackage(pkg: RemoteShiftPackage): Promise<void> {
  const db = await getFieldDb();
  const tx = db.transaction(['tasks', 'shift_package_meta'], 'readwrite');
  const tasksStore = tx.objectStore('tasks');

  for (const remote of pkg.tasks) {
    const existing = await tasksStore.get(remote.taskId);
    const merged: LocalTask = {
      ...remote,
      localStatus: existing?.localStatus ?? 'PENDING',
      progress: existing?.progress ?? null,
      queuedOperationId: existing?.queuedOperationId ?? null,
    };
    await tasksStore.put(merged);
  }

  const meta: ShiftPackageMeta = {
    packageVersion: pkg.packageVersion,
    warehouseId: pkg.warehouseId,
    userId: pkg.userId,
    maxTasks: pkg.maxTasks,
    truncated: pkg.truncated,
    fetchedAt: new Date().toISOString(),
  };
  await tx.objectStore('shift_package_meta').put(meta, SINGLETON_KEY);
  await tx.done;
}

export async function getTask(taskId: string): Promise<LocalTask | undefined> {
  const db = await getFieldDb();
  return db.get('tasks', taskId);
}

export async function listTasks(taskType?: FieldTaskType): Promise<LocalTask[]> {
  const db = await getFieldDb();
  const all = taskType ? await db.getAllFromIndex('tasks', 'byType', taskType) : await db.getAll('tasks');
  return all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Tarefas ainda executáveis (exclui as já enfileiradas/concluídas localmente). */
export async function listExecutableTasks(taskType?: FieldTaskType): Promise<LocalTask[]> {
  const all = await listTasks(taskType);
  return all.filter((t) => t.localStatus === 'PENDING' || t.localStatus === 'IN_PROGRESS');
}

/** RF-COL-021 [obrigatório]: salva o passo atual — retomada exata ao reabrir. `progress: null` volta a PENDING (nenhum passo dado ainda). */
export async function updateTaskProgress(taskId: string, progress: Record<string, unknown> | null): Promise<void> {
  const db = await getFieldDb();
  const task = await db.get('tasks', taskId);
  if (!task) return;
  task.progress = progress;
  task.localStatus = progress ? 'IN_PROGRESS' : 'PENDING';
  await db.put('tasks', task);
}

export async function markTaskQueued(taskId: string, operationId: string): Promise<void> {
  const db = await getFieldDb();
  const task = await db.get('tasks', taskId);
  if (!task) return;
  task.localStatus = 'QUEUED';
  task.queuedOperationId = operationId;
  task.progress = null;
  await db.put('tasks', task);
}

/** Chamado pelo motor de sincronização após a decisão do servidor (ver sync-engine.ts). */
export async function setTaskLocalStatus(taskId: string, localStatus: LocalTask['localStatus']): Promise<void> {
  const db = await getFieldDb();
  const task = await db.get('tasks', taskId);
  if (!task) return;
  task.localStatus = localStatus;
  if (localStatus === 'PENDING') {
    task.queuedOperationId = null;
  }
  await db.put('tasks', task);
}

export async function getShiftPackageMeta(): Promise<ShiftPackageMeta | undefined> {
  const db = await getFieldDb();
  return db.get('shift_package_meta', SINGLETON_KEY);
}
