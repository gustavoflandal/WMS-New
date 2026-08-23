// DOC-15 §4.5 T8 — Sincronização. Reflete wms.sync_operation por
// device_id — SEM produtor real em COL-1 (a fila offline de verdade é da
// Sessão COL-2). Contadores ficam em zero hoje; a tela existe para não
// deixar a área `field` sem o catálogo fechado de 8 telas (DOC-15 §4.5).
'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock, AlertTriangle, XCircle } from 'lucide-react';
import { fieldApi, SyncStatusDto } from '../../../lib/field/field-api';
import { getOrCreateFieldDeviceId } from '../../../lib/field/device-id';
import { useAuth, ApiError } from '../../../lib/auth-context';

// Classes literais completas (não interpolar tone dentro da string — o JIT
// do Tailwind só detecta classes que aparecem por extenso no código-fonte).
const TONE_CLASSES = {
  neutral: { bg: 'bg-state-neutral-bg', text: 'text-state-neutral' },
  done: { bg: 'bg-state-done-bg', text: 'text-state-done' },
  warning: { bg: 'bg-state-warning-bg', text: 'text-state-warning' },
  pending: { bg: 'bg-state-pending-bg', text: 'text-state-pending' },
} as const;

function Counter({ icon: Icon, label, value, tone }: { icon: typeof Clock; label: string; value: number; tone: keyof typeof TONE_CLASSES }): JSX.Element {
  return (
    <div className={`flex flex-col items-center gap-1 rounded-card border border-border-subtle p-4 ${TONE_CLASSES[tone].bg}`}>
      <Icon aria-hidden="true" className={`h-6 w-6 ${TONE_CLASSES[tone].text}`} />
      <span className="text-display text-text-primary">{value}</span>
      <span className="text-label text-text-secondary">{label}</span>
    </div>
  );
}

export default function FieldSyncStatusPage(): JSX.Element {
  const { warehouseId } = useAuth();
  const [status, setStatus] = useState<SyncStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!warehouseId) return;
    let cancelled = false;
    getOrCreateFieldDeviceId()
      .then((deviceId) => fieldApi.syncStatus(deviceId, warehouseId))
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Não foi possível consultar a fila de sincronização.');
      });
    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Sincronização</h1>
      {error ? (
        <p role="alert" className="text-base text-state-pending">
          {error}
        </p>
      ) : status === null ? (
        <p className="text-base text-text-secondary">Carregando…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Counter icon={Clock} label="Pendentes" value={status.pending} tone="neutral" />
          <Counter icon={CheckCircle2} label="Sincronizadas" value={status.synced} tone="done" />
          <Counter icon={AlertTriangle} label="Em conflito" value={status.conflict} tone="warning" />
          <Counter icon={XCircle} label="Falhas" value={status.failed} tone="pending" />
        </div>
      )}
      <p className="text-label text-text-secondary">
        A execução offline (Putaway, Picking, Conferência, Contagem, Transferência) e a fila de sincronização real entram na próxima versão do coletor.
      </p>
    </div>
  );
}
