-- Migration: 0003
-- Event Outbox Table for Transactional Event Publishing
-- RNF-ARQ-030: Event Envelope schema (DOC-01 §6.2)
-- RNF-ARQ-033: Outbox pattern for exactly-once delivery
-- RNF-ARQ-090: Monthly partitioning by occurred_at
-- Scenario: DOC-01 §6 — Outbox guarantees event persistence [INVIOLÁVEL]

-- Parent table: canonical event envelope per RNF-ARQ-030
CREATE TABLE IF NOT EXISTS wms.event_outbox (
  event_id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  tenant_id UUID NOT NULL,
  warehouse_id UUID,
  actor_user_id UUID,
  actor_origin TEXT,
  correlation_id UUID,
  causation_id UUID,
  requirement_ids TEXT[],
  payload JSONB NOT NULL,
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for worker queries (RNF-ARQ-031: poll unpublished events by occurred_at)
CREATE INDEX IF NOT EXISTS idx_event_outbox_published
  ON wms.event_outbox(published_at, occurred_at)
  WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_outbox_tenant
  ON wms.event_outbox(tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_outbox_occurred_at
  ON wms.event_outbox(occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON wms.event_outbox TO wms_app;

-- RLS Policy (RG-001): Tenants can only access their own events (RNF-ARQ-011)
ALTER TABLE wms.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.event_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_outbox_tenant_isolation ON wms.event_outbox;

-- NULLIF(...,'') normalizes server-level empty-string defaults to NULL before IS NOT NULL / ::UUID cast.
-- deny-by-omission: no context configured or empty context → no rows (RG-001, RNF-ARQ-011).
CREATE POLICY event_outbox_tenant_isolation ON wms.event_outbox
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );
