// @vitest-environment jsdom
// DOC-17 §2/§5 — DOC-10 RF-PAI-005: clique em QUALQUER etapa busca e exibe
// o detalhe real (Sessão 10A) — nunca mais o aviso "inerte" nem o
// placeholder de `lastAction`.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import TrilhaPage from '../page';

const getMock = vi.fn();

vi.mock('../../../../../../lib/api-client', () => ({
  apiClient: { get: (...args: unknown[]) => getMock(...args) },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

vi.mock('../../../../../../lib/auth-context', () => ({
  useAuth: () => ({ warehouseId: 'wh-1' }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ entity: 'outbound_order', entityId: 'order-1' }),
  useSearchParams: () => new URLSearchParams('tenant_id=client-1'),
}));

const FLOW_STATE = {
  flow: { id: 'flow-1', entity: 'outbound_order', entity_id: 'order-1', flow_type: 'OUTBOUND_ORDER', status: 'IN_PROGRESS', warehouse_id: 'wh-1', tenant_id: 'client-1', created_at: '2026-08-25T10:00:00Z' },
  steps: [
    {
      step_code: 'PEDIDO',
      sequence_order: 100,
      status: 'DONE',
      started_at: '2026-08-25T10:00:00Z',
      completed_at: '2026-08-25T10:05:00Z',
      is_actionable: false,
      opens_read_only: true,
      is_blocked: false,
      blocking_exception: null,
      completed_by: { id: 'u1', name: 'João Silva' },
    },
    {
      step_code: 'PICKING',
      sequence_order: 200,
      status: 'PENDING',
      started_at: '2026-08-25T10:05:00Z',
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
  ],
};

const STEP_DETAIL_PREVISAO = {
  entity: 'outbound_order',
  entity_id: 'order-1',
  document_number: 'PED-SP01-00000001',
  flow_type: 'OUTBOUND_ORDER',
  flow_status: 'IN_PROGRESS',
  step_code: 'EMBALAGEM',
  mode: 'PREVISAO',
  status: 'PENDING',
  started_at: null,
  completed_at: null,
  completed_by: null,
  blocking_exception: null,
  content: { packages: [{ lpn: '123456789012345678', theoretical_weight_kg: 5.2, actual_weight_kg: null }] },
  actions: [],
};

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('TrilhaPage', () => {
  it('carrega o estado da trilha e, ao clicar numa etapa FUTURA, busca e exibe o detalhe em modo Previsão (DOC-17 §2 — nunca mais "inerte")', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.includes('/steps/')) return Promise.resolve(STEP_DETAIL_PREVISAO);
      return Promise.resolve(FLOW_STATE);
    });

    render(<TrilhaPage />);

    await waitFor(() => expect(screen.getByText('order-1')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('flow-step-EMBALAGEM'));

    await waitFor(() => expect(screen.getByText('Previsão')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('conclua a etapa anterior');
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('/fluxo-operacional/outbound_order/order-1/steps/EMBALAGEM/detail'));
  });

  it('erro ao buscar o detalhe da etapa é mostrado em alerta, não engolido silenciosamente', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.includes('/steps/')) return Promise.reject(new Error('falha de rede'));
      return Promise.resolve(FLOW_STATE);
    });

    render(<TrilhaPage />);
    await waitFor(() => expect(screen.getByText('order-1')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('flow-step-PICKING'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar o detalhe da etapa.'));
  });
});
