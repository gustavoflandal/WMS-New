// DOC-15 — painel compartilhado por T2-T6: nunca deixar uma tela em branco
// quando a tarefa local não existe ou já saiu do conjunto executável
// (PENDING/IN_PROGRESS). Pasta com `_` não vira rota (convenção App Router).
'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

export function TaskNotFoundPanel({ message }: { message?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 pt-12 text-center">
      <AlertTriangle aria-hidden="true" className="h-10 w-10 text-state-pending" />
      <p className="text-base text-text-primary">{message ?? 'Tarefa não encontrada ou já concluída.'}</p>
      <Link href="/field" className="flex min-h-[48px] items-center rounded-field bg-brand px-6 text-base font-semibold text-white">
        Voltar para minhas tarefas
      </Link>
    </div>
  );
}
