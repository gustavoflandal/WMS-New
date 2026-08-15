-- Migration: 0006
-- Synchronization Operation Tracking (offline-first PWA structure)
-- RNF-ARQ-050..054, RD-ARQ-005: table structure only.
-- RN-ARQ-053 (conflict resolution logic) is deferred to the PWA activation session.

CREATE TYPE wms.sync_operation_type AS ENUM (
  'CREATE',
  'UPDATE',
  'DELETE'
);

CREATE TYPE wms.sync_operation_status AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'SYNCED',
  'CONFLICT',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE IF NOT EXISTS wms.sync_operation (
  sync_operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  warehouse_id UUID,
  device_id UUID NOT NULL,
  operation_type wms.sync_operation_type NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  entity_data JSONB NOT NULL,
  status wms.sync_operation_status NOT NULL DEFAULT 'PENDING',
  idempotency_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  conflict_resolution JSONB,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days',
  lamport_clock INT
);

CREATE INDEX IF NOT EXISTS idx_sync_operation_pending
  ON wms.sync_operation(tenant_id, status, created_at)
  WHERE status IN ('PENDING', 'CONFLICT');

CREATE INDEX IF NOT EXISTS idx_sync_operation_device
  ON wms.sync_operation(device_id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_sync_operation_idempotency
  ON wms.sync_operation(idempotency_key, tenant_id);

CREATE INDEX IF NOT EXISTS idx_sync_operation_expired
  ON wms.sync_operation(expires_at)
  WHERE status != 'SYNCED';

GRANT SELECT, INSERT, UPDATE ON wms.sync_operation TO wms_app;

ALTER TABLE wms.sync_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.sync_operation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_operation_tenant_isolation ON wms.sync_operation;

-- deny-by-omission: no context configured or empty context → no rows (RG-001, RNF-ARQ-011).
CREATE POLICY sync_operation_tenant_isolation ON wms.sync_operation
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (6, 'Sync operation: offline-first PWA structure, idempotency, RLS', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
