-- Migration: 0007
-- Edge Agent Registry and Job Queue (skeleton) — RNF-ARQ-060..061, RD-ARQ-003/004
-- Drivers per peripheral are out of scope (DOC-11 session).

CREATE TYPE wms.device_status AS ENUM (
  'ONLINE',
  'OFFLINE',
  'MAINTENANCE',
  'RETIRED'
);

CREATE TYPE wms.job_state AS ENUM (
  'PENDENTE',
  'EM_PROGRESSO',
  'COMPLETADO',
  'ERRO',
  'EXPIRADO'
);

CREATE TABLE IF NOT EXISTS wms.edge_agent (
  edge_agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  device_type VARCHAR(50),
  serial_number VARCHAR(255),
  token VARCHAR(255) NOT NULL UNIQUE,
  status wms.device_status NOT NULL DEFAULT 'OFFLINE',
  ip_address INET,
  last_heartbeat TIMESTAMP WITH TIME ZONE,
  firmware_version VARCHAR(50),
  capabilities JSONB,
  paired_at TIMESTAMP WITH TIME ZONE,
  paired_by UUID,
  retired_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edge_agent_token ON wms.edge_agent(token);
CREATE INDEX IF NOT EXISTS idx_edge_agent_warehouse ON wms.edge_agent(tenant_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_edge_agent_heartbeat ON wms.edge_agent(last_heartbeat) WHERE status = 'ONLINE';

GRANT SELECT, INSERT, UPDATE ON wms.edge_agent TO wms_app;

ALTER TABLE wms.edge_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.edge_agent FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edge_agent_tenant_isolation ON wms.edge_agent;

CREATE POLICY edge_agent_tenant_isolation ON wms.edge_agent
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

CREATE TABLE IF NOT EXISTS wms.edge_agent_job (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_agent_id UUID NOT NULL REFERENCES wms.edge_agent(edge_agent_id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  command JSONB NOT NULL,
  state wms.job_state NOT NULL DEFAULT 'PENDENTE',
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 hour',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  result JSONB,
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  idempotency_key UUID UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_edge_agent_job_pending
  ON wms.edge_agent_job(edge_agent_id, state)
  WHERE state IN ('PENDENTE', 'ERRO');

CREATE INDEX IF NOT EXISTS idx_edge_agent_job_expired
  ON wms.edge_agent_job(expires_at)
  WHERE state != 'COMPLETADO';

CREATE INDEX IF NOT EXISTS idx_edge_agent_job_idempotency
  ON wms.edge_agent_job(idempotency_key, tenant_id);

GRANT SELECT, INSERT, UPDATE ON wms.edge_agent_job TO wms_app;

ALTER TABLE wms.edge_agent_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.edge_agent_job FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edge_agent_job_tenant_isolation ON wms.edge_agent_job;

CREATE POLICY edge_agent_job_tenant_isolation ON wms.edge_agent_job
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
VALUES (7, 'Edge Agent: device registry, job queue, idempotency, expiration, RLS', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
