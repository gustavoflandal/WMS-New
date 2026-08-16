// RF-ARQ-040..041: Standard real-time topic catalog and event→topic mapping.
// Single source of truth shared by the Socket.IO gateway (publisher side) and
// the realtime-fanout worker (RNF-ARQ-033), so both agree on topic names.

/** RF-ARQ-041: Standard topics registered for subscription. */
export const STANDARD_TOPICS = {
  OPERATIONS_PENDING: 'operations:pending', // Operations needing action
  INVENTORY_CHANGED: 'inventory:changed', // Stock level changes
  DEVICE_STATUS: 'device:status', // Edge Agent device status
  SYNC_PROGRESS: 'sync:progress', // Sync operation progress
  ALERTS: 'alertas', // DOC-12 RF-SEG-044: notificação de exceção operacional criada/decidida
  PATIO: 'patio', // DOC-03 RF-POR-020: painel de pátio em tempo real
  DOCAS: 'docas', // DOC-03 RF-POR-022: reserva/chamada de doca
} as const;

export type StandardTopic = (typeof STANDARD_TOPICS)[keyof typeof STANDARD_TOPICS];

/**
 * RF-ARQ-041: event_type → topic mapping consumed by realtime-fanout.
 * event_type not present here is NOT an error: it logs a warn and the message
 * is acknowledged without republishing (module not yet mapped — expected for
 * modules not yet implemented, per Session 1.5 scope).
 */
export const EVENT_TOPIC_MAPPING: Record<string, StandardTopic> = {
  // Test/smoke event, removable once real business modules register their own.
  'teste.evento_emitido': STANDARD_TOPICS.OPERATIONS_PENDING,
  // DOC-12 §4.5/§5.1 — Workflow de Aprovação (RF-SEG-044, RN-SEG-021 escalonamento).
  'seguranca.excecao_criada': STANDARD_TOPICS.ALERTS,
  'seguranca.excecao_escalada': STANDARD_TOPICS.ALERTS,
  'seguranca.excecao_aprovada': STANDARD_TOPICS.ALERTS,
  'seguranca.excecao_rejeitada': STANDARD_TOPICS.ALERTS,
  // DOC-03 §4.6 — Portaria e Pátio. Eventos de agendamento (notificação ao
  // cliente/portal) vão para "alertas"; eventos de presença/estado físico
  // do veículo no site vão para "patio" (RF-POR-020: painel de pátio em
  // tempo real); a chamada para doca vai para "docas" por ser
  // primariamente um evento de reserva de doca (RF-POR-022).
  'portaria.agendamento_criado': STANDARD_TOPICS.ALERTS,
  'portaria.agendamento_cancelado': STANDARD_TOPICS.ALERTS,
  'portaria.agendamento_no_show': STANDARD_TOPICS.ALERTS,
  'portaria.veiculo_chegou': STANDARD_TOPICS.PATIO,
  'portaria.gate_in_concluido': STANDARD_TOPICS.PATIO,
  'portaria.vaga_ocupada': STANDARD_TOPICS.PATIO,
  'portaria.fila_atualizada': STANDARD_TOPICS.PATIO,
  'portaria.chamada_doca': STANDARD_TOPICS.DOCAS,
  'portaria.gate_out_concluido': STANDARD_TOPICS.PATIO,
  'portaria.pessoa_entrou': STANDARD_TOPICS.PATIO,
  'portaria.pessoa_saiu': STANDARD_TOPICS.PATIO,
  // [LACUNA: DOC-03 §4.6 lista 11 eventos, mas o Gherkin de RN-POR-013 (§6,
  // "Hazmat exige vaga dedicada") exige um alerta publicado no tópico
  // "alertas" quando não há vaga HAZMAT livre — sem evento correspondente
  // nos 11. Adicionado citando a fonte exata (§6), não os 11 do §4.6.
  // Reaproveitado também para o caso análogo de nenhuma vaga comum livre
  // (ver nota em vehicle_visit_blocking_reason_check, migration 0028).]
  'portaria.vaga_indisponivel': STANDARD_TOPICS.ALERTS,
};
