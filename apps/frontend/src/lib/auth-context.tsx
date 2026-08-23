// Provedor de autenticação da área internal. O JWT (RF-SEG-003) carrega só
// {sub, assignments_hash, area} — nenhum dado de armazém/cliente, de
// propósito (não invalidar o token a cada mudança de atribuição). Por isso,
// após login, este provedor busca GET /auth/me (RbacService.getMyContext,
// Sessão 7B) para descobrir em quais armazéns o usuário pode operar e deixa
// a pessoa escolher o armazém corrente — sem isso, nenhuma tela de painel/
// dashboard/alertas tem como montar o warehouse_id que toda rota exige.
'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiError, setAccessToken } from './api-client';

export interface MyWarehouse {
  id: string;
  code: string;
  name: string;
}

export interface MyClient {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
}

export interface MyContext {
  userId: string;
  area: 'INTERNAL' | 'CLIENT_PORTAL';
  warehouses: MyWarehouse[];
  clients: MyClient[];
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
  expiresInSeconds: number;
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  context: MyContext | null;
  warehouseId: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setWarehouseId: (warehouseId: string) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const DEVICE_ID_KEY = 'wms_device_id';
const REFRESH_TOKEN_KEY = 'wms_refresh_token';
const WAREHOUSE_ID_KEY = 'wms_warehouse_id';

function getOrCreateDeviceId(): string {
  let deviceId = window.sessionStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    window.sessionStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading', context: null, warehouseId: null });

  const loadContext = useCallback(async (): Promise<MyContext> => {
    return apiClient.get<MyContext>('/auth/me');
  }, []);

  useEffect(() => {
    // Sessão existente (refresh de página): o access token vive só em
    // memória de aba (sessionStorage, ver api-client.ts) — se sumiu, exige
    // login de novo. Não há /auth/refresh automático nesta sessão
    // ([DÉBITO]: silent refresh antes do access token de 15 min expirar).
    const token = window.sessionStorage.getItem('wms_access_token');
    if (!token) {
      setState({ status: 'unauthenticated', context: null, warehouseId: null });
      return;
    }
    loadContext()
      .then((context) => {
        const storedWarehouseId = window.sessionStorage.getItem(WAREHOUSE_ID_KEY);
        const warehouseId = context.warehouses.some((w) => w.id === storedWarehouseId)
          ? storedWarehouseId
          : (context.warehouses[0]?.id ?? null);
        setState({ status: 'authenticated', context, warehouseId });
      })
      .catch(() => {
        setAccessToken(null);
        setState({ status: 'unauthenticated', context: null, warehouseId: null });
      });
  }, [loadContext]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const deviceId = getOrCreateDeviceId();
      const result = await apiClient.post<LoginResponse>('/auth/login', { email, password, device_id: deviceId });
      setAccessToken(result.accessToken);
      window.sessionStorage.setItem(REFRESH_TOKEN_KEY, result.refreshToken);

      const context = await loadContext();
      const warehouseId = context.warehouses[0]?.id ?? null;
      if (warehouseId) window.sessionStorage.setItem(WAREHOUSE_ID_KEY, warehouseId);
      setState({ status: 'authenticated', context, warehouseId });
      router.push('/painel');
    },
    [loadContext, router]
  );

  const logout = useCallback((): void => {
    const refreshToken = window.sessionStorage.getItem(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      apiClient.post('/auth/logout', { refresh_token: refreshToken }).catch(() => {});
    }
    setAccessToken(null);
    window.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    window.sessionStorage.removeItem(WAREHOUSE_ID_KEY);
    setState({ status: 'unauthenticated', context: null, warehouseId: null });
    router.push('/login');
  }, [router]);

  const setWarehouseId = useCallback((warehouseId: string): void => {
    window.sessionStorage.setItem(WAREHOUSE_ID_KEY, warehouseId);
    setState((prev) => ({ ...prev, warehouseId }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, setWarehouseId }),
    [state, login, logout, setWarehouseId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}

export { ApiError };
