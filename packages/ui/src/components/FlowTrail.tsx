// DOC-10 RF-PAI-005 (apresentação de RN-EXP-011) + DOC-17 §2 [O CORAÇÃO] —
// trilha horizontal das etapas do Fluxo Operacional. Componente ÚNICO e
// reutilizável: serve pedido, recebimento, reversa, transferência e
// inventário sem variação por tipo — a variação fica inteiramente nos
// `steps`/`stepLabels` que o chamador passa, vindos do MESMO contrato da 6A
// (OperationFlowService.getFlowState(), consumido via
// GET /fluxo-operacional/:entity/:entityId).
//
// DOC-17 §2 [INVIOLÁVEL] — separa DETALHE de EXECUÇÃO: "o clique SEMPRE
// abre; o que varia é o que a tela permite fazer". Isto supersede o
// comportamento anterior de RN-EXP-011 item 3 ("etapa posterior é inerte")
// — agora TODA etapa (concluída, acionável, bloqueada ou futura) chama
// `onStepOpen`; quem decide o que renderizar (consulta/execução/previsão/
// bloqueio) é o consumidor, buscando o detalhe real em
// GET .../steps/:stepCode/detail (contrato da Sessão 10A) — a guarda de
// ordem continua exclusivamente no serviço (FLOW_STEP_ORDER_VIOLATION),
// nunca na interface.
//
// Acessibilidade [INVIOLÁVEL] (RG-013, sistema de design §5):
// - cor NUNCA sozinha — todo estado tem ícone Lucide + rótulo textual;
// - `role="list"`/`role="listitem"`, `aria-current="step"` na etapa "da
//   vez" (acionável ou bloqueada — RN-EXP-011 regra 5: o fluxo trava ali);
// - TODAS as etapas são interativas agora (DOC-17 §2) — todas entram no Tab;
// - `prefers-reduced-motion` respeitado via `transition-none` quando ativo
//   (a troca de cor em si não anima, só o realce de foco).
import React from 'react';
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
  /**
   * DOC-17 §2: chamado para QUALQUER etapa clicada — concluída, acionável,
   * bloqueada ou futura. O consumidor busca o detalhe real (modo,
   * conteúdo, ações) em GET .../steps/:stepCode/detail; este componente não
   * decide mais o que a etapa "pode" fazer, só relata a intenção de abrir.
   */
  onStepOpen: (step: FlowStepData) => void;
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

export function FlowTrail({ steps, stepLabels, onStepOpen, className }: FlowTrailProps): JSX.Element {
  return (
    <ol role="list" className={cn('flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch md:gap-3', className)}>
      {steps.map((step) => {
        const visual = resolveVisual(step, step.is_actionable);
        const label = stepLabels[step.step_code] ?? step.step_code;
        const isFuture = step.status !== 'DONE' && !step.is_actionable && !step.is_blocked;

        return (
          <li key={step.step_code} role="listitem" className="flex-1 md:min-w-[180px]">
            <button
              type="button"
              onClick={() => onStepOpen(step)}
              // aria-current marca a etapa "da vez" — a acionável OU, se
              // bloqueada, a que estaria na vez (RN-EXP-011 regra 5: o fluxo
              // trava ali, é ali que o usuário precisa olhar).
              aria-current={step.is_actionable || step.is_blocked ? 'step' : undefined}
              data-testid={`flow-step-${step.step_code}`}
              data-status={step.status}
              data-actionable={step.is_actionable}
              data-blocked={step.is_blocked}
              className={cn(
                'flex w-full cursor-pointer flex-col gap-1 rounded-card border p-3 text-left transition-colors motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
                visual.bgClass,
                step.is_actionable ? 'border-2 border-state-pending' : 'border-border-subtle',
                isFuture && 'opacity-45'
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
          </li>
        );
      })}
    </ol>
  );
}
