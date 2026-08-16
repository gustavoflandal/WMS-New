-- Migration: 0017
-- DOC-12 §4.1 / RD-SEG-062 — wms.auth_session (refresh tokens) e
-- wms.login_attempt (GLOBAL, RD-SEG-062).

-- =============================================================================
-- auth_session — RF-SEG-003: refresh token rotativo, vinculado ao
-- dispositivo, revogavel. Guarda hash do refresh token (nunca o token cru
-- -- mesmo padrao de senha), permitindo invalidacao e deteccao de reuso
-- (replaced_by aponta para a sessao gerada na rotacao).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.auth_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  refresh_token_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  assignments_hash TEXT NOT NULL,           -- RF-SEG-003: comparado a cada refresh
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,          -- 8h interno / 24h portal
  revoked_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES wms.auth_session(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  CONSTRAINT auth_session_refresh_token_unique UNIQUE (refresh_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_auth_session_user ON wms.auth_session (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_active ON wms.auth_session (user_id) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON wms.auth_session TO wms_app;

-- =============================================================================
-- login_attempt — RD-SEG-062: log de TODA tentativa de login (inclusive
-- contra e-mail inexistente, por isso user_id nullable — diferente de
-- audit_log, onde user_id e NOT NULL). Nao editavel: so INSERT (nenhum
-- fluxo de aplicacao faz UPDATE/DELETE aqui).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.login_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_attempted TEXT NOT NULL,
  user_id UUID REFERENCES wms.user(id) ON DELETE RESTRICT,
  succeeded BOOLEAN NOT NULL,
  failure_reason TEXT,
  ip_address TEXT,
  device_id TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_user ON wms.login_attempt (user_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_email ON wms.login_attempt (email_attempted, attempted_at DESC);

GRANT SELECT, INSERT ON wms.login_attempt TO wms_app;
REVOKE UPDATE ON wms.login_attempt FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (17, 'DOC-12 auth sessions: wms.auth_session, wms.login_attempt (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
