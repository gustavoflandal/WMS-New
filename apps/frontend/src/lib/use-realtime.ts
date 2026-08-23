// RF-PAI-003 (atualização em tempo real ≤ 2s) — hook de assinatura ao
// RealtimeGateway (apps/backend/src/core/realtime/realtime.gateway.ts),
// namespace /realtime, room `rt:{tenant}:{warehouse}:{topico}`. DOC-01 §5.1
// exige um modo degradado visível quando o WebSocket não está disponível —
// aqui: fallback para polling a cada 15s enquanto desconectado, com um
// indicador de status que a tela consome (nunca falha silenciosamente).
'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api-client';

export type RealtimeStatus = 'connecting' | 'live' | 'degraded';

export interface RealtimeMessage {
  topic: string;
  event_id: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface UseRealtimeOptions {
  token: string | null;
  tenantId: string | null;
  warehouseId: string | null;
  topic: string;
  /** Chamado a cada mensagem recebida via WebSocket E a cada tick de polling degradado. */
  onMessage: () => void;
  /** Intervalo do polling de fallback quando degradado (ms). */
  degradedPollMs?: number;
  /**
   * [LACUNA: arquitetura de tempo real, RF-ARQ-041] a room Pub/Sub é
   * `rt:{tenant}:{warehouse}:{topico}` — UM tenant por conexão (mesmo
   * "achado arquitetural" já documentado em rbac.service.ts: RLS/sessão
   * comparam a um único tenant_id, nunca a uma lista). Telas cross-cliente
   * (Painel, Alertas — RN-SEG-011 "irrestrito" = todos os clientes do
   * armazém) não têm um único tenant_id para assinar; force o modo
   * degradado (polling) em vez de abrir uma conexão WS que só veria os
   * eventos de UM cliente e pareceria "ao vivo" enquanto perde os demais.
   */
  skipWebSocket?: boolean;
}

export function useRealtime({ token, tenantId, warehouseId, topic, onMessage, degradedPollMs = 15000, skipWebSocket = false }: UseRealtimeOptions): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!token || !warehouseId || skipWebSocket) {
      setStatus('degraded');
      return;
    }

    setStatus('connecting');
    const wsUrl = API_URL.replace(/^http/, 'ws');
    const socket: Socket = io(`${wsUrl}/realtime`, {
      auth: { token, tenant_id: tenantId ?? '', warehouse_id: warehouseId },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      socket.emit('subscribe', { topic });
    });

    socket.on('subscribed', () => setStatus('live'));
    socket.on('message', () => onMessageRef.current());
    socket.on('disconnect', () => setStatus('degraded'));
    socket.on('connect_error', () => setStatus('degraded'));

    return () => {
      socket.disconnect();
    };
  }, [token, tenantId, warehouseId, topic, skipWebSocket]);

  // Modo degradado (DOC-01 §5.1): enquanto não há WebSocket ao vivo, a tela
  // não fica parada — poll periódico chama o mesmo onMessage (que os
  // chamadores usam para re-buscar os dados via REST).
  useEffect(() => {
    if (status !== 'degraded') return;
    const interval = setInterval(() => onMessageRef.current(), degradedPollMs);
    return () => clearInterval(interval);
  }, [status, degradedPollMs]);

  return status;
}
