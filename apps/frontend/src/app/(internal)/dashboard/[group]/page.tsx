// DOC-10 RF-PAI-040/043 — Dashboard: 4 grupos fixos, filtro de período
// (padrão hoje) + cliente autorizado, cartão por KPI (valor + média de 7
// dias + tendência + série temporal) e exportação CSV auditada.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Download, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useAuth } from '../../../../lib/auth-context';
import { apiClient, ApiError, API_URL } from '../../../../lib/api-client';
import { KPI_CATALOG, formatKpiValue } from '../../../../lib/kpi-catalog';

// Códigos EXATOS de DASHBOARD_GROUPS (dashboard-groups.util.ts) — a rota HTTP
// (resolveGroup) só aceita esses 4 valores, maiúsculos.
const GROUPS: Array<{ code: string; label: string }> = [
  { code: 'RECEBIMENTO', label: 'Recebimento' },
  { code: 'EXPEDICAO', label: 'Expedição' },
  { code: 'PATIO_PORTARIA', label: 'Pátio & portaria' },
  { code: 'ESTOQUE', label: 'Estoque' },
];

interface KpiCard {
  kpiCode: string;
  value: number;
  sevenDayAverage: number;
  trend: 'UP' | 'DOWN' | 'FLAT';
  timeseries: Array<{ day: string; value: number }>;
}

interface DashboardResult {
  group: string;
  cards: KpiCard[];
  topClientsByVolume: Array<{ clientId: string; clientName: string | null; value: number }>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function Sparkline({ points }: { points: number[] }): JSX.Element | null {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = 100 / (points.length - 1);
  const coords = points.map((v, i) => `${i * step},${30 - ((v - min) / range) * 30}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full text-brand" aria-hidden="true">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const TREND_ICON = { UP: TrendingUp, DOWN: TrendingDown, FLAT: Minus };

export default function DashboardGroupPage(): JSX.Element {
  const params = useParams<{ group: string }>();
  const router = useRouter();
  const { warehouseId, context } = useAuth();
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [clientId, setClientId] = useState('');
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(() => {
    if (!warehouseId) return;
    const query = new URLSearchParams({ warehouse_id: warehouseId, from, to });
    if (clientId) query.set('client_id', clientId);
    apiClient
      .get<DashboardResult>(`/paineis/dashboard/${params.group}?${query.toString()}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o dashboard.'));
  }, [warehouseId, from, to, clientId, params.group]);

  useEffect(() => {
    setResult(null);
    setError(null);
    fetchDashboard();
  }, [fetchDashboard]);

  const handleExport = async (): Promise<void> => {
    if (!warehouseId) return;
    const token = window.sessionStorage.getItem('wms_access_token');
    const query = new URLSearchParams({ warehouse_id: warehouseId, from, to });
    if (clientId) query.set('client_id', clientId);
    const response = await fetch(`${API_URL}/paineis/dashboard/${params.group}/csv?${query.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      setError('Não foi possível exportar o CSV.');
      return;
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${params.group}-${from}-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Dashboard</h1>

      <nav className="flex gap-1 border-b border-border-subtle">
        {GROUPS.map((g) => (
          <button
            key={g.code}
            type="button"
            onClick={() => router.push(`/dashboard/${g.code}`)}
            className={
              'px-3 py-2 text-body ' +
              (params.group === g.code ? 'border-b-2 border-brand text-brand' : 'text-text-secondary hover:text-text-primary')
            }
          >
            {g.label}
          </button>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-label text-text-secondary">
            De
          </label>
          <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-field border border-border-strong bg-surface-raised px-2 text-body" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="to" className="text-label text-text-secondary">
            Até
          </label>
          <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-field border border-border-strong bg-surface-raised px-2 text-body" />
        </div>
        {context && context.clients.length > 0 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="client" className="text-label text-text-secondary">
              Cliente
            </label>
            <select id="client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="h-9 rounded-field border border-border-strong bg-surface-raised px-2 text-body">
              <option value="">Todos os clientes</option>
              {context.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.tradeName ?? c.legalName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button
          type="button"
          onClick={handleExport}
          className="flex h-9 items-center gap-1.5 rounded-field border border-border-strong bg-surface-raised px-3 text-body text-text-primary hover:bg-surface-sunken"
        >
          <Download aria-hidden="true" className="h-4 w-4" />
          Exportar CSV
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-body text-state-pending">
          {error}
        </p>
      ) : null}

      {result === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-card bg-surface-sunken motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {result.cards.map((card) => {
              const meta = KPI_CATALOG[card.kpiCode] ?? { label: card.kpiCode, unit: 'count' as const };
              const TrendIcon = TREND_ICON[card.trend];
              const trendTone = card.trend === 'UP' ? 'text-state-done' : card.trend === 'DOWN' ? 'text-state-pending' : 'text-text-secondary';
              return (
                <div key={card.kpiCode} className="flex flex-col gap-2 rounded-card border border-border-subtle bg-surface-raised p-4">
                  <span className="text-label text-text-secondary">{meta.label}</span>
                  <span className="font-mono text-data-lg text-text-primary">{formatKpiValue(card.value, meta.unit)}</span>
                  <div className={`flex items-center gap-1 text-label ${trendTone}`}>
                    <TrendIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>Média 7 dias: {formatKpiValue(card.sevenDayAverage, meta.unit)}</span>
                  </div>
                  <Sparkline points={card.timeseries.map((p) => p.value)} />
                </div>
              );
            })}
          </div>

          {result.topClientsByVolume.length > 0 ? (
            <div className="rounded-card border border-border-subtle bg-surface-raised p-4">
              <h2 className="mb-2 text-subtitle text-text-primary">Top 5 clientes por volume</h2>
              <ol className="flex flex-col gap-1">
                {result.topClientsByVolume.slice(0, 5).map((c, i) => (
                  <li key={c.clientId} className="flex items-center justify-between text-body text-text-primary">
                    <span>
                      {i + 1}. {c.clientName ?? 'Cliente'}
                    </span>
                    <span className="font-mono text-data">{c.value.toLocaleString('pt-BR')}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
