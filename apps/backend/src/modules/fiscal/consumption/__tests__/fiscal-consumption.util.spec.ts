// DOC-08 §4.4 RN-FIS-030 — testes PUROS (sem Postgres) da ordenação/alocação
// de consumo fiscal. Mesmo espírito de stock-selection.util.spec.ts (DOC-05).
import { describe, expect, it } from 'vitest';
import {
  FiscalConsumptionCandidate,
  allocateFiscalDemand,
  orderFiscalCandidatesByPolicy,
} from '../fiscal-consumption.util.js';

function candidate(partial: Partial<FiscalConsumptionCandidate> & { internalNumber: string; issuedAt: string; qtyAvailable: number }): FiscalConsumptionCandidate {
  return {
    fiscalStockBalanceId: partial.internalNumber,
    storageFiscalDocumentId: partial.internalNumber,
    internalNumber: partial.internalNumber,
    issuedAt: partial.issuedAt,
    qtyAvailable: partial.qtyAvailable,
  };
}

describe('DOC-08 RN-FIS-030 — fiscal-consumption.util', () => {
  // Exemplo normativo (regressão permanente, DOC-08 §4.4/§6):
  const nota1 = candidate({ internalNumber: '1000234', issuedAt: '2026-05-01T00:00:00.000Z', qtyAvailable: 500 });
  const nota2 = candidate({ internalNumber: '2356899', issuedAt: '2026-06-10T00:00:00.000Z', qtyAvailable: 100 });
  const nota3 = candidate({ internalNumber: '3216544', issuedAt: '2026-07-02T00:00:00.000Z', qtyAvailable: 400 });

  it('FIFO_EMISSAO ordena por data de emissão crescente', () => {
    const ordered = orderFiscalCandidatesByPolicy([nota3, nota1, nota2], 'FIFO_EMISSAO');
    expect(ordered.map((c) => c.internalNumber)).toEqual(['1000234', '2356899', '3216544']);
  });

  it('LIFO_EMISSAO ordena por data de emissão decrescente', () => {
    const ordered = orderFiscalCandidatesByPolicy([nota1, nota2, nota3], 'LIFO_EMISSAO');
    expect(ordered.map((c) => c.internalNumber)).toEqual(['3216544', '2356899', '1000234']);
  });

  it('desempate por menor número da nota quando a data de emissão empata', () => {
    const a = candidate({ internalNumber: '2000000', issuedAt: '2026-05-01T00:00:00.000Z', qtyAvailable: 10 });
    const b = candidate({ internalNumber: '1000000', issuedAt: '2026-05-01T00:00:00.000Z', qtyAvailable: 10 });
    const ordered = orderFiscalCandidatesByPolicy([a, b], 'FIFO_EMISSAO');
    expect(ordered.map((c) => c.internalNumber)).toEqual(['1000000', '2000000']);
  });

  it('exemplo normativo RG-014/RN-FIS-030: demanda 700 em FIFO_EMISSAO -> 500+100+100, saldos finais 0/0/300', () => {
    const ordered = orderFiscalCandidatesByPolicy([nota1, nota2, nota3], 'FIFO_EMISSAO');
    const result = allocateFiscalDemand(ordered, 700);

    expect(result.shortfall).toBe(0);
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations[0]).toMatchObject({ candidate: { internalNumber: '1000234' }, qtyAllocated: 500 });
    expect(result.allocations[1]).toMatchObject({ candidate: { internalNumber: '2356899' }, qtyAllocated: 100 });
    expect(result.allocations[2]).toMatchObject({ candidate: { internalNumber: '3216544' }, qtyAllocated: 100 });

    const remaining = new Map(result.allocations.map((a) => [a.candidate.internalNumber, a.candidate.qtyAvailable - a.qtyAllocated]));
    expect(remaining.get('1000234')).toBe(0);
    expect(remaining.get('2356899')).toBe(0);
    expect(remaining.get('3216544')).toBe(300);
  });

  it('demanda acima do total disponível (1001 sobre 1000) resulta em shortfall e totalAvailable=1000', () => {
    const ordered = orderFiscalCandidatesByPolicy([nota1, nota2, nota3], 'FIFO_EMISSAO');
    const result = allocateFiscalDemand(ordered, 1001);

    expect(result.totalAvailable).toBe(1000);
    expect(result.shortfall).toBe(1);
  });

  it('não muta a entrada (orderFiscalCandidatesByPolicy)', () => {
    const input = [nota3, nota1, nota2];
    const copy = [...input];
    orderFiscalCandidatesByPolicy(input, 'FIFO_EMISSAO');
    expect(input).toEqual(copy);
  });
});
