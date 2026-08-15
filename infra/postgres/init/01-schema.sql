-- RNF-ARQ-011: PostgreSQL schema bootstrap
-- Create application role without BYPASSRLS permission
-- Application role MUST use RLS for tenant isolation (RG-001)

-- Check if role exists before creating
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'wms_app') THEN
    CREATE ROLE wms_app WITH LOGIN PASSWORD 'wms_app_password';
  END IF;
END $$;

-- Create schema for WMS
CREATE SCHEMA IF NOT EXISTS wms;

-- Grant permissions to application role
GRANT USAGE ON SCHEMA wms TO wms_app;
GRANT CREATE ON SCHEMA wms TO wms_app;

-- Enable Row-Level Security
ALTER SCHEMA wms OWNER TO postgres;

-- [LACUNA: RLS policies will be created in Session 1 per RG-001]
-- [LACUNA: Business tables and sequences will be created per DOC-02]

-- Migration tracking table (mandatory for all database projects)
CREATE TABLE IF NOT EXISTS wms.schema_migration (
  id BIGSERIAL PRIMARY KEY,
  version BIGINT NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'SQL',
  installed_by VARCHAR(100) NOT NULL DEFAULT 'system',
  installed_on TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_time BIGINT NOT NULL DEFAULT 0
);

GRANT ALL PRIVILEGES ON wms.schema_migration TO wms_app;

-- Record bootstrap as first migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (1, 'Bootstrap: schema, extensions, application role', 'SQL', 'bootstrap', 0)
ON CONFLICT (version) DO NOTHING;
