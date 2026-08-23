// DOC-15 §4.5 T8 — Sincronização. Contadores do SERVIDOR (`fieldApi.
// syncStatus`, mantido da COL-1) + a fila LOCAL real (COL-2B,
// `listAllOperations()`), com a decisão de cada operação traduzida para
// linguagem simples (RN-COL-040) e um botão manual "Sincronizar agora"
// (`useFieldStatus().triggerSync()` — RF-COL-041 cobre o disparo automático
// ao voltar a ficar online; este botão é o disparo manual).
'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { fieldApi, SyncStatusDto } from '../../../lib/field/field-api';
import { getOrCreateFieldDeviceId } from '../../../lib/field/device-id';
import { useAuth, ApiError } from '../../../lib/auth-context';
import { useFieldStatus } from '../../../lib/field/field-status-context';
import { listAllOperations } from '../../../lib/field/sync-queue-store';
import { QueuedOperation, LocalSyncStatus } from '../../../lib/field/field-db';

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

// RN-COL-040: os 4 códigos de decisão em linguagem simples para o operador.
const DECISION_LABEL: Record<LocalSyncStatus, string> = {
  LOCAL_PENDENTE: 'Aguardando sincronização',
  ENVIANDO: 'Enviando…',
  APLICADA: 'Aplicada com sucesso',
  DESCARTADA_DUPLICIDADE: 'Já havia sido concluída por outro operador',
  REJEITADA_TAREFA_INVALIDA: 'Tarefa não é mais válida — verifique com o supervisor',
  REJEITADA_REGRA: 'Rejeitada',
};

function decisionLabel(op: QueuedOperation): string {
  if (op.localStatus === 'REJEITADA_REGRA' && op.reason) return `Rejeitada: ${op.reason}`;
  return DECISION_LABEL[op.localStatus];
}

function decisionTone(status: LocalSyncStatus): keyof typeof TONE_CLASSES {
  if (status === 'APLICADA') return 'done';
  if (status === 'LOCAL_PENDENTE' || status === 'ENVIANDO') return 'neutral';
  if (status === 'DESCARTADA_DUPLICIDADE') return 'warning';
  return 'pending';
}

export default function FieldSyncStatusPage(): JSX.Element {
  const { warehouseId } = useAuth();
  const fieldStatus = useFieldStatus();
  const [status, setStatus] = useState<SyncStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operations, setOperations] = useState<QueuedOperation[] | null>(null);

  const loadServerStatus = React.useCallback(async (): Promise<void> => {
    if (!warehouseId) return;
    try {
      const deviceId = await getOrCreateFieldDeviceId();
      const result = await fieldApi.syncStatus(deviceId, warehouseId);
      setStatus(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível consultar a fila de sincronização.');
    }
  }, [warehouseId]);

  const loadLocalQueue = React.useCallback(async (): Promise<void> => {
    const ops = await listAllOperations();
    setOperations(ops);
  }, []);

  useEffect(() => {
    void loadServerStatus();
    void loadLocalQueue();
  }, [loadServerStatus, loadLocalQueue]);

  const handleSyncNow = async (): Promise<void> => {
    await fieldStatus.triggerSync();
    await Promise.all([loadServerStatus(), loadLocalQueue()]);
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Sincronização</h1>

      <button
        type="button"
        onClick={() => void handleSyncNow()}
        disabled={fieldStatus.syncing}
        className="flex min-h-[56px] items-center justify-center gap-2 rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
      >
        <RefreshCw aria-hidden="true" className={`h-5 w-5 ${fieldStatus.syncing ? 'animate-spin' : ''}`} />
        {fieldStatus.syncing ? 'Sincronizando…' : 'Sincronizar agora'}
      </button>

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

      <div className="rounded-card border border-border-subtle bg-surface-raised p-4">
        <p className="mb-2 text-subtitle text-text-primary">Fila local deste dispositivo</p>
        {operations === null ? (
          <p className="text-base text-text-secondary">Carregando…</p>
        ) : operations.length === 0 ? (
          <p className="text-base text-text-secondary">Nenhuma operação registrada neste dispositivo.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {operations.map((op) => {
              const tone = decisionTone(op.localStatus);
              return (
                <li key={op.operationId} className="flex flex-col gap-0.5 border-b border-border-subtle pb-2 text-base last:border-b-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className="text-text-primary">{op.taskType}</span>
                    <span className={`rounded-full px-2 py-0.5 text-label ${TONE_CLASSES[tone].bg} ${TONE_CLASSES[tone].text}`}>{decisionLabel(op)}</span>
                  </div>
                  <span className="text-label text-text-secondary">{new Date(op.createdAt).toLocaleString('pt-BR')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
