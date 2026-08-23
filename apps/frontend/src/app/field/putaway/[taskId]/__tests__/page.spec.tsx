// @vitest-environment jsdom
// DOC-15 §4.5 T2 — Putaway. Teste leve de fluxo (prompt §5): avança passo
// (LPN → endereço) e confirma que `updateTaskProgress` é chamado com o
// valor certo a cada leitura (RF-COL-021), e que a retomada a partir de
// `task.progress` já salvo pula direto para o passo certo.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import PutawayTaskPage from '../page';
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

function buildTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    taskType: 'PUTAWAY',
    taskId: 'task-1',
    tenantId: 'tenant-1',
    status: 'ASSIGNED',
    lpn: '129000000000012346',
    productSku: 'SKU-1',
    productDescription: 'Produto de teste',
    locationCode: 'A1-010-02-01',
    locationCodeOrigin: null,
    checkingId: null,
    qty: 10,
    createdAt: new Date().toISOString(),
    localStatus: 'PENDING',
    progress: null,
    queuedOperationId: null,
    ...overrides,
  };
}

describe('DOC-15 T2 Putaway — RF-COL-021 (persistência de passo) e RG-007 (dupla leitura)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('ler o LPN correto avança para o passo de endereço e persiste o progresso', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    render(<PutawayTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => expect(screen.getByText(/Passo 1 — Ler o LPN/)).toBeInTheDocument());

    const input = screen.getByRole('textbox');
    await user.type(input, '129000000000012346');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => expect(screen.getByText(/Passo 2 — Ler o endereço/)).toBeInTheDocument());
    expect(updateTaskProgressMock).toHaveBeenCalledWith('task-1', { step: 'location', lpn: '129000000000012346' });
  });

  it('LPN divergente da tarefa é rejeitado com mensagem clara e não avança o passo (RG-007)', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(buildTask());
    render(<PutawayTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByRole('textbox'));
    // LPN válido (dígito verificador GS1 correto) mas diferente do da tarefa.
    await user.type(screen.getByRole('textbox'), '200000000000000004');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => expect(screen.getByText('LPN lido não corresponde à tarefa.')).toBeInTheDocument());
    expect(screen.getByText(/Passo 1 — Ler o LPN/)).toBeInTheDocument();
    expect(updateTaskProgressMock).not.toHaveBeenCalled();
  });

  it('retoma exatamente no passo salvo em task.progress (RF-COL-021)', async () => {
    getTaskMock.mockResolvedValue(
      buildTask({
        localStatus: 'IN_PROGRESS',
        progress: { step: 'location', lpn: '129000000000012346' },
      })
    );
    render(<PutawayTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => expect(screen.getByText(/Passo 2 — Ler o endereço/)).toBeInTheDocument());
    expect(screen.queryByText(/Passo 1 — Ler o LPN/)).not.toBeInTheDocument();
  });

  it('endereço divergente do sugerido exige motivo antes de habilitar a confirmação', async () => {
    const user = userEvent.setup();
    getTaskMock.mockResolvedValue(
      buildTask({
        localStatus: 'IN_PROGRESS',
        progress: { step: 'location', lpn: '129000000000012346' },
      })
    );
    render(<PutawayTaskPage params={{ taskId: 'task-1' }} />);

    await waitFor(() => screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'B2-020-01-01');
    await user.click(screen.getByRole('button', { name: 'Ler' }));

    await waitFor(() => expect(screen.getByText(/Passo 3 — Confirmar/)).toBeInTheDocument());
    const confirmButton = screen.getByRole('button', { name: 'Confirmar putaway' });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText(/informe o motivo/i), 'Endereço original bloqueado');
    expect(confirmButton).not.toBeDisabled();
  });
});
