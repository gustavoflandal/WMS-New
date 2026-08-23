// DOC-15 — cliente HTTP da área field. Reaproveita apiClient (mesmo token,
// mesma tradução de erro RFC 9457) — não duplica lógica de rede.
import { apiClient } from '../api-client';

export interface FieldDevice {
  id: string;
  device_id: string;
  warehouse_id: string;
  status: 'ACTIVE' | 'BLOCKED';
}

export interface MyTaskDto {
  id: string;
  type: 'PUTAWAY' | 'REPOSICAO';
  status: string;
  lpn: string | null;
  productSku: string | null;
  productDescription: string | null;
  locationCode: string | null;
  qty: number | null;
  createdAt: string;
}

export interface StockSearchRowDto {
  locationCode: string;
  zoneCode: string;
  productSku: string;
  productDescription: string;
  batchCode: string | null;
  expirationDate: string | null;
  qtyAvailable: number | null;
  locationStatus: string;
  frozenByInventory: boolean;
}

export interface SyncStatusDto {
  deviceId: string;
  pending: number;
  synced: number;
  conflict: number;
  failed: number;
}

// DOC-01 §4.6 RF-ARQ-051/052 (Sessão COL-2A/COL-2B) — Pacote de Turno e fila
// de sincronização. Espelham exatamente shift-package.service.ts/
// offline-sync.service.ts (backend) — ver ali para o contrato completo.
export type FieldTaskTypeDto = 'PUTAWAY' | 'REPOSICAO' | 'PICKING' | 'CONFERENCIA' | 'CONTAGEM_INVENTARIO';
export type OfflineTaskTypeDto = FieldTaskTypeDto | 'TRANSFERENCIA';

export interface ShiftPackageTaskDto {
  taskType: FieldTaskTypeDto;
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

export interface ShiftPackageDto {
  warehouseId: string;
  userId: string;
  packageVersion: string;
  maxTasks: number;
  truncated: boolean;
  taskCount: number;
  tasks: ShiftPackageTaskDto[];
}

export interface SyncOperationInputDto {
  operation_id: string;
  tenant_id: string;
  task_type: OfflineTaskTypeDto;
  task_id?: string;
  payload: Record<string, unknown>;
}

export type SyncDecisionDto = 'APLICADA' | 'DESCARTADA_DUPLICIDADE' | 'REJEITADA_TAREFA_INVALIDA' | 'REJEITADA_REGRA';

export interface SyncOperationResultDto {
  operationId: string;
  taskType: OfflineTaskTypeDto;
  decision: SyncDecisionDto;
  result?: unknown;
  reason?: string;
}

export interface SyncBatchResultDto {
  versionBlocked: boolean;
  results: SyncOperationResultDto[];
}

export const fieldApi = {
  registerDevice: (deviceId: string, warehouseId: string, appVersion: string) =>
    apiClient.post<FieldDevice & { versionBlocked: boolean }>('/campo/dispositivos', {
      device_id: deviceId,
      warehouse_id: warehouseId,
      user_agent: navigator.userAgent,
      app_version: appVersion,
    }),

  setPin: (pin: string) => apiClient.post<void>('/campo/pin', { pin }),
  verifyPin: (pin: string, warehouseId: string) => apiClient.post<{ ok: boolean; requiresFullLogin: boolean }>('/campo/pin/verificar', { pin, warehouse_id: warehouseId }),

  myTasks: (warehouseId: string) => apiClient.get<MyTaskDto[]>(`/campo/minhas-tarefas?warehouse_id=${warehouseId}`),

  searchStock: (codigo: string, tenantId: string, warehouseId: string) =>
    apiClient.get<StockSearchRowDto[]>(`/campo/consulta?codigo=${encodeURIComponent(codigo)}&tenant_id=${tenantId}&warehouse_id=${warehouseId}`),

  syncStatus: (deviceId: string, warehouseId: string) => apiClient.get<SyncStatusDto>(`/campo/sincronizacao?device_id=${deviceId}&warehouse_id=${warehouseId}`),

  shiftPackage: (warehouseId: string) => apiClient.get<ShiftPackageDto>(`/campo/pacote-turno?warehouse_id=${warehouseId}`),

  sincronizar: (input: {
    deviceId: string;
    warehouseId: string;
    appVersion: string;
    batteryPct?: number;
    queueSize: number;
    operations: SyncOperationInputDto[];
  }) =>
    apiClient.post<SyncBatchResultDto>('/campo/sincronizacao', {
      device_id: input.deviceId,
      warehouse_id: input.warehouseId,
      app_version: input.appVersion,
      battery_pct: input.batteryPct,
      queue_size: input.queueSize,
      operations: input.operations,
    }),
};
