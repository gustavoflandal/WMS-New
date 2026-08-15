-- Migration: 0005
-- Worker Role for Cross-Tenant Background Processing
-- RNF-ARQ-031/032 [INVIOLÁVEL]: outbox-publisher and realtime-fanout workers must
-- poll wms.event_outbox across ALL tenants (they relay already-committed, already
-- tenant-scoped payloads to Redis — they do not expose or interpret business data).
-- ADR-006 (docs/adr/ADR-006-outbox-worker-concurrency.md) documents this decision.
--
-- RG-001 forbids disabling RLS at runtime and forbids interactive/user "all tenants"
-- mode. This role is neither: RLS remains ENABLED and FORCE'd on every table for
-- every other role; wms_worker is a role-level bypass exception (a standard Postgres
-- RLS idiom for trusted system processes), reachable only from the two background
-- worker processes, never from the HTTP request path, and granted access to exactly
-- the tables it needs (least privilege).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'wms_worker') THEN
    CREATE ROLE wms_worker WITH LOGIN PASSWORD 'wms_worker_password' BYPASSRLS;
  ELSE
    ALTER ROLE wms_worker WITH BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA wms TO wms_worker;

-- Outbox: SELECT + UPDATE (mark published_at) — RNF-ARQ-031
GRANT SELECT, UPDATE ON wms.event_outbox TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (5, 'Worker role: wms_worker with BYPASSRLS for cross-tenant outbox polling (ADR-006)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
