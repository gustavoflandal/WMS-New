// DOC-10 RN-PAI-042 [INVIOLÁVEL] — "23:59 do fuso do armazém, não UTC".
// Exemplo: armazém em America/Sao_Paulo (UTC-3). 23:59 local = 02:59 UTC do
// dia seguinte. Um armazém em UTC bateria 23:59 às 23:59 UTC — instantes
// DIFERENTES para o mesmo "23:59 local", provando que a checagem não pode
// ser feita em UTC.
import { describe, expect, it } from 'vitest';
import { isPastLocalSnapshotTime, localDate } from '../kpi-snapshot-boundary.util.js';

describe('isPastLocalSnapshotTime', () => {
  it('America/Sao_Paulo (UTC-3): 02:59 UTC é 23:59 local -> true', () => {
    const ref = new Date('2026-08-11T02:59:00.000Z');
    expect(isPastLocalSnapshotTime('America/Sao_Paulo', ref)).toBe(true);
  });

  it('America/Sao_Paulo: 02:58 UTC é 23:58 local -> false (ainda não chegou)', () => {
    const ref = new Date('2026-08-11T02:58:00.000Z');
    expect(isPastLocalSnapshotTime('America/Sao_Paulo', ref)).toBe(false);
  });

  it('UTC: o MESMO instante (02:59 UTC) não é 23:59 em UTC -> false — prova que a checagem depende do fuso, não é sempre a mesma hora UTC', () => {
    const ref = new Date('2026-08-11T02:59:00.000Z');
    expect(isPastLocalSnapshotTime('UTC', ref)).toBe(false);
  });

  it('UTC: 23:59 UTC -> true', () => {
    const ref = new Date('2026-08-10T23:59:00.000Z');
    expect(isPastLocalSnapshotTime('UTC', ref)).toBe(true);
  });

  it('meia-noite local (00:00) não conta como 23:59 do dia anterior', () => {
    const ref = new Date('2026-08-11T00:00:00.000Z');
    expect(isPastLocalSnapshotTime('UTC', ref)).toBe(false);
  });
});

describe('localDate', () => {
  it('America/Sao_Paulo: 02:30 UTC de 11/08 já é 10/08 local (antes de virar o dia às 03:00 UTC)', () => {
    const ref = new Date('2026-08-11T02:30:00.000Z');
    expect(localDate('America/Sao_Paulo', ref)).toBe('2026-08-10');
  });

  it('America/Sao_Paulo: 03:30 UTC de 11/08 já é 11/08 local', () => {
    const ref = new Date('2026-08-11T03:30:00.000Z');
    expect(localDate('America/Sao_Paulo', ref)).toBe('2026-08-11');
  });
});
