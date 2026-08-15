-- RNF-ARQ-050..053: Synchronization operation tracking (offline-first PWA)
-- Stores pending operations from field devices; resyncs when online
-- [NOTE: Conflict resolution logic (RN-ARQ-053) is deferred to session 3]

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

CREATE TABLE wms.sync_operation (
  sync_operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  warehouse_id UUID,
  device_id UUID NOT NULL,  -- Edge Agent device
  operation_type wms.sync_operation_type NOT NULL,
  entity_type VARCHAR(50) NOT NULL,  -- e.g., 'picking_line', 'stock_movement'
  entity_id UUID NOT NULL,
  entity_data JSONB NOT NULL,  -- Snapshot of entity at time of offline operation
  status wms.sync_operation_status DEFAULT 'PENDING',
  idempotency_key UUID NOT NULL UNIQUE,  -- RG-009: Idempotence
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  conflict_resolution JSON,  -- [LACUNA: Conflict resolution strategy - RN-ARQ-053]
  -- Expiration: operations older than 7 days marked EXPIRED (RNF-ARQ-050)
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days',
  -- For reordering after sync (ensures causal ordering)
  lamport_clock INT
);

-- RLS policy
ALTER TABLE wms.sync_operation ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_sync_tenant ON wms.sync_operation
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

-- Indexes for efficient polling
CREATE INDEX idx_sync_operation_pending ON wms.sync_operation (tenant_id, status, created_at)
  WHERE status IN ('PENDING', 'CONFLICT');

CREATE INDEX idx_sync_operation_device ON wms.sync_operation (device_id, tenant_id);

CREATE INDEX idx_sync_operation_idempotency ON wms.sync_operation (idempotency_key, tenant_id);

-- Expiration cleanup index
CREATE INDEX idx_sync_operation_expired ON wms.sync_operation (expires_at)
  WHERE status != 'SYNCED';

-- Grants
GRANT SELECT, INSERT, UPDATE ON wms.sync_operation TO wms_app;

-- [LACUNA: Conflict resolution logic (RN-ARQ-053) to be implemented in session 3]
-- Placeholder: Strategy pattern provider will be injected at app start

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (4, 'Sync operation: offline-first PWA support, idempotency keys, expiration', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
