// @vitest-environment jsdom
// DOC-15 §4.5 T5 — Contagem. RN-COL-061 [INVIOLÁVEL]: em NENHUM estado
// renderizado pode aparecer saldo do sistema, rodada anterior, ou qualquer
// indicação de divergência. Este é o teste mais crítico da sessão COL-2B
// (prompt §5 explícito). Percorre os estados: inicial (leitura de endereço),
// lista vazia (RN-COL-063: "Encerrar" desabilitado), com 1 item, tentativa de
// encerrar vazio, declaração explícita de endereço vazio, e encerramento com
// itens — confirmando em cada um que nenhum número que não veio da digitação
// do próprio operador nesta sessão aparece.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import ContagemTaskPage from '../page';
import type { LocalTask } from '../../../../../lib/field/field-db';

const getTaskMock = vi.fn();
const updateTaskProgressMock = vi.fn();
const confirmTaskMock = vi.fn();

vi.mock('../../../../../lib/field/shift-package-store', () => ({
  getTask: (...args: unknown[]) => getTaskMock(...args),
  updateTaskProgress: (...args: unknown[]) => updateTaskProgressMock(...args),
}));

vi.mock('../../../../../lib/field/confirm-task', () => ({
  confirmTask: (...args: unknown[]) => confirmTaskMock(...args),
}));

vi.mock('../../../../../lib/field/field-status-context', () => ({
  useFieldStatus: () => ({
    online: true,
    queueSize: 0,
    versionBlocked: false,
    setVersionBlocked: vi.fn(),
    queueGate: { blocked: false, reason: null },
    executionBlocked: false,
    blockedMessage: null,
    syncing: false,
    refreshQueueSize: vi.fn(),
    triggerSync: vi.fn(),
  }),
}));

vi.mock('../../../../../lib/auth-context', () => ({
  useAuth: () => ({
    warehouseId: 'wh-1',
    context: { userId: 'user-1', area: 'INTERNAL', warehouses: [], clients: [] },
  }),
}));

vi.mock('../../../layout', () => ({ APP_VERSION: '1.0.0' }));

// RN-COL-061: nenhum destes termos pode aparecer em nenhum estado renderizado.
const SALDO_LEAK_REGEX = /saldo|sistema|esperad[oa]|diverg[êe]ncia|rodada anterior|100\s*UN/i;

function expectNoBalanceLeak(): void {
  expect(screen.queryByText(SALDO_LEAK_REGEX)).not.toBeInTheDocument();
}

function buildTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    taskType: 'CONTAGEM_INVENTARIO',
    taskId: 'task-1',
    tenantId: 'tenant-1',
    status: 'COUNT_PENDING',
    lpn: null,
    productSku: null,
    productDescription: null,
    locationCode: 'A1-010-02-01',
    locationCodeOrigin: null,
    checkingId: null,
    // RN-COL-061: qty SEMPRE null do backend para este taskType — o teste
    // nunca deve precisar ler este campo para passar.
    qty: null,
    createdAt: new Date().toISOString(),
    localStatus: 'PENDING',
    progress: null,
    queuedOperationId: null,
    ...overrides,
  };
}

describe('DOC-15 T5 Contagem — RN-COL-061/063/064', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('estado inicial (passo 1, leitura do endereço): nenhum saldo exibido', async () => {
    getTaskMock.mockResolvedValue(buildTask());
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => expect(screen.getByText(/Passo 1/)).toBeInTheDocument());
    expectNoBalanceLeak();
  });

  it('após ler o endereço, lista vazia: nenhum saldo exibido e "Encerrar endereço" fica desabilitado (RN-COL-063)', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByLabelText('Código do endereço'));
    await user.type(screen.getByLabelText('Código do endereço'), 'A1-010-02-01');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => expect(screen.getByText('Nenhum item contado ainda nesta rodada.')).toBeInTheDocument());
    expectNoBalanceLeak();

    const encerrarButton = screen.getByRole('button', { name: /Encerrar endereço/ });
    expect(encerrarButton).toBeDisabled();
    expect(updateTaskProgressMock).toHaveBeenCalledWith('task-1', { scannedLocationCode: 'A1-010-02-01', items: [] });
  });

  it('adiciona um item: lista mostra só o que o operador digitou, sem saldo/rodada anterior', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByLabelText('Código do endereço'));
    await user.type(screen.getByLabelText('Código do endereço'), 'A1-010-02-01');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => screen.getByLabelText('Código do produto'));
    await user.type(screen.getByLabelText('Código do produto'), '7891000100103');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => screen.getByLabelText('Quantidade contada nesta leitura (UN)'));
    await user.type(screen.getByLabelText('Quantidade contada nesta leitura (UN)'), '5');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    await waitFor(() => expect(screen.getByText('7891000100103')).toBeInTheDocument());
    expect(screen.getByText('5 UN')).toBeInTheDocument();
    expectNoBalanceLeak();

    const encerrarButton = screen.getByRole('button', { name: /Encerrar endereço \(total 5 UN\)/ });
    expect(encerrarButton).not.toBeDisabled();
  });

  it('RN-COL-063: só a ação explícita "Declarar endereço vazio" com confirmação extra encerra com contagem zero', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    confirmTaskMock.mockResolvedValue('op-1');
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByLabelText('Código do endereço'));
    await user.type(screen.getByLabelText('Código do endereço'), 'A1-010-02-01');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => screen.getByRole('button', { name: 'Declarar endereço vazio' }));
    // Encerrar normal continua desabilitado com lista vazia.
    expect(screen.getByRole('button', { name: /Encerrar endereço/ })).toBeDisabled();

    // Primeiro clique só abre a confirmação extra — ainda não conclui.
    await user.click(screen.getByRole('button', { name: 'Declarar endereço vazio' }));
    expect(confirmTaskMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Confirma que não há nenhum item neste endereço?')).toBeInTheDocument());
    expectNoBalanceLeak();

    await user.click(screen.getByRole('button', { name: 'Confirmar endereço vazio' }));

    await waitFor(() =>
      expect(confirmTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', taskType: 'CONTAGEM_INVENTARIO', payload: { countedQty: 0 } })
      )
    );
    await waitFor(() => expect(screen.getByText(/registrada com sucesso/)).toBeInTheDocument());
    expectNoBalanceLeak();
  });

  it('encerra com itens: envia o TOTAL agregado do próprio operador e não expõe saldo na tela final', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    confirmTaskMock.mockResolvedValue('op-2');
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByLabelText('Código do endereço'));
    await user.type(screen.getByLabelText('Código do endereço'), 'A1-010-02-01');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => screen.getByLabelText('Código do produto'));
    await user.type(screen.getByLabelText('Código do produto'), '7891000100103');
    await user.click(screen.getByRole('button', { name: 'Ler' }));
    await waitFor(() => screen.getByLabelText('Quantidade contada nesta leitura (UN)'));
    await user.type(screen.getByLabelText('Quantidade contada nesta leitura (UN)'), '5');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    await waitFor(() => screen.getByLabelText('Código do produto'));
    await user.type(screen.getByLabelText('Código do produto'), '00012345');
    await user.click(screen.getByRole('button', { name: 'Ler' }));
    await waitFor(() => screen.getByLabelText('Quantidade contada nesta leitura (UN)'));
    await user.type(screen.getByLabelText('Quantidade contada nesta leitura (UN)'), '3');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Encerrar endereço \(total 8 UN\)/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Encerrar endereço \(total 8 UN\)/ }));

    await waitFor(() =>
      expect(confirmTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', taskType: 'CONTAGEM_INVENTARIO', payload: { countedQty: 8 } })
      )
    );
    await waitFor(() => expect(screen.getByText(/registrada com sucesso/)).toBeInTheDocument());
    expectNoBalanceLeak();
  });

  it('RN-COL-064: recontagem exibe aviso preventivo desde o passo 1, sem vazar saldo', async () => {
    getTaskMock.mockResolvedValue(buildTask({ status: 'RECOUNT_PENDING' }));
    render(<ContagemTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => expect(screen.getByText(/recontagem/i)).toBeInTheDocument());
    expect(screen.getByText(/exigir operador diferente/i)).toBeInTheDocument();
    expectNoBalanceLeak();
  });

  it('tarefa não encontrada/já concluída: nunca uma tela em branco', async () => {
    getTaskMock.mockResolvedValue(undefined);
    render(<ContagemTaskPage params={{ taskId: 'inexistente' }} />);

    await waitFor(() => expect(screen.getByText(/não encontrada ou já concluída/i)).toBeInTheDocument());
    expectNoBalanceLeak();
  });
});
