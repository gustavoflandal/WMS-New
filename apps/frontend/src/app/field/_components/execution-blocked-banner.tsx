// DOC-15 RNF-ARQ-054/RNF-COL-050 — aviso compartilhado por T2-T6 quando
// `useFieldStatus().executionBlocked` está ativo: bloqueia a CONFIRMAÇÃO,
// nunca a leitura/consulta da tarefa já aberta (o operador ainda vê a tela).
'use client';

import React from 'react';
import { ShieldAlert } from 'lucide-react';

export function ExecutionBlockedBanner({ message }: { message: string }): JSX.Element {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-card border border-state-warning bg-state-warning-bg p-3">
      <ShieldAlert aria-hidden="true" className="mt-0.5 h-5 w-5 flex-shrink-0 text-state-warning" />
      <p className="text-base text-state-warning">{message}</p>
    </div>
  );
}
