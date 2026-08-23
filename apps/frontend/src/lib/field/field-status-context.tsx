// DOC-15 RNF-COL-020 — "estado permanente visível no topo" (conexão,
// tamanho da fila) + RNF-ARQ-054 (bloqueio client-side por limite de fila) +
// RNF-COL-050 (bloqueio client-side por versão mínima) + RF-COL-041
// (sincronização oportunista ao evento `online`). Único provedor para toda a
// área `field` — layout.tsx e as telas de execução leem o MESMO estado.
'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { countPendingOperations } from './sync-queue-store';
import { getLastSyncSuccessAt } from './sync-meta-store';
import { evaluateQueueGate, queueGateMessage, QueueGateResult } from './queue-gate';
import { syncNow } from './sync-engine';

const QUEUE_POLL_MS = 10000;

interface FieldStatusValue {
  online: boolean;
  queueSize: number;
  /** RNF-COL-050: sinal do servidor (registerDevice/sincronizar) — bloqueia novas execuções, nunca a sincronização da fila existente. */
  versionBlocked: boolean;
  setVersionBlocked: (blocked: boolean) => void;
  queueGate: QueueGateResult;
  /** true se QUALQUER bloqueio (fila OU versão) está ativo — telas de execução consultam só isto. */
  executionBlocked: boolean;
  blockedMessage: string | null;
  syncing: boolean;
  refreshQueueSize: () => Promise<void>;
  triggerSync: () => Promise<void>;
}

const FieldStatusContext = createContext<FieldStatusValue | undefined>(undefined);

export function FieldStatusProvider({
  warehouseId,
  appVersion,
  children,
}: {
  warehouseId: string | null;
  appVersion: string;
  children: React.ReactNode;
}): JSX.Element {
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [queueSize, setQueueSize] = useState(0);
  const [lastSyncSuccessAt, setLastSyncSuccessAtState] = useState<string | null>(null);
  const [versionBlocked, setVersionBlocked] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refreshQueueSize = useCallback(async () => {
    const [size, lastSync] = await Promise.all([countPendingOperations(), getLastSyncSuccessAt()]);
    setQueueSize(size);
    setLastSyncSuccessAtState(lastSync);
  }, []);

  const triggerSync = useCallback(async () => {
    if (!warehouseId) return;
    setSyncing(true);
    try {
      const result = await syncNow(warehouseId, appVersion);
      if (result.ran) setVersionBlocked(result.versionBlocked);
    } finally {
      setSyncing(false);
      await refreshQueueSize();
    }
  }, [warehouseId, appVersion, refreshQueueSize]);

  useEffect(() => {
    void refreshQueueSize();
    const interval = setInterval(() => void refreshQueueSize(), QUEUE_POLL_MS);
    return () => clearInterval(interval);
  }, [refreshQueueSize]);

  // RF-COL-041: "Ao evento online do navegador, iniciar automaticamente" a sincronização.
  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true);
      void triggerSync();
    };
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, appVersion]);

  const queueGate = evaluateQueueGate({ pendingCount: queueSize, lastSyncSuccessAt });
  const executionBlocked = queueGate.blocked || versionBlocked;
  const blockedMessage = versionBlocked
    ? 'Versão do aplicativo desatualizada. Atualize para continuar executando tarefas — a sincronização da fila existente continua permitida.'
    : queueGateMessage(queueGate);

  const value: FieldStatusValue = {
    online,
    queueSize,
    versionBlocked,
    setVersionBlocked,
    queueGate,
    executionBlocked,
    blockedMessage,
    syncing,
    refreshQueueSize,
    triggerSync,
  };

  return <FieldStatusContext.Provider value={value}>{children}</FieldStatusContext.Provider>;
}

export function useFieldStatus(): FieldStatusValue {
  const ctx = useContext(FieldStatusContext);
  if (!ctx) throw new Error('useFieldStatus deve ser usado dentro de <FieldStatusProvider>');
  return ctx;
}
