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

export const fieldApi = {
  registerDevice: (deviceId: string, warehouseId: string, appVersion: string) =>
    apiClient.post<FieldDevice>('/campo/dispositivos', { device_id: deviceId, warehouse_id: warehouseId, user_agent: navigator.userAgent, app_version: appVersion }),

  setPin: (pin: string) => apiClient.post<void>('/campo/pin', { pin }),
  verifyPin: (pin: string, warehouseId: string) => apiClient.post<{ ok: boolean; requiresFullLogin: boolean }>('/campo/pin/verificar', { pin, warehouse_id: warehouseId }),

  myTasks: (warehouseId: string) => apiClient.get<MyTaskDto[]>(`/campo/minhas-tarefas?warehouse_id=${warehouseId}`),

  searchStock: (codigo: string, tenantId: string, warehouseId: string) =>
    apiClient.get<StockSearchRowDto[]>(`/campo/consulta?codigo=${encodeURIComponent(codigo)}&tenant_id=${tenantId}&warehouse_id=${warehouseId}`),

  syncStatus: (deviceId: string, warehouseId: string) => apiClient.get<SyncStatusDto>(`/campo/sincronizacao?device_id=${deviceId}&warehouse_id=${warehouseId}`),
};
