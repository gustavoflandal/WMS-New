// DOC-15 §4.5 T1 — Minhas Tarefas. COL-2B: a fonte de dados vira a lista
// LOCAL (IndexedDB, `listExecutableTasks()` — os 5 tipos aprovisionados no
// Pacote de Turno, RF-ARQ-051), não mais `fieldApi.myTasks` (que só cobria
// PUTAWAY/REPOSICAO). Cada cartão navega para a tela de execução do tipo.
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PackagePlus, Repeat2, ShoppingCart, ClipboardCheck, ListChecks, MapPin } from 'lucide-react';
import { listExecutableTasks } from '../../lib/field/shift-package-store';
import { FieldTaskType, LocalTask } from '../../lib/field/field-db';

const STATUS_LABEL: Record<string, string> = {
  CREATED: 'Criada',
  ASSIGNED: 'Atribuída',
  IN_EXECUTION: 'Em execução',
  REJECTED_SCAN: 'Leitura rejeitada',
  CHECKING_PENDING: 'Conferência pendente',
  RECOUNT_PENDING: 'Recontagem pendente',
};

const TASK_TYPE_META: Record<FieldTaskType, { label: string; icon: typeof PackagePlus; route: string }> = {
  PUTAWAY: { label: 'Putaway', icon: PackagePlus, route: '/field/putaway' },
  REPOSICAO: { label: 'Reposição', icon: Repeat2, route: '/field/reposicao' },
  PICKING: { label: 'Picking', icon: ShoppingCart, route: '/field/picking' },
  CONFERENCIA: { label: 'Conferência', icon: ClipboardCheck, route: '/field/conferencia' },
  CONTAGEM_INVENTARIO: { label: 'Contagem', icon: ListChecks, route: '/field/contagem' },
};

function TaskCard({ task, onOpen }: { task: LocalTask; onOpen: () => void }): JSX.Element {
  const meta = TASK_TYPE_META[task.taskType];
  const Icon = meta.icon;
  const inProgress = task.localStatus === 'IN_PROGRESS';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[48px] w-full items-center gap-3 rounded-card border border-border-subtle bg-surface-raised p-4 text-left"
      >
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-subtle text-brand">
          <Icon aria-hidden="true" className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <p className="text-subtitle text-text-primary">{meta.label}</p>
          {task.lpn ? <p className="font-mono text-base text-text-primary">LPN {task.lpn}</p> : null}
          {task.productSku ? (
            <p className="text-base text-text-primary">
              {task.productSku} — {task.productDescription}
              {task.qty !== null ? ` · ${task.qty} UN` : ''}
            </p>
          ) : null}
          {task.locationCode ? (
            <p className="flex items-center gap-1 text-base text-text-secondary">
              <MapPin aria-hidden="true" className="h-4 w-4" /> {task.locationCode}
            </p>
          ) : null}
        </div>
        <span
          className={`rounded-full px-2 py-1 text-label ${
            inProgress ? 'bg-state-warning-bg text-state-warning' : 'bg-state-neutral-bg text-state-neutral'
          }`}
        >
          {inProgress ? 'Em andamento' : (STATUS_LABEL[task.status] ?? task.status)}
        </span>
      </button>
    </li>
  );
}

export default function FieldTasksPage(): JSX.Element {
  const router = useRouter();
  const [tasks, setTasks] = useState<LocalTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listExecutableTasks()
      .then((result) => {
        if (!cancelled) setTasks(result);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível carregar as tarefas locais.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Minhas tarefas</h1>
      {error ? (
        <p role="alert" className="text-base text-state-pending">
          {error}
        </p>
      ) : tasks === null ? (
        <p className="text-base text-text-secondary">Carregando…</p>
      ) : tasks.length === 0 ? (
        <p className="text-base text-text-secondary">Nenhuma tarefa pendente neste armazém. Toque em &quot;Atualizar&quot; no topo para buscar novas.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => (
            <TaskCard key={task.taskId} task={task} onOpen={() => router.push(`${TASK_TYPE_META[task.taskType].route}/${task.taskId}`)} />
          ))}
        </ul>
      )}
    </div>
  );
}
