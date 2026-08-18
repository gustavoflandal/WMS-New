// DOC-05 §4.2 — regra PURA da Seleção de Saldo: RN-EST-011 (cadeias de
// desempate das 4 políticas), RN-EST-012 (shelf life mínimo) e o atendimento
// parcial. Inclui os DOIS exemplos normativos do documento como teste de
// regressão permanente — os valores esperados são imutáveis.
import { describe, expect, it } from 'vitest';
import {
  SelectionCandidate,
  allocateDemand,
  meetsMinimumShelfLife,
  orderCandidatesByPolicy,
  parsePercentToCentiPercent,
  restrictToAccessiblePallets,
  wholeDaysBetween,
} from '../stock-selection.util.js';

function candidate(overrides: Partial<SelectionCandidate> & { stockBalanceId: string }): SelectionCandidate {
  return {
    productId: 'p1',
    batchId: null,
    locationId: `loc-${overrides.stockBalanceId}`,
    palletId: null,
    qtyAvailable: 100,
    expirationDate: null,
    entryDate: '2026-01-01T00:00:00.000Z',
    locationType: 'STORAGE',
    locationCode: 'A1-001-00-01',
    zoneType: 'STORAGE',
    accessPolicy: 'RANDOM',
    channelKey: 'chan-default',
    ...overrides,
  };
}

describe('RN-EST-012 [INVIOLÁVEL] — Shelf Life Mínimo', () => {
  it('EXEMPLO NORMATIVO §4.2: 365 dias, mínimo 30%, hoje 2026-08-10 — lote 2026-11-10 excluído, lote 2027-01-10 elegível', () => {
    const base = { shelfLifeDays: 365, minShelfLifePct: '30.00', today: '2026-08-10' };

    // 92 dias restantes = 25,2% → inferior a 30% → EXCLUÍDO.
    expect(wholeDaysBetween('2026-08-10', '2026-11-10')).toBe(92);
    expect(meetsMinimumShelfLife({ ...base, expirationDate: '2026-11-10' })).toBe(false);

    // 153 dias restantes = 41,9% → elegível.
    expect(wholeDaysBetween('2026-08-10', '2027-01-10')).toBe(153);
    expect(meetsMinimumShelfLife({ ...base, expirationDate: '2027-01-10' })).toBe(true);
  });

  it('corte exato no limiar não depende de ponto flutuante', () => {
    // 30% de 365 = 109,5 dias. 109 dias reprova, 110 aprova — e o limiar
    // fracionário NÃO pode ser arredondado a favor de nenhum dos lados.
    const base = { shelfLifeDays: 365, minShelfLifePct: '30.00', today: '2026-01-01' };
    expect(meetsMinimumShelfLife({ ...base, expirationDate: '2026-04-19' })).toBe(false); // 108 dias
    expect(meetsMinimumShelfLife({ ...base, expirationDate: '2026-04-20' })).toBe(false); // 109 dias < 109,5
    expect(meetsMinimumShelfLife({ ...base, expirationDate: '2026-04-21' })).toBe(true); // 110 dias > 109,5
  });

  it('percentual com casas decimais é exato (NUMERIC(5,2) chega como string)', () => {
    expect(parsePercentToCentiPercent('30')).toBe(3000);
    expect(parsePercentToCentiPercent('30.00')).toBe(3000);
    expect(parsePercentToCentiPercent('30.5')).toBe(3050);
    expect(parsePercentToCentiPercent('25.25')).toBe(2525);
    expect(parsePercentToCentiPercent('0.01')).toBe(1);
  });

  it('lote já vencido nunca atende a um mínimo positivo', () => {
    expect(meetsMinimumShelfLife({ expirationDate: '2026-08-09', shelfLifeDays: 365, minShelfLifePct: '30.00', today: '2026-08-10' })).toBe(false);
  });

  it('sem os três insumos (validade, shelf_life_days, mínimo) a regra não exclui', () => {
    expect(meetsMinimumShelfLife({ expirationDate: null, shelfLifeDays: 365, minShelfLifePct: '30.00', today: '2026-08-10' })).toBe(true);
    expect(meetsMinimumShelfLife({ expirationDate: '2026-11-10', shelfLifeDays: null, minShelfLifePct: '30.00', today: '2026-08-10' })).toBe(true);
    expect(meetsMinimumShelfLife({ expirationDate: '2026-11-10', shelfLifeDays: 365, minShelfLifePct: null, today: '2026-08-10' })).toBe(true);
  });
});

describe('RN-EST-011 [INVIOLÁVEL] — cadeias de desempate por política', () => {
  it('EXEMPLO NORMATIVO §4.2 (FEFO): demanda 150 sobre S1/S2/S3 → 80 de S1 + 70 de S2, S3 intocado', () => {
    const s1 = candidate({ stockBalanceId: 'S1', expirationDate: '2026-09-01', locationType: 'PICKING', qtyAvailable: 80, locationCode: 'P1-001-00-01' });
    const s2 = candidate({ stockBalanceId: 'S2', expirationDate: '2026-09-01', locationType: 'STORAGE', qtyAvailable: 100, locationCode: 'A1-001-00-01' });
    const s3 = candidate({ stockBalanceId: 'S3', expirationDate: '2026-10-15', locationType: 'PICKING', qtyAvailable: 200, locationCode: 'P1-002-00-01' });

    const ordered = orderCandidatesByPolicy([s3, s2, s1], 'FEFO');
    expect(ordered.map((c) => c.stockBalanceId)).toEqual(['S1', 'S2', 'S3']);

    const result = allocateDemand(ordered, 150);
    expect(result.allocations.map((a) => [a.candidate.stockBalanceId, a.qtyAllocated])).toEqual([
      ['S1', 80],
      ['S2', 70],
    ]);
    expect(result.shortfall).toBe(0);
    // S3 intocado — não aparece em nenhuma alocação.
    expect(result.allocations.some((a) => a.candidate.stockBalanceId === 'S3')).toBe(false);
  });

  it('FEFO: validade decide antes de tudo; empate cai para entrada, depois PICKING, depois código', () => {
    const early = candidate({ stockBalanceId: 'early', expirationDate: '2026-01-01', entryDate: '2026-05-01T00:00:00.000Z' });
    const lateEntry = candidate({ stockBalanceId: 'lateEntry', expirationDate: '2026-06-01', entryDate: '2026-01-01T00:00:00.000Z' });
    expect(orderCandidatesByPolicy([lateEntry, early], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['early', 'lateEntry']);

    // Mesma validade → decide a data de entrada.
    const a = candidate({ stockBalanceId: 'a', expirationDate: '2026-06-01', entryDate: '2026-02-01T00:00:00.000Z' });
    const b = candidate({ stockBalanceId: 'b', expirationDate: '2026-06-01', entryDate: '2026-01-01T00:00:00.000Z' });
    expect(orderCandidatesByPolicy([a, b], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['b', 'a']);

    // Mesma validade e mesma entrada → PICKING antes de STORAGE.
    const storage = candidate({ stockBalanceId: 'storage', expirationDate: '2026-06-01', locationType: 'STORAGE', locationCode: 'A0-001-00-01' });
    const picking = candidate({ stockBalanceId: 'picking', expirationDate: '2026-06-01', locationType: 'PICKING', locationCode: 'Z9-001-00-01' });
    expect(orderCandidatesByPolicy([storage, picking], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['picking', 'storage']);

    // Tudo igual → menor location.code.
    const codeB = candidate({ stockBalanceId: 'codeB', expirationDate: '2026-06-01', locationCode: 'B1-001-00-01' });
    const codeA = candidate({ stockBalanceId: 'codeA', expirationDate: '2026-06-01', locationCode: 'A1-001-00-01' });
    expect(orderCandidatesByPolicy([codeB, codeA], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['codeA', 'codeB']);
  });

  it('FIFO: entrada decide antes da validade (inverso do FEFO)', () => {
    const oldEntryLongExpiry = candidate({ stockBalanceId: 'oldEntry', entryDate: '2026-01-01T00:00:00.000Z', expirationDate: '2027-01-01' });
    const newEntryShortExpiry = candidate({ stockBalanceId: 'newEntry', entryDate: '2026-06-01T00:00:00.000Z', expirationDate: '2026-07-01' });

    expect(orderCandidatesByPolicy([newEntryShortExpiry, oldEntryLongExpiry], 'FIFO').map((c) => c.stockBalanceId)).toEqual(['oldEntry', 'newEntry']);
    // Contraprova: em FEFO a ordem se inverte.
    expect(orderCandidatesByPolicy([oldEntryLongExpiry, newEntryShortExpiry], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['newEntry', 'oldEntry']);
  });

  it('LIFO: maior data de entrada primeiro, depois PICKING, depois código', () => {
    const old = candidate({ stockBalanceId: 'old', entryDate: '2026-01-01T00:00:00.000Z' });
    const recent = candidate({ stockBalanceId: 'recent', entryDate: '2026-06-01T00:00:00.000Z' });
    expect(orderCandidatesByPolicy([old, recent], 'LIFO').map((c) => c.stockBalanceId)).toEqual(['recent', 'old']);

    const storage = candidate({ stockBalanceId: 'storage', entryDate: '2026-06-01T00:00:00.000Z', locationType: 'STORAGE', locationCode: 'A0-001-00-01' });
    const picking = candidate({ stockBalanceId: 'picking', entryDate: '2026-06-01T00:00:00.000Z', locationType: 'PICKING', locationCode: 'Z9-001-00-01' });
    expect(orderCandidatesByPolicy([storage, picking], 'LIFO').map((c) => c.stockBalanceId)).toEqual(['picking', 'storage']);
  });

  it('JIT: zona CROSS_DOCKING primeiro, o resto idêntico a FIFO', () => {
    const crossDock = candidate({ stockBalanceId: 'cross', zoneType: 'CROSS_DOCKING', entryDate: '2026-06-01T00:00:00.000Z' });
    const storageOld = candidate({ stockBalanceId: 'storageOld', zoneType: 'STORAGE', entryDate: '2026-01-01T00:00:00.000Z' });

    // Mesmo com entrada MAIS ANTIGA no storage, o cross-docking vem primeiro.
    expect(orderCandidatesByPolicy([storageOld, crossDock], 'JIT').map((c) => c.stockBalanceId)).toEqual(['cross', 'storageOld']);
    // Contraprova: em FIFO puro o mais antigo vence.
    expect(orderCandidatesByPolicy([crossDock, storageOld], 'FIFO').map((c) => c.stockBalanceId)).toEqual(['storageOld', 'cross']);

    // Fora do cross-docking, a cadeia é a do FIFO (entrada asc).
    const a = candidate({ stockBalanceId: 'a', zoneType: 'STORAGE', entryDate: '2026-03-01T00:00:00.000Z' });
    const b = candidate({ stockBalanceId: 'b', zoneType: 'STORAGE', entryDate: '2026-02-01T00:00:00.000Z' });
    expect(orderCandidatesByPolicy([a, b], 'JIT').map((c) => c.stockBalanceId)).toEqual(['b', 'a']);
  });

  it('saldo sem validade vai por último na ordenação por validade (NULLS LAST documentado)', () => {
    const withExpiry = candidate({ stockBalanceId: 'withExpiry', expirationDate: '2027-12-31' });
    const noExpiry = candidate({ stockBalanceId: 'noExpiry', expirationDate: null });
    expect(orderCandidatesByPolicy([noExpiry, withExpiry], 'FEFO').map((c) => c.stockBalanceId)).toEqual(['withExpiry', 'noExpiry']);
  });

  it('ordenação não muta o array de entrada', () => {
    const a = candidate({ stockBalanceId: 'a', expirationDate: '2026-12-01' });
    const b = candidate({ stockBalanceId: 'b', expirationDate: '2026-01-01' });
    const input = [a, b];
    orderCandidatesByPolicy(input, 'FEFO');
    expect(input.map((c) => c.stockBalanceId)).toEqual(['a', 'b']);
  });
});

describe('RN-EST-011 / RN-DAD-010 — LIFO_PHYSICAL limita ao palete acessível', () => {
  it('em canal LIFO_PHYSICAL só o último a entrar é candidato', () => {
    const first = candidate({ stockBalanceId: 'first', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch1', entryDate: '2026-01-01T00:00:00.000Z' });
    const last = candidate({ stockBalanceId: 'last', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch1', entryDate: '2026-06-01T00:00:00.000Z' });

    const accessible = restrictToAccessiblePallets([first, last]);
    expect(accessible.map((c) => c.stockBalanceId)).toEqual(['last']);
  });

  it('canais LIFO distintos são independentes; estruturas sem restrição passam inteiras', () => {
    const ch1Old = candidate({ stockBalanceId: 'ch1Old', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch1', entryDate: '2026-01-01T00:00:00.000Z' });
    const ch1New = candidate({ stockBalanceId: 'ch1New', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch1', entryDate: '2026-02-01T00:00:00.000Z' });
    const ch2Old = candidate({ stockBalanceId: 'ch2Old', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch2', entryDate: '2026-03-01T00:00:00.000Z' });
    const ch2New = candidate({ stockBalanceId: 'ch2New', accessPolicy: 'LIFO_PHYSICAL', channelKey: 'ch2', entryDate: '2026-04-01T00:00:00.000Z' });
    const random = candidate({ stockBalanceId: 'random', accessPolicy: 'RANDOM', channelKey: 'ch3', entryDate: '2026-01-01T00:00:00.000Z' });
    const flowrack = candidate({ stockBalanceId: 'flowrack', accessPolicy: 'FIFO_PHYSICAL', channelKey: 'ch4', entryDate: '2026-01-01T00:00:00.000Z' });

    const accessible = restrictToAccessiblePallets([ch1Old, ch1New, ch2Old, ch2New, random, flowrack]);
    expect(accessible.map((c) => c.stockBalanceId).sort()).toEqual(['ch1New', 'ch2New', 'flowrack', 'random']);
  });
});

describe('Atendimento parcial (§4.2)', () => {
  it('consome em ordem até completar a demanda', () => {
    const a = candidate({ stockBalanceId: 'a', qtyAvailable: 30 });
    const b = candidate({ stockBalanceId: 'b', qtyAvailable: 30 });
    const c = candidate({ stockBalanceId: 'c', qtyAvailable: 30 });

    const result = allocateDemand([a, b, c], 50);
    expect(result.allocations.map((x) => [x.candidate.stockBalanceId, x.qtyAllocated])).toEqual([
      ['a', 30],
      ['b', 20],
    ]);
    expect(result.shortfall).toBe(0);
  });

  it('demanda maior que o disponível devolve shortfall (RG-004: não inventa saldo)', () => {
    const a = candidate({ stockBalanceId: 'a', qtyAvailable: 40 });
    const result = allocateDemand([a], 100);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].qtyAllocated).toBe(40);
    expect(result.shortfall).toBe(60);
  });

  it('candidato com saldo zero é ignorado', () => {
    const zero = candidate({ stockBalanceId: 'zero', qtyAvailable: 0 });
    const real = candidate({ stockBalanceId: 'real', qtyAvailable: 10 });
    const result = allocateDemand([zero, real], 10);
    expect(result.allocations.map((x) => x.candidate.stockBalanceId)).toEqual(['real']);
  });
});
