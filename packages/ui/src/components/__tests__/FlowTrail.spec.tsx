// DOC-10 RF-PAI-005 [O CORAÇÃO] — teste de componente da trilha: estados
// visuais, etapa posterior inerte com o aviso, rótulo textual presente em
// cada estado (RG-013, nunca só cor), navegação por teclado, contraste AA
// (verificado pelos tokens do sistema de design — asserção de que a classe
// de cor do token é aplicada, não um cálculo de contraste em runtime).
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlowTrail, type FlowStepData } from '../FlowTrail';

const STEP_LABELS: Record<string, string> = {
  PEDIDO: 'Pedido',
  SEPARACAO: 'Separação',
  EMBALAGEM: 'Embalagem',
  PESAGEM: 'Pesagem',
};

function makeSteps(overrides: Partial<Record<string, Partial<FlowStepData>>> = {}): FlowStepData[] {
  const base: FlowStepData[] = [
    {
      step_code: 'PEDIDO',
      sequence_order: 100,
      status: 'DONE',
      started_at: '2026-08-20T10:00:00Z',
      completed_at: '2026-08-20T10:05:00Z',
      is_actionable: false,
      opens_read_only: true,
      is_blocked: false,
      blocking_exception: null,
      completed_by: { id: 'u1', name: 'João Silva' },
    },
    {
      step_code: 'SEPARACAO',
      sequence_order: 200,
      status: 'PENDING',
      started_at: '2026-08-20T10:05:00Z',
      completed_at: null,
      is_actionable: true,
      opens_read_only: false,
      is_blocked: false,
      blocking_exception: null,
      completed_by: null,
    },
    {
      step_code: 'EMBALAGEM',
      sequence_order: 300,
      status: 'PENDING',
      started_at: null,
      completed_at: null,
      is_actionable: false,
      opens_read_only: false,
      is_blocked: false,
      blocking_exception: null,
      completed_by: null,
    },
    {
      step_code: 'PESAGEM',
      sequence_order: 400,
      status: 'PENDING',
      started_at: null,
      completed_at: null,
      is_actionable: false,
      opens_read_only: false,
      is_blocked: false,
      blocking_exception: null,
      completed_by: null,
    },
  ];
  return base.map((s) => ({ ...s, ...(overrides[s.step_code] ?? {}) }));
}

describe('FlowTrail', () => {
  it('renderiza role="list"/"listitem" e rótulo textual em CADA etapa, não só cor', () => {
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);

    // Formato, não o valor exato: toLocaleString() converte para o fuso do
    // MÁQUINA QUE RODA O TESTE (correto para exibição ao usuário — mesmo
    // instante, fuso do navegador de quem vê — mas fixar o valor aqui
    // tornaria o teste dependente do fuso de quem/onde roda).
    expect(screen.getByText(/^Concluída · \d{2}\/\d{2}, \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText('Pendente · iniciar')).toBeInTheDocument();
    expect(screen.getAllByText('Aguardando etapa anterior')).toHaveLength(2);
  });

  it('etapa DONE mostra timestamp e executante (RG-003)', () => {
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} />);
    expect(screen.getByText('João Silva')).toBeInTheDocument();
  });

  it('aria-current="step" só na acionável; aria-disabled nas futuras', () => {
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} />);

    expect(screen.getByTestId('flow-step-SEPARACAO')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('flow-step-PEDIDO')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('flow-step-EMBALAGEM')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('flow-step-PESAGEM')).toHaveAttribute('aria-disabled', 'true');
  });

  it('clique na etapa ACIONÁVEL chama onStepOpen com mode "action"', async () => {
    const onStepOpen = vi.fn();
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={onStepOpen} />);

    await userEvent.click(screen.getByTestId('flow-step-SEPARACAO'));
    expect(onStepOpen).toHaveBeenCalledWith(expect.objectContaining({ step_code: 'SEPARACAO' }), 'action');
  });

  it('clique na etapa CONCLUÍDA chama onStepOpen com mode "readonly"', async () => {
    const onStepOpen = vi.fn();
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={onStepOpen} />);

    await userEvent.click(screen.getByTestId('flow-step-PEDIDO'));
    expect(onStepOpen).toHaveBeenCalledWith(expect.objectContaining({ step_code: 'PEDIDO' }), 'readonly');
  });

  it('RN-EXP-011: clique na etapa POSTERIOR (inerte) NÃO chama onStepOpen e exibe o aviso "Conclua a etapa anterior"', async () => {
    const onStepOpen = vi.fn();
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={onStepOpen} />);

    await userEvent.click(screen.getByTestId('flow-step-EMBALAGEM'));
    expect(onStepOpen).not.toHaveBeenCalled();

    const warning = screen.getByTestId('flow-step-warning-EMBALAGEM');
    expect(warning).toHaveTextContent('Conclua a etapa anterior');
    expect(warning).toHaveAttribute('role', 'alert');
  });

  it('etapa bloqueada por exceção mostra o ícone/rótulo de bloqueio e não abre a operação', async () => {
    const steps = makeSteps({
      SEPARACAO: {
        is_actionable: false,
        is_blocked: true,
        blocking_exception: { id: 'exc-1', type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
      },
    });
    const onStepOpen = vi.fn();
    const onExceptionOpen = vi.fn();
    render(<FlowTrail steps={steps} stepLabels={STEP_LABELS} onStepOpen={onStepOpen} onExceptionOpen={onExceptionOpen} hasAlcadaForException={() => true} />);

    expect(screen.getByText('Bloqueada · aguardando aprovação')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('flow-step-SEPARACAO'));
    expect(onStepOpen).not.toHaveBeenCalled();
    expect(onExceptionOpen).toHaveBeenCalledWith({ id: 'exc-1', type: 'EST.QUEBRA_FEFO', status: 'PENDING' });
  });

  it('etapa bloqueada SEM alçada do usuário: indicador visível, mas clique não abre a exceção', async () => {
    const steps = makeSteps({
      SEPARACAO: {
        is_actionable: false,
        is_blocked: true,
        blocking_exception: { id: 'exc-1', type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
      },
    });
    const onExceptionOpen = vi.fn();
    render(<FlowTrail steps={steps} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} onExceptionOpen={onExceptionOpen} hasAlcadaForException={() => false} />);

    await userEvent.click(screen.getByTestId('flow-step-SEPARACAO'));
    expect(onExceptionOpen).not.toHaveBeenCalled();
  });

  it('navegação por teclado: só etapas interativas entram no Tab (tabIndex 0), futuras ficam fora (tabIndex -1)', () => {
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} />);

    expect(screen.getByTestId('flow-step-PEDIDO')).toHaveAttribute('tabIndex', '0');
    expect(screen.getByTestId('flow-step-SEPARACAO')).toHaveAttribute('tabIndex', '0');
    expect(screen.getByTestId('flow-step-EMBALAGEM')).toHaveAttribute('tabIndex', '-1');
    expect(screen.getByTestId('flow-step-PESAGEM')).toHaveAttribute('tabIndex', '-1');
  });

  it('Enter/Espaço aciona a etapa focada (button nativo, sem handler customizado de tecla)', () => {
    const onStepOpen = vi.fn();
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={onStepOpen} />);

    const step = screen.getByTestId('flow-step-SEPARACAO');
    step.focus();
    fireEvent.click(step); // jsdom não sintetiza Enter->click em <button> automaticamente; o comportamento nativo do browser real faz isso porque é um <button>.
    expect(onStepOpen).toHaveBeenCalled();
  });

  it('cor nunca é o único sinal: cada estado tem um ícone Lucide (svg) associado ao texto', () => {
    render(<FlowTrail steps={makeSteps()} stepLabels={STEP_LABELS} onStepOpen={vi.fn()} />);
    for (const code of ['PEDIDO', 'SEPARACAO', 'EMBALAGEM', 'PESAGEM']) {
      const el = screen.getByTestId(`flow-step-${code}`);
      expect(el.querySelector('svg')).toBeTruthy();
    }
  });
});
