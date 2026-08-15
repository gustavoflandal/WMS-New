-- RNF-ARQ-060..061: Edge Agent device registration and job queue
-- Devices authenticate via token and push/pull jobs via WebSocket

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

-- Edge agent device registry (RNF-ARQ-060)
CREATE TABLE wms.edge_agent (
  edge_agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  device_type VARCHAR(50),  -- 'COLLECTOR', 'SCALE', 'PRINTER', 'CANCELA', 'LPR'
  serial_number VARCHAR(255),
  token VARCHAR(255) NOT NULL UNIQUE,  -- Bearer token for WebSocket auth
  status wms.device_status DEFAULT 'OFFLINE',
  ip_address INET,
  last_heartbeat TIMESTAMP WITH TIME ZONE,
  firmware_version VARCHAR(50),
  capabilities JSONB,  -- e.g., {"printer": true, "scale": true}
  paired_at TIMESTAMP WITH TIME ZONE,
  paired_by UUID,
  retired_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- RLS policy
ALTER TABLE wms.edge_agent ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_edge_agent_tenant ON wms.edge_agent
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

-- Indexes
CREATE INDEX idx_edge_agent_token ON wms.edge_agent (token);
CREATE INDEX idx_edge_agent_warehouse ON wms.edge_agent (tenant_id, warehouse_id, status);
CREATE INDEX idx_edge_agent_heartbeat ON wms.edge_agent (last_heartbeat)
  WHERE status = 'ONLINE';

-- Job queue for Edge Agent devices (RNF-ARQ-061)
CREATE TABLE wms.edge_agent_job (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_agent_id UUID NOT NULL REFERENCES wms.edge_agent (edge_agent_id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  job_type VARCHAR(50) NOT NULL,  -- 'PRINT', 'WEIGH', 'SCAN', 'OPEN_GATE'
  command JSONB NOT NULL,  -- Driver-specific command payload
  state wms.job_state DEFAULT 'PENDENTE',
  -- Expiration: jobs expire after 1 hour (configurable via app_parameter)
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 hour',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  result JSONB,  -- Response payload
  error_message TEXT,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  idempotency_key UUID UNIQUE  -- RG-009: Idempotence
);

-- RLS policy
ALTER TABLE wms.edge_agent_job ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_job_tenant ON wms.edge_agent_job
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

-- Indexes for job polling
CREATE INDEX idx_edge_agent_job_pending ON wms.edge_agent_job (edge_agent_id, state)
  WHERE state IN ('PENDENTE', 'ERRO');

CREATE INDEX idx_edge_agent_job_expired ON wms.edge_agent_job (expires_at)
  WHERE state != 'COMPLETADO';

CREATE INDEX idx_edge_agent_job_idempotency ON wms.edge_agent_job (idempotency_key, tenant_id);

-- Grants
GRANT SELECT, INSERT, UPDATE ON wms.edge_agent TO wms_app;
GRANT SELECT, INSERT, UPDATE ON wms.edge_agent_job TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (6, 'Edge Agent: device registry, job queue, idempotency, expiration', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
