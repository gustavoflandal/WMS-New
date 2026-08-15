// RF-ARQ-040..041: Standard real-time topic catalog and event→topic mapping.
// Single source of truth shared by the Socket.IO gateway (publisher side) and
// the realtime-fanout worker (RNF-ARQ-033), so both agree on topic names.

/** RF-ARQ-041: Standard topics registered for subscription. */
export const STANDARD_TOPICS = {
  OPERATIONS_PENDING: 'operations:pending', // Operations needing action
  INVENTORY_CHANGED: 'inventory:changed', // Stock level changes
  DEVICE_STATUS: 'device:status', // Edge Agent device status
  SYNC_PROGRESS: 'sync:progress', // Sync operation progress
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
};
