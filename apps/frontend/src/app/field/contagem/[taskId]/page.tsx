// DOC-15 §4.5 T5 — Contagem de inventário (RF-COL-062).
//
// [INVIOLÁVEL] RN-COL-061: em NENHUM estado desta tela pode aparecer saldo do
// sistema, contagem de rodada anterior, ou qualquer indicação de divergência.
// `LocalTask.qty` já vem `null` do backend para CONTAGEM_INVENTARIO — esta
// tela NUNCA lê `task.qty` nem busca esse dado de outro lugar. A lista de
// itens exibida é só o que o PRÓPRIO operador digitou NESTA rodada (estado
// local do componente, nunca vindo do servidor).
//
// [INVIOLÁVEL] RN-COL-063: lista vazia -> "Encerrar endereço" fica
// desabilitado; só a ação separada "Declarar endereço vazio" (com confirmação
// extra) pode encerrar com countedQty=0.
//
// RN-COL-064: aviso preventivo de recontagem quando `task.status ===
// 'RECOUNT_PENDING'` — o cliente não tem como saber com certeza quem fez a 1ª
// rodada (decisão real é do servidor); o aviso é só informativo.
//
// [LACUNA]: conversão de embalagem ("2 CX12 = 24 UN", RN-DAD-021) exigiria o
// fator de conversão do produto, que não está disponível em `LocalTask` nem
// em nenhuma API já implementada para esta tarefa — a tela pede a quantidade
// diretamente em UN, sem exibir conversão.
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ListChecks, Trash2 } from 'lucide-react';
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

interface CountedItem {
  id: string;
  productCode: string;
  qty: number;
}

interface ContagemProgress {
  scannedLocationCode: string;
  items: CountedItem[];
}

export default function ContagemTaskPage({ params }: { params: { taskId: string } }): JSX.Element {
  const { warehouseId } = useAuth();
  const status = useFieldStatus();
  const [task, setTask] = useState<LocalTask | null | undefined>(undefined);
  const [locationRead, setLocationRead] = useState<string | null>(null);
  const [items, setItems] = useState<CountedItem[]>([]);
  const [manualCode, setManualCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scannedProduct, setScannedProduct] = useState<string | null>(null);
  const [itemQty, setItemQty] = useState('');
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
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
      const saved = found.progress as ContagemProgress | null;
      if (saved) {
        setLocationRead(saved.scannedLocationCode);
        setItems(saved.items ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params.taskId]);

  // Hooks (incl. useWedgeScanner) precisam rodar em TODO render, na MESMA
  // ordem — por isso ficam ANTES dos `return` condicionais de carregando/não
  // encontrada/concluída logo abaixo (Rules of Hooks: um hook chamado só
  // depois de um return condicional falta em alguns renders e sobra em
  // outros, causando "Rendered more hooks than during the previous render").
  // Cada handler guarda `task` internamente porque pode rodar antes dele
  // estar carregado.
  const persist = async (nextItems: CountedItem[], nextLocation: string): Promise<void> => {
    if (!task) return;
    const next: ContagemProgress = { scannedLocationCode: nextLocation, items: nextItems };
    await updateTaskProgress(task.taskId, next as unknown as Record<string, unknown>);
  };

  const handleAddressScan = async (raw: string): Promise<void> => {
    if (!task) return;
    setManualCode('');
    const result = validateExpectedType(raw, ['ENDERECO']);
    if (!result.ok) {
      feedback.trigger('error');
      setScanError(result.reason ?? 'Código inválido');
      return;
    }
    if (task.locationCode && result.classified.value !== task.locationCode) {
      feedback.trigger('error');
      setScanError('Endereço lido não corresponde à tarefa.');
      return;
    }
    feedback.trigger('ok');
    setScanError(null);
    setLocationRead(result.classified.value);
    await persist([], result.classified.value);
  };

  const handleProductScan = async (raw: string): Promise<void> => {
    setManualCode('');
    const result = validateExpectedType(raw, ['EAN13', 'EAN8', 'DUN14', 'LPN']);
    if (!result.ok) {
      feedback.trigger('error');
      setScanError(result.reason ?? 'Código inválido');
      return;
    }
    feedback.trigger('ok');
    setScanError(null);
    setScannedProduct(result.classified.value);
  };

  const enteringItem = locationRead !== null && scannedProduct === null;
  const wedgeEnabled = task != null && !confirmingEmpty && (locationRead === null || (enteringItem && scannedProduct === null));

  useWedgeScanner((code) => {
    if (locationRead === null) void handleAddressScan(code);
    else if (scannedProduct === null) void handleProductScan(code);
  }, wedgeEnabled);

  if (task === undefined) return <p className="text-base text-text-secondary">Carregando…</p>;
  if (task === null) return <TaskNotFoundPanel />;

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 pt-12 text-center">
        <CheckCircle2 aria-hidden="true" className="h-10 w-10 text-state-done" />
        <p className="text-base text-text-primary">Contagem do endereço registrada com sucesso.</p>
        <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
          Voltar para minhas tarefas
        </Link>
      </div>
    );
  }

  const handleAddItem = async (): Promise<void> => {
    if (!scannedProduct || itemQty === '') return;
    const qtyNumber = Number(itemQty);
    const nextItems: CountedItem[] = [...items, { id: `${Date.now()}-${items.length}`, productCode: scannedProduct, qty: qtyNumber }];
    setItems(nextItems);
    setScannedProduct(null);
    setItemQty('');
    await persist(nextItems, locationRead!);
  };

  const handleRemoveItem = async (id: string): Promise<void> => {
    const nextItems = items.filter((i) => i.id !== id);
    setItems(nextItems);
    await persist(nextItems, locationRead!);
  };

  const total = items.reduce((sum, i) => sum + i.qty, 0);

  const handleCloseWithItems = async (): Promise<void> => {
    if (!warehouseId || items.length === 0) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'CONTAGEM_INVENTARIO',
        payload: { countedQty: total },
        warehouseId,
        appVersion: APP_VERSION,
      });
      setDone(true);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Não foi possível registrar a contagem.');
    } finally {
      setConfirming(false);
    }
  };

  const handleDeclareEmpty = async (): Promise<void> => {
    if (!warehouseId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        taskType: 'CONTAGEM_INVENTARIO',
        payload: { countedQty: 0 },
        warehouseId,
        appVersion: APP_VERSION,
      });
      setDone(true);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Não foi possível registrar a contagem.');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ListChecks aria-hidden="true" className="h-6 w-6 text-brand" />
        <h1 className="text-title text-text-primary">Contagem de inventário</h1>
      </div>

      {task.status === 'RECOUNT_PENDING' ? (
        <p role="alert" className="rounded-card border border-state-warning bg-state-warning-bg p-3 text-base text-state-warning">
          Esta é uma recontagem. Se você fez a 1ª contagem deste endereço, o servidor pode rejeitar por exigir operador diferente.
        </p>
      ) : null}

      {locationRead === null ? (
        <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
          <p className="mb-2 text-subtitle text-text-primary">Passo 1 — Ler a etiqueta do endereço</p>
          <p className="mb-3 text-base text-text-secondary">Use o leitor físico ou digite o código abaixo.</p>
          <div className="flex gap-2">
            <input
              type="text"
              aria-label="Código do endereço"
              autoCapitalize="characters"
              inputMode="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              className="h-14 flex-1 rounded-field border-2 border-border-strong bg-surface-raised px-3 font-mono text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <button
              type="button"
              onClick={() => void handleAddressScan(manualCode)}
              disabled={!manualCode}
              className="min-h-[56px] rounded-field bg-brand px-4 text-base font-semibold text-white disabled:opacity-50"
            >
              Ler
            </button>
          </div>
          {scanError ? (
            <p role="alert" className="mt-2 text-base text-state-pending">
              {scanError}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-base text-text-secondary">
            Endereço: <span className="font-mono text-text-primary">{locationRead}</span>
          </p>

          <div className="rounded-card border border-border-subtle bg-surface-raised p-4">
            <p className="mb-2 text-subtitle text-text-primary">Itens contados nesta rodada</p>
            {items.length === 0 ? (
              <p className="text-base text-text-secondary">Nenhum item contado ainda nesta rodada.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 border-b border-border-subtle pb-2 text-base">
                    <span className="font-mono text-text-primary">{item.productCode}</span>
                    <span className="font-mono tabular-nums text-text-primary">{item.qty} UN</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveItem(item.id)}
                      aria-label={`Remover item ${item.productCode}`}
                      className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-field text-state-pending"
                    >
                      <Trash2 aria-hidden="true" className="h-5 w-5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {scannedProduct === null ? (
            <div className={`rounded-card border-2 p-4 ${scanFeedbackBorderClass(feedback.flash)}`}>
              <p className="mb-2 text-subtitle text-text-primary">Ler produto/LPN para adicionar um item</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label="Código do produto"
                  autoCapitalize="characters"
                  inputMode="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  className="h-14 flex-1 rounded-field border-2 border-border-strong bg-surface-raised px-3 font-mono text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
                <button
                  type="button"
                  onClick={() => void handleProductScan(manualCode)}
                  disabled={!manualCode}
                  className="min-h-[56px] rounded-field bg-brand px-4 text-base font-semibold text-white disabled:opacity-50"
                >
                  Ler
                </button>
              </div>
              {scanError ? (
                <p role="alert" className="mt-2 text-base text-state-pending">
                  {scanError}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-card border border-border-subtle bg-surface-raised p-4">
              <p className="text-base text-text-primary">
                Produto lido: <span className="font-mono">{scannedProduct}</span>
              </p>
              <div className="flex flex-col gap-1">
                <label htmlFor="itemQty" className="text-label text-text-secondary">
                  Quantidade contada nesta leitura (UN)
                </label>
                <input
                  id="itemQty"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={itemQty}
                  onChange={(e) => setItemQty(e.target.value.replace(/\D/g, ''))}
                  className="h-16 rounded-field border-2 border-border-strong bg-surface-raised px-3 text-center font-mono text-data-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleAddItem()}
                disabled={itemQty === ''}
                className="min-h-[48px] rounded-field bg-brand text-base font-semibold text-white disabled:opacity-50"
              >
                Adicionar item
              </button>
              <button
                type="button"
                onClick={() => setScannedProduct(null)}
                className="min-h-[48px] rounded-field border-2 border-border-strong text-base text-text-primary"
              >
                Cancelar leitura
              </button>
            </div>
          )}

          {status.executionBlocked && status.blockedMessage ? <ExecutionBlockedBanner message={status.blockedMessage} /> : null}
          {confirmError ? (
            <p role="alert" className="text-base text-state-pending">
              {confirmError}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void handleCloseWithItems()}
              disabled={confirming || status.executionBlocked || items.length === 0}
              className="min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
            >
              {confirming ? 'Encerrando…' : `Encerrar endereço (total ${total} UN)`}
            </button>

            {!confirmingEmpty ? (
              <button
                type="button"
                onClick={() => setConfirmingEmpty(true)}
                disabled={confirming || status.executionBlocked || items.length > 0}
                className="min-h-[48px] rounded-field border-2 border-border-strong text-base text-text-secondary disabled:opacity-50"
              >
                Declarar endereço vazio
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-card border-2 border-state-warning bg-state-warning-bg p-3">
                <p className="text-base text-state-warning">Confirma que não há nenhum item neste endereço?</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleDeclareEmpty()}
                    disabled={confirming || status.executionBlocked}
                    className="min-h-[48px] flex-1 rounded-field bg-state-warning text-base font-semibold text-white disabled:opacity-50"
                  >
                    Confirmar endereço vazio
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingEmpty(false)}
                    className="min-h-[48px] flex-1 rounded-field border-2 border-border-strong text-base text-text-primary"
                  >
                    Voltar
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
