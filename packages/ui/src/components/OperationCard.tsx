// DOC-10 RF-PAI-001 — cartão de operação do Painel (sistema de design §6
// "Cartão de operação"): número do documento em `data` (mono), tipo/cliente
// em `label`, etapa atual com o ícone do estado, tempo na etapa em `body`,
// atraso (--state-warning) e exceção (--state-blocked) como badges com
// texto — nunca só uma borda colorida sem rótulo (RG-013).
import React from 'react';
import { AlertTriangle, ShieldAlert, Clock } from 'lucide-react';
import { cn } from '../utils/cn';
import { StatusBadge } from './StatusBadge';

export interface OperationCardData {
  flowId: string;
  cardType: string;
  documentNumber: string | null;
  clientName: string | null;
  currentStepCode: string;
  timeInStepMinutes: number | null;
  hasPendingException: boolean;
  isLate: boolean;
}

export interface OperationCardProps extends React.HTMLAttributes<HTMLButtonElement> {
  card: OperationCardData;
  /** step_code -> rótulo textual (mesmo dicionário usado pelo FlowTrail para o mesmo flow_type). */
  stepLabel: string;
  onOpen: (card: OperationCardData) => void;
}

function formatTimeInStep(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
}

export function OperationCard({ card, stepLabel, onOpen, className, ...props }: OperationCardProps): JSX.Element {
  // Borda esquerda de 3px na cor do estado MAIS crítico presente no cartão
  // (sistema de design §6) — exceção bloqueante > atraso > neutro.
  const criticalBorder = card.hasPendingException ? 'border-l-state-blocked' : card.isLate ? 'border-l-state-warning' : 'border-l-transparent';

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      data-testid={`operation-card-${card.flowId}`}
      className={cn(
        'flex w-full flex-col gap-2 rounded-card border border-border-subtle border-l-[3px] bg-surface-raised p-4 text-left',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
        'hover:border-border-strong',
        criticalBorder,
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-data text-text-primary">{card.documentNumber ?? '—'}</span>
        <span className="text-label text-text-secondary">{card.cardType}</span>
      </div>
      <span className="text-label text-text-secondary">{card.clientName ?? 'Sem cliente'}</span>

      <div className="flex items-center gap-1.5 text-body text-text-primary">
        <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        <span>{stepLabel}</span>
        <span className="text-text-secondary">· {formatTimeInStep(card.timeInStepMinutes)}</span>
      </div>

      {(card.isLate || card.hasPendingException) && (
        <div className="flex flex-wrap gap-1.5">
          {card.isLate ? <StatusBadge tone="warning" icon={AlertTriangle} label="Atrasado" /> : null}
          {card.hasPendingException ? <StatusBadge tone="blocked" icon={ShieldAlert} label="Exceção pendente" /> : null}
        </div>
      )}
    </button>
  );
}
