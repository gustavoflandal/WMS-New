// DOC-10 §4.5 RN-PAI-041 — nomes e unidade de cada KPI, copiados dos
// comentários/lógica de apps/backend/.../paineis/kpi/kpi-computation.service.ts
// (k01OrdensRecebidas .. k17AgingPatio, funções calculatePercent/
// calculateOtifPercent/averageHours) — não inventados aqui.
export type KpiUnit = 'count' | 'percent' | 'hours' | 'minutes' | 'rate';

export interface KpiMeta {
  label: string;
  unit: KpiUnit;
}

export const KPI_CATALOG: Record<string, KpiMeta> = {
  'K-01': { label: 'Ordens recebidas', unit: 'count' },
  'K-02': { label: 'Tempo em fila na doca (não computável)', unit: 'hours' },
  'K-03': { label: 'Dock-to-stock', unit: 'hours' },
  'K-04': { label: 'Divergência de recebimento', unit: 'percent' },
  'K-05': { label: 'Pedidos expedidos', unit: 'count' },
  'K-06': { label: 'OTIF', unit: 'percent' },
  'K-07': { label: 'Lead time do pedido', unit: 'hours' },
  'K-08': { label: 'Corte de pedido', unit: 'percent' },
  'K-09': { label: 'Permanência do veículo', unit: 'hours' },
  'K-10': { label: 'Veículos atendidos', unit: 'count' },
  'K-11': { label: 'No-show', unit: 'percent' },
  'K-12': { label: 'Acuracidade de endereço', unit: 'percent' },
  'K-13': { label: 'Ocupação de posições', unit: 'percent' },
  'K-14': { label: 'Cartões atrasados', unit: 'count' },
  'K-15': { label: 'Produtividade de picking', unit: 'rate' },
  'K-16': { label: 'Lotes a vencer (30 dias)', unit: 'count' },
  'K-17': { label: 'Aging de pátio', unit: 'minutes' },
};

export function formatKpiValue(value: number, unit: KpiUnit): string {
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'hours':
      return `${value.toFixed(1)} h`;
    case 'minutes':
      return `${value.toFixed(0)} min`;
    case 'rate':
      return `${value.toFixed(2)} tarefas/h`;
    default:
      return value.toLocaleString('pt-BR');
  }
}
