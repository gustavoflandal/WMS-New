// DOC-17 §5/§10 — teste de componente do painel de detalhe de etapa: os 4
// modos de RN-TEL-002 renderizam com ícone+rótulo textual (RG-013), conteúdo
// tabular/chave-valor genérico, e "ações disponíveis" aparece só como rótulo
// informativo (nunca um botão que finge executar algo que não existe).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepDetailPanel, type StepDetailData } from '../StepDetailPanel';

function makeDetail(overrides: Partial<StepDetailData> = {}): StepDetailData {
  return {
    entity: 'outbound_order',
    entity_id: 'order-1',
    document_number: 'PED-SP01-00000001',
    flow_type: 'OUTBOUND_ORDER',
    flow_status: 'IN_PROGRESS',
    step_code: 'PESAGEM',
    mode: 'PREVISAO',
    status: 'PENDING',
    started_at: null,
    completed_at: null,
    completed_by: null,
    blocking_exception: null,
    content: {},
    actions: [],
    ...overrides,
  };
}

describe('StepDetailPanel', () => {
  it('modo Previsão: mostra aviso, conteúdo planejado e NENHUMA ação', () => {
    render(
      <StepDetailPanel
        stepLabel="Pesagem"
        detail={makeDetail({
          mode: 'PREVISAO',
          content: { packages: [{ lpn: '123456789012345678', theoretical_weight_kg: 5.2, actual_weight_kg: null }] },
        })}
      />
    );

    expect(screen.getByText('Previsão')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('conclua a etapa anterior');
    expect(screen.getByText('5.2')).toBeInTheDocument();
    expect(screen.queryByText('Ação disponível')).not.toBeInTheDocument();
  });

  it('modo Consulta: mostra quem e quando concluiu, e a ação de estorno quando disponível', () => {
    render(
      <StepDetailPanel
        stepLabel="Picking"
        detail={makeDetail({
          mode: 'CONSULTA',
          step_code: 'PICKING',
          status: 'DONE',
          completed_at: '2026-08-25T14:30:00Z',
          completed_by: { id: 'u1', name: 'Maria Souza' },
          content: { tasks: [{ product_id: 'p1', qty_confirmed: 8, batch_id: 'b1' }] },
          actions: [{ action: 'ESTORNAR', permission: 'EXP.ESTORNO' }],
        })}
      />
    );

    expect(screen.getByText('Consulta')).toBeInTheDocument();
    expect(screen.getByText(/Maria Souza/)).toBeInTheDocument();
    expect(screen.getByText('Ação disponível')).toBeInTheDocument();
    expect(screen.getByText('Estornar')).toBeInTheDocument();
  });

  it('modo Bloqueada: mostra a exceção bloqueante com role="alert"', () => {
    render(
      <StepDetailPanel
        stepLabel="Embalagem"
        detail={makeDetail({
          mode: 'BLOQUEADA',
          step_code: 'EMBALAGEM',
          blocking_exception: { id: 'exc-1', type: 'EXP.DIVERGENCIA_PESO', status: 'PENDING' },
        })}
      />
    );

    expect(screen.getByText('Bloqueada por exceção')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('EXP.DIVERGENCIA_PESO');
  });

  it('renderiza conteúdo tabular genérico (array de objetos) com colunas humanizadas', () => {
    render(
      <StepDetailPanel
        stepLabel="Picking"
        detail={makeDetail({
          mode: 'CONSULTA',
          status: 'DONE',
          content: { tasks: [{ product_id: 'p1', qty_confirmed: 8 }] },
        })}
      />
    );

    expect(screen.getByRole('columnheader', { name: 'Produto' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Qtd. confirmada' })).toBeInTheDocument();
  });

  it('sem dado nenhum: mensagem explícita, não tela vazia muda', () => {
    render(<StepDetailPanel stepLabel="Chegada" detail={makeDetail({ content: {} })} />);
    expect(screen.getByText(/Nenhum dado registrado/)).toBeInTheDocument();
  });

  it('cada modo tem ícone (svg) associado ao rótulo textual — nunca só cor (RG-013)', () => {
    render(<StepDetailPanel stepLabel="Pesagem" detail={makeDetail({ mode: 'PREVISAO' })} />);
    const badge = screen.getByText('Previsão').parentElement;
    expect(badge?.querySelector('svg')).toBeTruthy();
  });
});
