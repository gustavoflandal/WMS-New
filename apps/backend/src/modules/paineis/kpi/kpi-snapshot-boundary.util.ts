// DOC-10 RN-PAI-042 [INVIOLÁVEL] — "KPIs de snapshot (K-13, K-16) são
// computados pelo scheduler às 23:59 do fuso do armazém" (não UTC). Função
// PURA: dado o fuso do armazém e o instante de referência, decide se já
// passou das 23:59 locais — o worker (kpi-snapshot.worker.impl.ts) só
// chama isto e, em caso positivo, decide (via kpi_daily já existir ou não
// para o dia) se ainda precisa rodar.
export function isPastLocalSnapshotTime(timezone: string, referenceDate: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(referenceDate);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour === 23 && minute >= 59;
}

/** Data local (YYYY-MM-DD) do armazém no instante de referência. */
export function localDate(timezone: string, referenceDate: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(referenceDate);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}
