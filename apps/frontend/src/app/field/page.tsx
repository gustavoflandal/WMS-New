// DOC-15 §4.5 T1 — Minhas Tarefas. Lista (não executa) — a execução das
// tarefas (T2 Putaway, T3 Picking, T4 Conferência, T5 Contagem, T6
// Transferência) é da Sessão COL-2 (offline). Ver
// docs/PROMPT-SESSAO-COL1-pwa-coletor.md §1.
'use client';

import React, { useEffect, useState } from 'react';
import { PackageSearch, MapPin } from 'lucide-react';
import { useAuth, ApiError } from '../../lib/auth-context';
import { fieldApi, MyTaskDto } from '../../lib/field/field-api';

const STATUS_LABEL: Record<string, string> = {
  CREATED: 'Criada',
  ASSIGNED: 'Atribuída',
  IN_EXECUTION: 'Em execução',
  REJECTED_SCAN: 'Leitura rejeitada',
};

function TaskCard({ task }: { task: MyTaskDto }): JSX.Element {
  return (
    <li className="flex items-center gap-3 rounded-card border border-border-subtle bg-surface-raised p-4">
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-subtle text-brand">
        <PackageSearch aria-hidden="true" className="h-6 w-6" />
      </div>
      <div className="flex-1">
        <p className="text-subtitle text-text-primary">{task.type === 'PUTAWAY' ? 'Putaway' : 'Reposição'}</p>
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
      <span className="rounded-full bg-state-neutral-bg px-2 py-1 text-label text-state-neutral">{STATUS_LABEL[task.status] ?? task.status}</span>
    </li>
  );
}

export default function FieldTasksPage(): JSX.Element {
  const { warehouseId } = useAuth();
  const [tasks, setTasks] = useState<MyTaskDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!warehouseId) return;
    fieldApi
      .myTasks(warehouseId)
      .then(setTasks)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as tarefas.'));
  }, [warehouseId]);

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
        <p className="text-base text-text-secondary">Nenhuma tarefa atribuída a você no momento.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </ul>
      )}
      <p className="text-label text-text-secondary">
        A execução de putaway, picking, conferência, contagem e transferência entra na próxima versão do coletor (offline).
      </p>
    </div>
  );
}
