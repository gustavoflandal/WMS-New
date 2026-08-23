// DOC-10 RF-PAI-001 — teste de componente do cartão: exibição de atraso e
// de exceção bloqueante (rótulo textual, não só cor/borda).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OperationCard, type OperationCardData } from '../OperationCard';

const BASE: OperationCardData = {
  flowId: 'flow-1',
  cardType: 'PEDIDO',
  documentNumber: 'PED-SP01-000123',
  clientName: 'Cliente Exemplo',
  currentStepCode: 'SEPARACAO',
  timeInStepMinutes: 45,
  hasPendingException: false,
  isLate: false,
};

describe('OperationCard', () => {
  it('exibe número do documento, cliente e etapa atual com tempo', () => {
    render(<OperationCard card={BASE} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.getByText('PED-SP01-000123')).toBeInTheDocument();
    expect(screen.getByText('Cliente Exemplo')).toBeInTheDocument();
    expect(screen.getByText('Separação')).toBeInTheDocument();
    expect(screen.getByText('· 45 min')).toBeInTheDocument();
  });

  it('sem atraso nem exceção: nenhum badge exibido', () => {
    render(<OperationCard card={BASE} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.queryByText('Atrasado')).not.toBeInTheDocument();
    expect(screen.queryByText('Exceção pendente')).not.toBeInTheDocument();
  });

  it('atraso: badge "Atrasado" com texto, não só cor', () => {
    render(<OperationCard card={{ ...BASE, isLate: true }} stepLabel="Separação" onOpen={vi.fn()} />);
    const badge = screen.getByText('Atrasado');
    expect(badge).toBeInTheDocument();
    // O texto fica num <span> interno do StatusBadge; o ícone é irmão dele,
    // então o svg está no PAI do texto, não no próprio nó do texto.
    expect(badge.parentElement?.querySelector('svg')).toBeTruthy();
  });

  it('exceção pendente: badge "Exceção pendente" com texto', () => {
    render(<OperationCard card={{ ...BASE, hasPendingException: true }} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.getByText('Exceção pendente')).toBeInTheDocument();
  });

  it('atraso E exceção ao mesmo tempo: os dois badges aparecem', () => {
    render(<OperationCard card={{ ...BASE, isLate: true, hasPendingException: true }} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.getByText('Atrasado')).toBeInTheDocument();
    expect(screen.getByText('Exceção pendente')).toBeInTheDocument();
  });

  it('clique chama onOpen com o cartão', async () => {
    const onOpen = vi.fn();
    render(<OperationCard card={BASE} stepLabel="Separação" onOpen={onOpen} />);
    await userEvent.click(screen.getByTestId('operation-card-flow-1'));
    expect(onOpen).toHaveBeenCalledWith(BASE);
  });

  it('tempo em horas formatado quando >= 60 minutos', () => {
    render(<OperationCard card={{ ...BASE, timeInStepMinutes: 125 }} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.getByText('· 2h05')).toBeInTheDocument();
  });

  it('sem documentNumber: mostra travessão, não vazio silencioso', () => {
    render(<OperationCard card={{ ...BASE, documentNumber: null }} stepLabel="Separação" onOpen={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
