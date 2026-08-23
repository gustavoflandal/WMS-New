// DOC-15 — schema ÚNICO do IndexedDB da área `field` (banco `wms_field`).
// Centralizado aqui (em vez de cada módulo abrir sua própria conexão) porque
// `idb`/IndexedDB dispara `onupgradeneeded` por CONEXÃO — duas chamadas
// concorrentes de `openDB(DB_NAME, versões diferentes)` de módulos distintos
// arriscam VersionError/bloqueio mútuo. `device-id.ts` (COL-1) e os stores
// novos desta sessão (COL-2B) compartilham esta única conexão.
import { openDB, DBSchema, IDBPDatabase } from 'idb';

export type FieldTaskType = 'PUTAWAY' | 'REPOSICAO' | 'PICKING' | 'CONFERENCIA' | 'CONTAGEM_INVENTARIO';
export type OfflineTaskType = FieldTaskType | 'TRANSFERENCIA';

/** Espelha ShiftPackageTask (backend, shift-package.service.ts) + estado local de execução (RF-COL-021). */
export interface LocalTask {
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
  /**
   * RF-COL-021 [obrigatório]: PENDING = ainda não iniciada; IN_PROGRESS =
   * tem passo salvo em `progress` (retomável); QUEUED = confirmada, já virou
   * uma operação em `sync_queue` (aguardando ou já sincronizada); DONE =
   * decisão final APLICADA recebida do servidor.
   */
  localStatus: 'PENDING' | 'IN_PROGRESS' | 'QUEUED' | 'DONE';
  /** Passo atual da tarefa, formato livre por taskType — só o componente da tela interpreta. */
  progress: Record<string, unknown> | null;
  queuedOperationId: string | null;
}

export type SyncDecision = 'APLICADA' | 'DESCARTADA_DUPLICIDADE' | 'REJEITADA_TAREFA_INVALIDA' | 'REJEITADA_REGRA';
/** DOC-01 §5.2 (máquina de estados da sync_queue local) + ENVIANDO (em trânsito). */
export type LocalSyncStatus = 'LOCAL_PENDENTE' | 'ENVIANDO' | SyncDecision;

export interface QueuedOperation {
  operationId: string;
  tenantId: string;
  taskType: OfflineTaskType;
  taskId: string | null;
  payload: Record<string, unknown>;
  /** Timestamp do dispositivo no momento da confirmação (RF-ARQ-052). */
  deviceTimestamp: string;
  localStatus: LocalSyncStatus;
  reason: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface ShiftPackageMeta {
  packageVersion: string;
  warehouseId: string;
  userId: string;
  maxTasks: number;
  truncated: boolean;
  fetchedAt: string;
}

export interface SyncMeta {
  /** RNF-ARQ-054: "8h desde a sincronização bem-sucedida" — todo round-trip OK ao servidor atualiza isto, mesmo que a fila não esvazie. */
  lastSyncSuccessAt: string | null;
}

interface FieldDB extends DBSchema {
  device: {
    key: string;
    value: { id: string; createdAt: string };
  };
  tasks: {
    key: string;
    value: LocalTask;
    indexes: { byType: string };
  };
  sync_queue: {
    key: string;
    value: QueuedOperation;
    indexes: { byStatus: string };
  };
  shift_package_meta: {
    key: string;
    value: ShiftPackageMeta;
  };
  sync_meta: {
    key: string;
    value: SyncMeta;
  };
}

const DB_NAME = 'wms_field';
const DB_VERSION = 2;
export const SINGLETON_KEY = 'current';

let dbPromise: Promise<IDBPDatabase<FieldDB>> | null = null;

export function getFieldDb(): Promise<IDBPDatabase<FieldDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FieldDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('device')) {
          db.createObjectStore('device');
        }
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'taskId' });
          store.createIndex('byType', 'taskType');
        }
        if (!db.objectStoreNames.contains('sync_queue')) {
          const store = db.createObjectStore('sync_queue', { keyPath: 'operationId' });
          store.createIndex('byStatus', 'localStatus');
        }
        if (!db.objectStoreNames.contains('shift_package_meta')) {
          db.createObjectStore('shift_package_meta');
        }
        if (!db.objectStoreNames.contains('sync_meta')) {
          db.createObjectStore('sync_meta');
        }
      },
    });
  }
  return dbPromise;
}

/** UUID v7 mínimo (timestamp de 48 bits + aleatório) — mesma implementação de device-id.ts, reexportada como fonte única. */
export function uuidV7(): string {
  const timestamp = BigInt(Date.now());
  const timeHex = timestamp.toString(16).padStart(12, '0');
  const randomHex = crypto.getRandomValues(new Uint8Array(10)).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${randomHex.slice(0, 3)}`,
    ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + randomHex.slice(4, 7),
    randomHex.slice(7, 19),
  ].join('-');
}
