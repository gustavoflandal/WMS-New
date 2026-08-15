// WMS Type definitions
// [LACUNA: Complete type definitions to be added as modules are implemented]

export interface HealthCheckResponse {
  status: 'ok' | 'error';
  timestamp: string;
  service?: string;
  checks?: Record<string, 'ok' | 'error'>;
  version?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface TenantContext {
  tenant_id: string;
  warehouse_id: string;
  user_id: string;
}
