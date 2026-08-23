// DOC-15 §4.5 T4 — Conferência. Conferência documental (sem leitura de
// endereço/LPN): produto → quantidade contada (DOC-15 §4.5). RF-COL-021: a
// quantidade digitada é persistida ao perder o foco do campo, retomável.
// [LACUNA]: lote/validade condicional (RN-DAD-020) exigiria saber se a
// espécie do produto exige — essa informação não está disponível na
// `LocalTask`; a tela funciona sem esse campo condicional (o servidor
// também não valida lote/validade neste ponto, conferido em
// `checking.service.ts` do backend).
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ClipboardCheck } from 'lucide-react';
import { useAuth } from '../../../../lib/auth-context';
import { APP_VERSION } from '../../layout';
import { getTask, updateTaskProgress } from '../../../../lib/field/shift-package-store';
import { confirmTask } from '../../../../lib/field/confirm-task';
import { useFieldStatus } from '../../../../lib/field/field-status-context';
import { LocalTask } from '../../../../lib/field/field-db';
import { TaskNotFoundPanel } from '../../_components/task-not-found';
import { ExecutionBlockedBanner } from '../../_components/execution-blocked-banner';

interface ConferenciaProgress {
  qtyCounted: string;
}

export default function ConferenciaTaskPage({ params }: { params: { taskId: string } }): JSX.Element {
  const { warehouseId, context } = useAuth();
  const status = useFieldStatus();
  const [task, setTask] = useState<LocalTask | null | undefined>(undefined);
  const [qty, setQty] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTask(params.taskId).then((found) => {
      if (cancelled) return;
      if (!found || (found.localStatus !== 'PENDING' && found.localStatus !== 'IN_PROGRESS')) {
        setTask(null);
        return;
      }
      setTask(found);
      const saved = found.progress as ConferenciaProgress | null;
      if (saved?.qtyCounted) setQty(saved.qtyCounted);
    });
    return () => {
      cancelled = true;
    };
  }, [params.taskId]);

  if (task === undefined) return <p className="text-base text-text-secondary">Carregando…</p>;
  if (task === null) return <TaskNotFoundPanel />;

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 pt-12 text-center">
        <CheckCircle2 aria-hidden="true" className="h-10 w-10 text-state-done" />
        <p className="text-base text-text-primary">Conferência registrada com sucesso.</p>
        <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
          Voltar para minhas tarefas
        </Link>
      </div>
    );
  }

  const persistQty = async (value: string): Promise<void> => {
    await updateTaskProgress(task.taskId, value ? ({ qtyCounted: value } as unknown as Record<string, unknown>) : null);
  };

  const qtyNumber = qty === '' ? null : Number(qty);
  const round = task.status === 'RECOUNT_PENDING' ? 'RECOUNT' : 'FIRST';

  const handleConfirm = async (): Promise<void> => {
    if (!warehouseId || !context || qtyNumber === null || !task.checkingId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'CONFERENCIA',
        payload: {
          checkingId: task.checkingId,
          qtyCounted: qtyNumber,
          conferenteUserId: context.userId,
          round,
        },
        warehouseId,
        appVersion: APP_VERSION,
      });
      setDone(true);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Não foi possível registrar a operação.');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ClipboardCheck aria-hidden="true" className="h-6 w-6 text-brand" />
        <h1 className="text-title text-text-primary">Conferência</h1>
      </div>
      {round === 'RECOUNT' ? (
        <p className="rounded-card border border-state-warning bg-state-warning-bg p-3 text-base text-state-warning">Esta é uma recontagem.</p>
      ) : null}
      <p className="text-base text-text-secondary">
        Produto: <span className="text-text-primary">{task.productSku} — {task.productDescription}</span>
      </p>

      <div className="flex flex-col gap-3 rounded-card border border-border-subtle bg-surface-raised p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="qtyCounted" className="text-label text-text-secondary">
            Quantidade contada (UN)
          </label>
          <input
            id="qtyCounted"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
            onBlur={(e) => void persistQty(e.target.value)}
            className="h-16 rounded-field border-2 border-border-strong bg-surface-raised px-3 text-center font-mono text-data-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
        {status.executionBlocked && status.blockedMessage ? <ExecutionBlockedBanner message={status.blockedMessage} /> : null}
        {confirmError ? (
          <p role="alert" className="text-base text-state-pending">
            {confirmError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={confirming || status.executionBlocked || qtyNumber === null}
          className="min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
        >
          {confirming ? 'Confirmando…' : 'Confirmar conferência'}
        </button>
      </div>
    </div>
  );
}
