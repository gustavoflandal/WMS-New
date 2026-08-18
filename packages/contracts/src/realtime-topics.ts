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
  // DOC-04 §4.7 — Recebimento e Docas (11 eventos). DOC-04 não detalha
  // tópico por evento (diferente de partes do §4.6 do DOC-03) — mapeamento
  // segue a MESMA lógica categórica já estabelecida: eventos de estado
  // físico da doca -> "docas"; eventos que o cliente precisa ver
  // (notificação/decisão pendente) -> "alertas"; progresso operacional
  // rotineiro (contagem, etiquetagem, putaway, conclusão) -> "operations:pending"
  // (RF-ARQ-041, mesmo tópico genérico já usado para progresso de operação).
  'recebimento.ordem_criada': STANDARD_TOPICS.ALERTS,
  'recebimento.atracado': STANDARD_TOPICS.DOCAS,
  'recebimento.descarga_iniciada': STANDARD_TOPICS.DOCAS,
  'recebimento.item_conferido': STANDARD_TOPICS.OPERATIONS_PENDING,
  'recebimento.divergencia_registrada': STANDARD_TOPICS.ALERTS,
  'recebimento.conferencia_encerrada': STANDARD_TOPICS.OPERATIONS_PENDING,
  'recebimento.lpn_gerado': STANDARD_TOPICS.OPERATIONS_PENDING,
  'recebimento.putaway_concluido': STANDARD_TOPICS.OPERATIONS_PENDING,
  'recebimento.quarentena_liberada': STANDARD_TOPICS.ALERTS,
  'recebimento.crossdock_reservado': STANDARD_TOPICS.ALERTS,
  'recebimento.concluido': STANDARD_TOPICS.OPERATIONS_PENDING,
  // RNF-REC-052 (não um dos 11 de §4.7, mesmo precedente de
  // 'portaria.vaga_indisponivel'): saldo em zona CROSS_DOCKING além de
  // REC.CROSSDOCK_TEMPO_MAX_H gera alerta no painel/tópico "alertas".
  'recebimento.crossdock_tempo_excedido': STANDARD_TOPICS.ALERTS,
  // RN-REC-023 (idem, não um dos 11 de §4.7): REC.RECUSA_TOTAL aprovada —
  // Ordem -> REFUSED, evento visível para o cliente/operação.
  'recebimento.recusa_total_aplicada': STANDARD_TOPICS.ALERTS,
  // DOC-05 §4.8 — Estoque e Movimentação (13 eventos). Mesma lógica
  // categórica já estabelecida (DOC-03/DOC-04): mudança de saldo/ajuste
  // -> "inventory:changed" (RF-ARQ-041, já existe para isso); progresso
  // operacional rotineiro (transferência, reposição, kanban, contagem,
  // conclusão de inventário) -> "operations:pending"; o que o cliente/
  // painel precisa ver como notificação (vencimento, violação de estoque
  // de segurança, descarte) -> "alertas".
  'estoque.saldo_alterado': STANDARD_TOPICS.INVENTORY_CHANGED,
  'estoque.transferencia_criada': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.transferencia_concluida': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.reposicao_gerada': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.kanban_disparado': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.estoque_seguranca_violado': STANDARD_TOPICS.ALERTS,
  'estoque.lote_a_vencer': STANDARD_TOPICS.ALERTS,
  'estoque.lote_vencido_bloqueado': STANDARD_TOPICS.ALERTS,
  'estoque.inventario_iniciado': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.endereco_contado': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.ajuste_aplicado': STANDARD_TOPICS.INVENTORY_CHANGED,
  'estoque.inventario_concluido': STANDARD_TOPICS.OPERATIONS_PENDING,
  'estoque.descarte_efetivado': STANDARD_TOPICS.ALERTS,
};
