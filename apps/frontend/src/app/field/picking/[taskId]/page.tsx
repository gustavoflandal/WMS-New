// DOC-15 §4.5 T3 — Picking. Ler endereço → ler produto/LPN → confirmar
// quantidade (teclado numérico). O cliente só valida o TIPO do código lido
// (RN-COL-012) — o valor exato é conferido pelo backend (`PickingTaskService.
// executeTask`), corte tratado por RN-EXP-032 já no servidor. RF-COL-021: o
// passo atual é persistido a cada leitura.
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ShoppingCart } from 'lucide-react';
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

interface PickingProgress {
  step: 'product' | 'qty';
  scannedLocationCode: string;
  scannedProductCode?: string;
}

export default function PickingTaskPage({ params }: { params: { taskId: string } }): JSX.Element {
  const { warehouseId } = useAuth();
  const status = useFieldStatus();
  const [task, setTask] = useState<LocalTask | null | undefined>(undefined);
  const [progress, setProgress] = useState<PickingProgress | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [reasonText, setReasonText] = useState('');
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
      const saved = found.progress as PickingProgress | null;
      setProgress(saved);
      if (saved?.step === 'qty') setQty(String(found.qty ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [params.taskId]);

  const step: 'location' | 'product' | 'qty' = progress?.step ?? 'location';

  const handleScan = async (raw: string): Promise<void> => {
    if (!task) return;
    setManualCode('');
    if (step === 'location') {
      const result = validateExpectedType(raw, ['ENDERECO']);
      if (!result.ok) {
        feedback.trigger('error');
        setScanError(result.reason ?? 'Código inválido');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: PickingProgress = { step: 'product', scannedLocationCode: result.classified.value };
      await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
      setProgress(next);
      return;
    }
    if (step === 'product') {
      const result = validateExpectedType(raw, ['EAN13', 'EAN8', 'DUN14', 'LPN']);
      if (!result.ok) {
        feedback.trigger('error');
        setScanError(result.reason ?? 'Código inválido');
        return;
      }
      feedback.trigger('ok');
      setScanError(null);
      const next: PickingProgress = {
        step: 'qty',
        scannedLocationCode: progress!.scannedLocationCode,
        scannedProductCode: result.classified.value,
      };
      await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
      setProgress(next);
      setQty(task.qty !== null ? String(task.qty) : '');
    }
  };

  useWedgeScanner((code) => void handleScan(code), step !== 'qty' && task != null);

  if (task === undefined) return <p className="text-base text-text-secondary">Carregando…</p>;
  if (task === null) return <TaskNotFoundPanel />;

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 pt-12 text-center">
        <CheckCircle2 aria-hidden="true" className="h-10 w-10 text-state-done" />
        <p className="text-base text-text-primary">Picking registrado com sucesso.</p>
        <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
          Voltar para minhas tarefas
        </Link>
      </div>
    );
  }

  const qtyNumber = qty === '' ? null : Number(qty);
  const qtyDiffers = qtyNumber !== null && task.qty !== null && qtyNumber !== task.qty;

  const handleConfirm = async (): Promise<void> => {
    if (!warehouseId || !progress?.scannedProductCode || qtyNumber === null) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'PICKING',
        payload: {
          scannedLocationCode: progress.scannedLocationCode,
          scannedProductCode: progress.scannedProductCode,
          qtyConfirmed: qtyNumber,
          // [LACUNA]: nenhum catálogo de reasonCode acessível ao frontend
          // nesta sessão — a descrição do motivo vai em reasonText; reasonCode
          // fica null quando a quantidade diverge da sugerida.
          reasonCode: qtyDiffers ? null : undefined,
          reasonText: qtyDiffers ? reasonText : undefined,
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
        <ShoppingCart aria-hidden="true" className="h-6 w-6 text-brand" />
        <h1 className="text-title text-text-primary">Picking</h1>
      </div>
      <p className="text-base text-text-secondary">
        {task.productSku ? (
          <>
            Produto: <span className="text-text-primary">{task.productSku} — {task.productDescription}</span>
            {' · '}
          </>
        ) : null}
        {task.locationCode ? (
          <>
            Endereço: <span className="font-mono text-text-primary">{task.locationCode}</span>
          </>
        ) : null}
        {task.qty !== null ? ` · Quantidade sugerida: ${task.qty} UN` : null}
      </p>

      {(step === 'location' || step === 'product') ? (
        <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
          <p className="mb-2 text-subtitle text-text-primary">
            {step === 'location' ? 'Passo 1 — Ler o endereço' : 'Passo 2 — Ler o produto/LPN'}
          </p>
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

      {step === 'qty' ? (
        <div className="flex flex-col gap-3 rounded-card border border-border-subtle bg-surface-raised p-4">
          <p className="text-subtitle text-text-primary">Passo 3 — Confirmar quantidade</p>
          <div className="flex flex-col gap-1">
            <label htmlFor="qty" className="text-label text-text-secondary">
              Quantidade separada (UN)
            </label>
            <input
              id="qty"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
              className="h-16 rounded-field border-2 border-border-strong bg-surface-raised px-3 text-center font-mono text-data-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
          {qtyDiffers ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="reasonText" className="text-label text-state-warning">
                Quantidade diferente da sugerida ({task.qty} UN) — informe o motivo (obrigatório)
              </label>
              <input
                id="reasonText"
                type="text"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
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
            disabled={confirming || status.executionBlocked || qtyNumber === null || (qtyDiffers && !reasonText.trim())}
            className="min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
          >
            {confirming ? 'Confirmando…' : 'Confirmar picking'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
