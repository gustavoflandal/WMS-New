-- RNF-ARQ-030..033: Event outbox table with partitioning
-- [INVIOLÁVEL] Guarantees events are published exactly-once via transactional outbox pattern

-- Create event envelope type (RNF-ARQ-030)
CREATE TYPE wms.event_envelope AS (
  event_id UUID,
  event_type VARCHAR(255),
  aggregate_type VARCHAR(255),
  aggregate_id UUID,
  tenant_id UUID,
  module VARCHAR(50),
  data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE,
  correlation_id UUID,
  causation_id UUID
);

-- Outbox table (RNF-ARQ-031)
-- Partitioned monthly for performance (RNF-ARQ-090)
CREATE TABLE wms.event_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  aggregate_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  module VARCHAR(50) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP WITH TIME ZONE,
  correlation_id UUID,
  causation_id UUID,
  retry_count INT DEFAULT 0,
  error_message TEXT
) PARTITION BY RANGE (created_at);

-- Enable RLS on event_outbox
ALTER TABLE wms.event_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_outbox_tenant ON wms.event_outbox
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

-- Create initial partition for current month
CREATE TABLE wms.event_outbox_202608 PARTITION OF wms.event_outbox
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Index for outbox polling (RNF-ARQ-031)
CREATE INDEX idx_event_outbox_published ON wms.event_outbox (published_at, created_at)
  WHERE published_at IS NULL;

-- Index for consumer group tracking
CREATE INDEX idx_event_outbox_module_tenant ON wms.event_outbox (module, tenant_id, created_at);

-- Grants
GRANT SELECT, INSERT, UPDATE ON wms.event_outbox TO wms_app;

-- Function to create next month's partition (called by scheduler - RNF-ARQ-090)
CREATE OR REPLACE FUNCTION wms.create_event_outbox_partition(
  p_year INT,
  p_month INT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition_name TEXT;
  v_start_date DATE;
  v_end_date DATE;
BEGIN
  v_start_date := make_date(p_year, p_month, 1);
  v_end_date := v_start_date + INTERVAL '1 month';
  v_partition_name := 'event_outbox_' || to_char(v_start_date, 'YYYYMM');

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS wms.%I PARTITION OF wms.event_outbox
     FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    v_start_date,
    v_end_date
  );
END;
$$;

-- Dead Letter Queue for failed events (RNF-ARQ-032)
CREATE TABLE wms.event_dlq (
  dlq_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  aggregate_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  data JSONB NOT NULL,
  reason TEXT NOT NULL,
  attempt_count INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES wms.event_outbox (event_id) ON DELETE RESTRICT
);

ALTER TABLE wms.event_dlq ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_dlq_tenant ON wms.event_dlq
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

GRANT SELECT, INSERT ON wms.event_dlq TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (3, 'Event outbox: partitioned table, RLS policy, DLQ, partition creation function', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
