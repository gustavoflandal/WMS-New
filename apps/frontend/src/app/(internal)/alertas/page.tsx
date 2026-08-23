// DOC-10 RF-PAI-010 — centro de alertas: severidade agrupada, marcar como
// lido, navegar para o objeto de origem. Cross-cliente por natureza (mesmo
// motivo do Painel — RN-SEG-011), então usa polling, não WebSocket (ver
// nota em use-realtime.ts).
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Info, ShieldAlert, Check } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@wms/ui';
import { useAuth } from '../../../lib/auth-context';
import { apiClient } from '../../../lib/api-client';

interface AlertRow {
  id: string;
  tenant_id: string | null;
  warehouse_id: string;
  severity: 'INFO' | 'WARN' | 'CRIT';
  alert_type: string;
  title: string;
  message: string | null;
  source_entity: string;
  source_entity_id: string;
  status: 'EMITIDO' | 'RESOLVIDO';
  created_at: string;
  is_read: boolean;
}

const SEVERITY_TONE: Record<AlertRow['severity'], StatusTone> = { CRIT: 'blocked', WARN: 'warning', INFO: 'neutral' };
const SEVERITY_ICON = { CRIT: ShieldAlert, WARN: AlertTriangle, INFO: Info };
const SEVERITY_LABEL = { CRIT: 'Crítico', WARN: 'Atenção', INFO: 'Informativo' };

// [LACUNA: RF-PAI-010 "navegar para o objeto de origem" — só as entidades
// com trilha (Fluxo Operacional) têm uma tela de destino nesta sessão;
// demais source_entity (dispositivo, lote, etc.) não têm tela própria ainda.
const NAVIGABLE_ENTITIES = new Set(['inbound_order', 'outbound_order']);

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function AlertasPage(): JSX.Element {
  const router = useRouter();
  const { warehouseId } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(() => {
    if (!warehouseId) return;
    apiClient
      .get<AlertRow[]>(`/paineis/alertas?warehouse_id=${warehouseId}&status=EMITIDO`)
      .then(setAlerts)
      .catch(() => setError('Não foi possível carregar os alertas.'));
  }, [warehouseId]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 15000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const handleMarkRead = async (alert: AlertRow): Promise<void> => {
    await apiClient.post(`/paineis/alertas/${alert.id}/lido`, { tenant_id: alert.tenant_id, warehouse_id: alert.warehouse_id });
    setAlerts((prev) => prev?.map((a) => (a.id === alert.id ? { ...a, is_read: true } : a)) ?? null);
  };

  const handleNavigate = (alert: AlertRow): void => {
    if (!NAVIGABLE_ENTITIES.has(alert.source_entity)) return;
    const url = new URL(`/trilha/${alert.source_entity}/${alert.source_entity_id}`, window.location.origin);
    if (alert.tenant_id) url.searchParams.set('tenant_id', alert.tenant_id);
    router.push(url.pathname + url.search);
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Central de alertas</h1>

      {error ? (
        <p role="alert" className="text-body text-state-pending">
          {error}
        </p>
      ) : null}

      {alerts === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-card bg-surface-sunken motion-reduce:animate-none" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <p className="text-body text-text-secondary">Nenhum alerta emitido neste armazém.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {alerts.map((alert) => (
            <li
              key={alert.id}
              className="flex items-start justify-between gap-4 rounded-card border border-border-subtle bg-surface-raised p-4"
            >
              <button
                type="button"
                onClick={() => handleNavigate(alert)}
                disabled={!NAVIGABLE_ENTITIES.has(alert.source_entity)}
                className="flex flex-1 flex-col items-start gap-1 text-left disabled:cursor-default"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge tone={SEVERITY_TONE[alert.severity]} icon={SEVERITY_ICON[alert.severity]} label={SEVERITY_LABEL[alert.severity]} />
                  {!alert.is_read ? <span className="h-2 w-2 rounded-full bg-brand" aria-label="Não lido" /> : null}
                  <span className="text-body text-text-primary">{alert.title}</span>
                </div>
                {alert.message ? <p className="text-body text-text-secondary">{alert.message}</p> : null}
                <span className="text-label text-text-secondary">{formatTimestamp(alert.created_at)}</span>
              </button>
              {!alert.is_read ? (
                <button
                  type="button"
                  onClick={() => handleMarkRead(alert)}
                  className="flex items-center gap-1 rounded-field px-2 py-1 text-label text-text-secondary hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  Marcar como lido
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
