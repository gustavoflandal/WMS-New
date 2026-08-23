// DOC-10 RF-PAI-001/002 — Painel de Operações: cartões dos fluxos abertos
// no armazém corrente, filtráveis, atualizados em tempo real (RF-PAI-003,
// ≤2s). Ordenação padrão: atrasados primeiro, depois por tempo na etapa
// (mais antigo primeiro) — RF-PAI-002 "atrasados primeiro, maior tempo na
// etapa primeiro". "Sem reordenação brusca": a lista só é substituída
// depois que a nova busca termina (nunca esvaziada durante o refetch), e o
// React reconcilia por key (flowId) em vez de remontar os cartões.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OperationCard, type OperationCardData } from '@wms/ui';
import { AlertTriangle, ShieldAlert, WifiOff } from 'lucide-react';
import { useAuth } from '../../../lib/auth-context';
import { apiClient } from '../../../lib/api-client';
import { useRealtime } from '../../../lib/use-realtime';
import { getStepLabels } from '../../../lib/step-labels';

interface BoardCard extends OperationCardData {
  entity: string;
  entityId: string;
  clientId: string | null;
}

interface Filters {
  onlyLate: boolean;
  onlyWithException: boolean;
  text: string;
}

function sortCards(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => {
    if (a.isLate !== b.isLate) return a.isLate ? -1 : 1;
    return (b.timeInStepMinutes ?? 0) - (a.timeInStepMinutes ?? 0);
  });
}

const DEFAULT_FILTERS: Filters = { onlyLate: false, onlyWithException: false, text: '' };

export default function PainelPage(): JSX.Element {
  const router = useRouter();
  const { warehouseId } = useAuth();
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  // RF-PAI-002 "preferências de filtro persistem por usuário" (RD-PAI-005,
  // endpoint da 7A) — nunca localStorage/sessionStorage (RG-013). Carrega
  // antes de disparar a 1ª busca de cartões; só começa a SALVAR depois que o
  // carregamento inicial terminou (senão o efeito de salvar sobrescreveria a
  // preferência do usuário com os DEFAULT_FILTERS antes de lê-la).
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);

  useEffect(() => {
    if (!warehouseId) return;
    apiClient
      .get<{ filters: Partial<Filters> }>(`/paineis/operacoes/preferencias?warehouse_id=${warehouseId}`)
      .then((pref) => setFilters({ ...DEFAULT_FILTERS, ...pref.filters }))
      .catch(() => {})
      .finally(() => setPreferenceLoaded(true));
  }, [warehouseId]);

  useEffect(() => {
    if (!preferenceLoaded) return;
    const timer = setTimeout(() => {
      apiClient.post('/paineis/operacoes/preferencias', { warehouse_id: warehouseId, filters }).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [filters, preferenceLoaded, warehouseId]);

  const fetchCards = useCallback(() => {
    if (!warehouseId) return;
    const params = new URLSearchParams({ warehouse_id: warehouseId });
    if (filters.onlyLate) params.set('only_late', 'true');
    if (filters.onlyWithException) params.set('only_with_exception', 'true');
    if (filters.text) params.set('text', filters.text);

    apiClient
      .get<BoardCard[]>(`/paineis/operacoes?${params.toString()}`)
      .then((rows) => setCards(sortCards(rows)))
      .catch(() => setError('Não foi possível carregar o painel. Tentando novamente…'));
  }, [warehouseId, filters]);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  const token = typeof window !== 'undefined' ? window.sessionStorage.getItem('wms_access_token') : null;
  // RN-SEG-011: o Painel é cross-cliente por natureza — sem um único
  // tenant_id para assinar a room WS (ver comentário em use-realtime.ts),
  // então o modo degradado (polling a cada 2s, dentro do RF-PAI-003) é a
  // estratégia PADRÃO aqui, não um fallback de falha.
  const realtimeStatus = useRealtime({
    token,
    tenantId: null,
    warehouseId,
    topic: 'operations:pending',
    onMessage: fetchCards,
    degradedPollMs: 2000,
    skipWebSocket: true,
  });

  const handleOpen = (card: OperationCardData): void => {
    const full = card as BoardCard;
    const url = new URL(`/trilha/${full.entity}/${full.entityId}`, window.location.origin);
    if (full.clientId) url.searchParams.set('tenant_id', full.clientId);
    router.push(url.pathname + url.search);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-title text-text-primary">Painel de operações</h1>
        <div className="flex items-center gap-1.5 text-label text-text-secondary" data-testid="realtime-status">
          {realtimeStatus === 'live' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-state-done" aria-hidden="true" />
              Ao vivo
            </>
          ) : (
            <>
              <WifiOff aria-hidden="true" className="h-3.5 w-3.5" />
              Atualização automática (2s)
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-body text-text-primary">
          <input type="checkbox" checked={filters.onlyLate} onChange={(e) => setFilters((f) => ({ ...f, onlyLate: e.target.checked }))} />
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-state-warning" />
          Só atrasados
        </label>
        <label className="flex items-center gap-1.5 text-body text-text-primary">
          <input
            type="checkbox"
            checked={filters.onlyWithException}
            onChange={(e) => setFilters((f) => ({ ...f, onlyWithException: e.target.checked }))}
          />
          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-state-blocked" />
          Só com exceção pendente
        </label>
        <input
          type="text"
          placeholder="Buscar por documento ou cliente"
          value={filters.text}
          onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
          className="h-9 min-w-[240px] rounded-field border border-border-strong bg-surface-raised px-3 text-body"
        />
      </div>

      {error ? (
        <p role="alert" className="text-body text-state-pending">
          {error}
        </p>
      ) : null}

      {cards === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-card bg-surface-sunken motion-reduce:animate-none" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <p className="text-body text-text-secondary">Nenhuma operação pendente neste armazém.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <OperationCard key={card.flowId} card={card} stepLabel={getStepLabels(card.entity)[card.currentStepCode] ?? card.currentStepCode} onOpen={handleOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
