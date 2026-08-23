// DOC-10 §4.5 RF-PAI-040 — "layout fixo em quatro grupos: Recebimento,
// Expedição, Pátio & Portaria, Estoque". [LACUNA: o DOC-10 nomeia os 4
// grupos e a "Origem" de cada KPI (§4.5, coluna Origem), mas não associa
// cada um dos 17 KPIs a um GRUPO explicitamente — mapeamento desta sessão,
// seguindo a Origem 1:1 onde ela aponta claramente para um grupo (DOC-03->
// Pátio&Portaria, DOC-04->Recebimento, DOC-06->Expedição, DOC-05->Estoque);
// K-14 (origem DOC-10, sem grupo próprio no documento) foi posto em Estoque
// junto de K-12/13/16 por serem os outros KPIs "de painel/operação", não
// "de fluxo" — decisão registrada aqui para poder ser revista.]
//
// Também define, por KPI, como AGREGAR múltiplos dias de kpi_daily num
// período (RF-PAI-040 "filtro de período: dia/semana/mês"): contagens somam
// (SUM); percentuais, médias de tempo e ocupação fazem média (AVG) — somar
// um percentual através de dias não tem significado.
import { KpiCode } from '../kpi/kpi-computation.service.js';

export const DASHBOARD_GROUPS = {
  RECEBIMENTO: 'RECEBIMENTO',
  EXPEDICAO: 'EXPEDICAO',
  PATIO_PORTARIA: 'PATIO_PORTARIA',
  ESTOQUE: 'ESTOQUE',
} as const;
export type DashboardGroup = (typeof DASHBOARD_GROUPS)[keyof typeof DASHBOARD_GROUPS];

export const GROUP_KPIS: Record<DashboardGroup, KpiCode[]> = {
  RECEBIMENTO: ['K-01', 'K-02', 'K-03', 'K-04'],
  EXPEDICAO: ['K-05', 'K-06', 'K-07', 'K-08', 'K-15'],
  PATIO_PORTARIA: ['K-09', 'K-10', 'K-11', 'K-17'],
  ESTOQUE: ['K-12', 'K-13', 'K-14', 'K-16'],
};

const SUM_KPIS: ReadonlySet<KpiCode> = new Set(['K-01', 'K-05', 'K-10', 'K-14', 'K-16']);

/** SUM para contagens; AVG para percentuais/médias de tempo/ocupação (não faz sentido somar um percentual através de dias). */
export function aggregationKindFor(kpiCode: KpiCode): 'SUM' | 'AVG' {
  return SUM_KPIS.has(kpiCode) ? 'SUM' : 'AVG';
}

export function resolveGroup(group: string): DashboardGroup | null {
  return (Object.values(DASHBOARD_GROUPS) as string[]).includes(group) ? (group as DashboardGroup) : null;
}
