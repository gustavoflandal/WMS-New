// DOC-15 §4.5 T2 — Putaway. Dupla leitura (RF-REC-042): ler LPN (comparado
// com a tarefa, RG-007) → ler endereço (se divergir do sugerido, exige
// `overrideReason`, RN-REC-041) → confirmar. RF-COL-021: o passo atual é
// persistido em `task.progress` a cada leitura — recarregar retoma exatamente
// aqui.
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, PackagePlus } from 'lucide-react';
import { useAuth } from '../../../../lib/auth-context';
import { APP_VERSION } from '../../layout';
import { getTask, updateTaskProgress } from '../../../../lib/field/shift-package-store';
import { confirmTask } from '../../../../lib/field/confirm-task';
import { useFieldStatus } from '../../../../lib/field/field-status-context';
import { validateExpectedType } from '../../../../lib/field/scanner';
import { useWedgeScanner } from '../../../../lib/field/use-wedge-scanner';
import { useScanFeedback, scanFeedbackBorderClass } from '../../../../lib/field/use-scan-feedback';
import { LocalTask } from '../../../../lib/field/field-db';
import { TaskNotFoundPanel } from '../../_components/task-not-found';
import { ExecutionBlockedBanner } from '../../_components/execution-blocked-banner';

interface PutawayProgress {
  step: 'location' | 'confirm';
  lpn: string;
  scannedLocationCode?: string;
  overrideReason?: string;
}

export default function PutawayTaskPage({ params }: { params: { taskId: string } }): JSX.Element {
  const { warehouseId } = useAuth();
  const status = useFieldStatus();
  const [task, setTask] = useState<LocalTask | null | undefined>(undefined);
  const [progress, setProgress] = useState<PutawayProgress | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const feedback = useScanFeedback();

  useEffect(() => {
    let cancelled = false;
    getTask(params.taskId).then((found) => {
      if (cancelled) return;
      if (!found || (found.localStatus !== 'PENDING' && found.localStatus !== 'IN_PROGRESS')) {
        setTask(null);
        return;
      }
      setTask(found);
      const saved = found.progress as PutawayProgress | null;
      setProgress(saved);
      setOverrideReason(saved?.overrideReason ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [params.taskId]);

  const step: 'lpn' | 'location' | 'confirm' = progress?.step ?? 'lpn';

  const handleScan = async (raw: string): Promise<void> => {
    if (!task) return;
    setManualCode('');
    if (step === 'lpn') {
      const result = validateExpectedType(raw, ['LPN']);
      if (!result.ok) {
        feedback.trigger('error');
        setScanError(result.reason ?? 'Código inválido');
        return;
      }
      if (result.classified.value !== task.lpn) {
        feedback.trigger('error');
        setScanError('LPN lido não corresponde à tarefa.');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: PutawayProgress = { step: 'location', lpn: result.classified.value };
      await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
      setProgress(next);
      return;
    }
    if (step === 'location') {
      const result = validateExpectedType(raw, ['ENDERECO']);
      if (!result.ok) {
        feedback.trigger('error');
        setScanError(result.reason ?? 'Código inválido');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: PutawayProgress = {
        step: 'confirm',
        lpn: progress!.lpn,
        scannedLocationCode: result.classified.value,
      };
      await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
      setProgress(next);
    }
  };

  useWedgeScanner((code) => void handleScan(code), step !== 'confirm' && task != null);

  if (task === undefined) return <p className="text-base text-text-secondary">Carregando…</p>;
  if (task === null) return <TaskNotFoundPanel />;

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 pt-12 text-center">
        <CheckCircle2 aria-hidden="true" className="h-10 w-10 text-state-done" />
        <p className="text-base text-text-primary">Putaway registrado com sucesso.</p>
        <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
          Voltar para minhas tarefas
        </Link>
      </div>
    );
  }

  const requiresOverride = step === 'confirm' && progress?.scannedLocationCode !== task.locationCode;

  const handleConfirm = async (): Promise<void> => {
    if (!warehouseId || !progress?.scannedLocationCode) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'PUTAWAY',
        payload: {
          scannedLpn: progress.lpn,
          scannedLocationCode: progress.scannedLocationCode,
          overrideReason: requiresOverride ? overrideReason : undefined,
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
        <PackagePlus aria-hidden="true" className="h-6 w-6 text-brand" />
        <h1 className="text-title text-text-primary">Putaway</h1>
      </div>
      <p className="text-base text-text-secondary">
        LPN esperado: <span className="font-mono text-text-primary">{task.lpn}</span>
        {task.locationCode ? (
          <>
            {' · '}Endereço sugerido: <span className="font-mono text-text-primary">{task.locationCode}</span>
          </>
        ) : null}
      </p>

      {step === 'lpn' ? (
        <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
          <p className="mb-2 text-subtitle text-text-primary">Passo 1 — Ler o LPN</p>
          <p className="mb-3 text-base text-text-secondary">Use o leitor físico ou digite o código abaixo.</p>
          <div className="flex gap-2">
            <input
              type="text"
              autoCapitalize="characters"
              inputMode="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              className="h-14 flex-1 rounded-field border-2 border-border-strong bg-surface-raised px-3 font-mono text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <button
              type="button"
              onClick={() => void handleScan(manualCode)}
              disabled={!manualCode}
              className="min-h-[56px] rounded-field bg-brand px-4 text-base font-semibold text-white disabled:opacity-50"
            >
              Ler
            </button>
          </div>
        </div>
      ) : null}

      {step === 'location' ? (
        <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
          <p className="mb-2 text-subtitle text-text-primary">Passo 2 — Ler o endereço</p>
          <p className="mb-3 text-base text-text-secondary">Use o leitor físico ou digite o código abaixo.</p>
          <div className="flex gap-2">
            <input
              type="text"
              autoCapitalize="characters"
              inputMode="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              className="h-14 flex-1 rounded-field border-2 border-border-strong bg-surface-raised px-3 font-mono text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <button
              type="button"
              onClick={() => void handleScan(manualCode)}
              disabled={!manualCode}
              className="min-h-[56px] rounded-field bg-brand px-4 text-base font-semibold text-white disabled:opacity-50"
            >
              Ler
            </button>
          </div>
        </div>
      ) : null}

      {scanError ? (
        <p role="alert" className="text-base text-state-pending">
          {scanError}
        </p>
      ) : null}

      {step === 'confirm' ? (
        <div className="flex flex-col gap-3 rounded-card border border-border-subtle bg-surface-raised p-4">
          <p className="text-subtitle text-text-primary">Passo 3 — Confirmar</p>
          <p className="text-base text-text-primary">
            LPN: <span className="font-mono">{progress?.lpn}</span>
          </p>
          <p className="text-base text-text-primary">
            Endereço lido: <span className="font-mono">{progress?.scannedLocationCode}</span>
          </p>
          {requiresOverride ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="overrideReason" className="text-label text-state-warning">
                Endereço divergente do sugerido ({task.locationCode}) — informe o motivo (obrigatório)
              </label>
              <input
                id="overrideReason"
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                className="h-14 rounded-field border-2 border-state-warning bg-surface-raised px-3 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          ) : null}
          {status.executionBlocked && status.blockedMessage ? <ExecutionBlockedBanner message={status.blockedMessage} /> : null}
          {confirmError ? (
            <p role="alert" className="text-base text-state-pending">
              {confirmError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={confirming || status.executionBlocked || (requiresOverride && !overrideReason.trim())}
            className="min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
          >
            {confirming ? 'Confirmando…' : 'Confirmar putaway'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
