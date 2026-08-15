-- RLS Diagnosis SQL
-- Run inside a test transaction with set_config('app.tenant_ids', tenant_id, true)

SELECT current_user, session_user;

SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  WHERE relname IN ('rls_probe','event_outbox','app_parameter')
  ORDER BY relname;

SELECT schemaname, tablename, policyname, qual, with_check
  FROM pg_policies
  WHERE schemaname='wms'
  ORDER BY tablename, policyname;

-- Check if setting is visible inside transaction
SHOW app.tenant_ids;
