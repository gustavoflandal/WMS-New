// DOC-15 §4.5 T6 (metade "Reposição", RF-EST-042) — dupla leitura: endereço
// ORIGEM (`task.locationCodeOrigin`) → endereço DESTINO (`task.locationCode`).
// RF-COL-021: passo atual persistido a cada leitura.
//
// [DEBITO: T6 "Transferência ad-hoc" (RF-EST-050, sem tarefa dirigida) não
// implementada nesta sessão — o payload de TRANSFERENCIA exige IDs resolvidos
// de produto/endereço (não códigos escaneados), e não há rota de busca no
// backend hoje que devolva o `locationId` isolado a partir de um código
// escaneado (`/campo/consulta` devolve saldo, não o id do location). Abrir
// uma rota nova no backend está fora do escopo desta sessão de FRONTEND —
// alvo: sessão futura de DOC-15/estoque. Reposição dirigida (este arquivo)
// cobre o caso comum, que já vem com tarefa pré-aprovisionada.]
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Repeat2 } from 'lucide-react';
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

interface ReposicaoProgress {
  step: 'destino' | 'confirm';
  scannedLocationCodeFrom: string;
  scannedLocationCodeTo?: string;
}

export default function ReposicaoTaskPage({ params }: { params: { taskId: string } }): JSX.Element {
  const { warehouseId } = useAuth();
  const status = useFieldStatus();
  const [task, setTask] = useState<LocalTask | null | undefined>(undefined);
  const [progress, setProgress] = useState<ReposicaoProgress | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
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
      setProgress(found.progress as ReposicaoProgress | null);
    });
    return () => {
      cancelled = true;
    };
  }, [params.taskId]);

  const step: 'origem' | 'destino' | 'confirm' = progress?.step ?? 'origem';

  const handleScan = async (raw: string): Promise<void> => {
    if (!task) return;
    setManualCode('');
    const result = validateExpectedType(raw, ['ENDERECO']);
    if (!result.ok) {
      feedback.trigger('error');
      setScanError(result.reason ?? 'Código inválido');
      return;
    }
    if (step === 'origem') {
      if (task.locationCodeOrigin && result.classified.value !== task.locationCodeOrigin) {
        feedback.trigger('error');
        setScanError('Endereço de origem lido não corresponde à tarefa.');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: ReposicaoProgress = { step: 'destino', scannedLocationCodeFrom: result.classified.value };
      await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
      setProgress(next);
      return;
    }
    if (step === 'destino') {
      if (task.locationCode && result.classified.value !== task.locationCode) {
        feedback.trigger('error');
        setScanError('Endereço de destino lido não corresponde à tarefa.');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: ReposicaoProgress = {
        step: 'confirm',
        scannedLocationCodeFrom: progress!.scannedLocationCodeFrom,
        scannedLocationCodeTo: result.classified.value,
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
        <p className="text-base text-text-primary">Reposição registrada com sucesso.</p>
        <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
          Voltar para minhas tarefas
        </Link>
      </div>
    );
  }

  const handleConfirm = async (): Promise<void> => {
    if (!warehouseId || !progress?.scannedLocationCodeTo) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'REPOSICAO',
        payload: {
          scannedLocationCodeFrom: progress.scannedLocationCodeFrom,
          scannedLocationCodeTo: progress.scannedLocationCodeTo,
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
        <Repeat2 aria-hidden="true" className="h-6 w-6 text-brand" />
        <h1 className="text-title text-text-primary">Reposição</h1>
      </div>
      <p className="text-base text-text-secondary">
        {task.locationCodeOrigin ? (
          <>
            Origem: <span className="font-mono text-text-primary">{task.locationCodeOrigin}</span>
            {' · '}
          </>
        ) : null}
        {task.locationCode ? (
          <>
            Destino: <span className="font-mono text-text-primary">{task.locationCode}</span>
          </>
        ) : null}
      </p>

      {step === 'origem' || step === 'destino' ? (
        <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
          <p className="mb-2 text-subtitle text-text-primary">{step === 'origem' ? 'Passo 1 — Ler endereço de origem' : 'Passo 2 — Ler endereço de destino'}</p>
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
            Origem: <span className="font-mono">{progress?.scannedLocationCodeFrom}</span>
          </p>
          <p className="text-base text-text-primary">
            Destino: <span className="font-mono">{progress?.scannedLocationCodeTo}</span>
          </p>
          {status.executionBlocked && status.blockedMessage ? <ExecutionBlockedBanner message={status.blockedMessage} /> : null}
          {confirmError ? (
            <p role="alert" className="text-base text-state-pending">
              {confirmError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={confirming || status.executionBlocked}
            className="min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
          >
            {confirming ? 'Confirmando…' : 'Confirmar reposição'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
