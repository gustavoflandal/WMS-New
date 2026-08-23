// DOC-10 RF-PAI-005 (apresentação de RN-EXP-011) [O CORAÇÃO] — trilha
// horizontal das etapas do Fluxo Operacional. Componente ÚNICO e
// reutilizável: serve pedido, recebimento, reversa, transferência e
// inventário sem variação por tipo — a variação fica inteiramente nos
// `steps`/`stepLabels` que o chamador passa, vindos do MESMO contrato da 6A
// (OperationFlowService.getFlowState(), consumido via
// GET /fluxo-operacional/:entity/:entityId).
//
// Acessibilidade [INVIOLÁVEL] (RG-013, sistema de design §5):
// - cor NUNCA sozinha — todo estado tem ícone Lucide + rótulo textual;
// - `role="list"`/`role="listitem"`, `aria-current="step"` na acionável,
//   `aria-disabled` nas futuras;
// - só etapas interativas (acionável, concluída, bloqueada com alçada)
//   entram no Tab — futuras não-interativas usam `tabIndex={-1}` deliberado
//   (ver comentário na etapa "future" abaixo — não é a mesma coisa que
//   "sem foco nenhum": o clique/Enter nelas ainda funciona via mouse e a
//   mensagem de aviso é sempre anunciada por `role="alert"`);
// - `prefers-reduced-motion` respeitado via `transition-none` quando ativo
//   (a troca de cor em si não anima, só o realce de foco).
import React, { useState } from 'react';
import { CheckCircle2, Circle, CircleDot, ShieldAlert, type LucideIcon } from 'lucide-react';
import { cn } from '../utils/cn';

export interface FlowStepBlockingException {
  id: string;
  type: string;
  status: string;
}

export interface FlowStepCompletedBy {
  id: string;
  name: string;
}

export interface FlowStepData {
  step_code: string;
  sequence_order: number;
  status: 'DONE' | 'PENDING';
  started_at: string | null;
  completed_at: string | null;
  is_actionable: boolean;
  opens_read_only: boolean;
  is_blocked: boolean;
  blocking_exception: FlowStepBlockingException | null;
  completed_by: FlowStepCompletedBy | null;
}

export interface FlowTrailProps {
  steps: FlowStepData[];
  /** step_code -> rótulo textual exibido (o contrato da 6A só devolve o código). */
  stepLabels: Record<string, string>;
  /** Chamado para a etapa acionável ou concluída (abre em consulta) — nunca para uma futura inerte. */
  onStepOpen: (step: FlowStepData, mode: 'action' | 'readonly') => void;
  /** Se o usuário atual tem alçada para decidir a exceção que bloqueia a etapa (RF-PAI-005 item 5). Sem isto, o indicador aparece mas não é clicável. */
  onExceptionOpen?: (exception: FlowStepBlockingException) => void;
  hasAlcadaForException?: (exception: FlowStepBlockingException) => boolean;
  className?: string;
}

interface StepVisual {
  icon: LucideIcon;
  label: string;
  toneClass: string;
  bgClass: string;
}

function resolveVisual(step: FlowStepData, isFirstPendingOverall: boolean): StepVisual {
  if (step.status === 'DONE') {
    return { icon: CheckCircle2, label: 'Concluída', toneClass: 'text-state-done', bgClass: 'bg-state-done-bg' };
  }
  if (step.is_blocked) {
    return { icon: ShieldAlert, label: 'Bloqueada · aguardando aprovação', toneClass: 'text-state-blocked', bgClass: 'bg-state-blocked-bg' };
  }
  if (step.is_actionable) {
    return { icon: CircleDot, label: 'Pendente · iniciar', toneClass: 'text-state-pending', bgClass: 'bg-state-pending-bg' };
  }
  void isFirstPendingOverall;
  return { icon: Circle, label: 'Aguardando etapa anterior', toneClass: 'text-state-pending', bgClass: 'bg-transparent' };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function FlowTrail({ steps, stepLabels, onStepOpen, onExceptionOpen, hasAlcadaForException, className }: FlowTrailProps): JSX.Element {
  const [inertWarningStep, setInertWarningStep] = useState<string | null>(null);

  const handleStepActivate = (step: FlowStepData): void => {
    if (step.status === 'DONE') {
      onStepOpen(step, 'readonly');
      return;
    }
    if (step.is_blocked) {
      if (step.blocking_exception && onExceptionOpen && hasAlcadaForException?.(step.blocking_exception)) {
        onExceptionOpen(step.blocking_exception);
      }
      return;
    }
    if (step.is_actionable) {
      setInertWarningStep(null);
      onStepOpen(step, 'action');
      return;
    }
    // RN-EXP-011 — etapa posterior: inerte, com aviso (não abre nada).
    setInertWarningStep(step.step_code);
  };

  return (
    <ol role="list" className={cn('flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch md:gap-3', className)}>
      {steps.map((step) => {
        const visual = resolveVisual(step, step.is_actionable);
        const label = stepLabels[step.step_code] ?? step.step_code;
        const isInteractive = step.status === 'DONE' || step.is_actionable || (step.is_blocked && !!step.blocking_exception && !!hasAlcadaForException?.(step.blocking_exception));

        return (
          <li key={step.step_code} role="listitem" className="flex-1 md:min-w-[180px]">
            <button
              type="button"
              onClick={() => handleStepActivate(step)}
              // aria-current marca a etapa "da vez" — a acionável OU, se
              // bloqueada, a que estaria na vez (RN-EXP-011 regra 5: o fluxo
              // trava ali, é ali que o usuário precisa olhar).
              aria-current={step.is_actionable || step.is_blocked ? 'step' : undefined}
              aria-disabled={!isInteractive}
              // Etapas futuras não-interativas ficam fora da ordem de Tab
              // (mouse/toque ainda funcionam e mostram o aviso) — só
              // acionável/concluída/bloqueada-com-alçada entram no teclado,
              // conforme "só etapas interativas" no cabeçalho do arquivo.
              tabIndex={isInteractive ? 0 : -1}
              data-testid={`flow-step-${step.step_code}`}
              data-status={step.status}
              data-actionable={step.is_actionable}
              data-blocked={step.is_blocked}
              className={cn(
                'flex w-full flex-col gap-1 rounded-card border p-3 text-left transition-colors motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
                visual.bgClass,
                step.is_actionable ? 'border-2 border-state-pending cursor-pointer' : 'border-border-subtle',
                !isInteractive && !step.is_actionable && 'opacity-45 cursor-default',
                isInteractive && !step.is_actionable && 'cursor-pointer'
              )}
            >
              <span className={cn('flex items-center gap-2 text-subtitle', visual.toneClass)}>
                <visual.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {label}
              </span>
              <span className={cn('text-label', visual.toneClass)}>
                {visual.label}
                {step.status === 'DONE' && step.completed_at ? ` · ${formatTimestamp(step.completed_at)}` : null}
              </span>
              {step.status === 'DONE' && step.completed_by ? <span className="text-label text-text-secondary">{step.completed_by.name}</span> : null}
            </button>
            {inertWarningStep === step.step_code ? (
              <p role="alert" data-testid={`flow-step-warning-${step.step_code}`} className="mt-1 text-label text-state-pending">
                Conclua a etapa anterior
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
