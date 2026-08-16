-- Migration: 0015
-- DOC-12 §4.1 — wms.user (GLOBAL, RN-DAD-004: "user, role e vinculos RBAC").
-- DOC-12 nao da o dicionario de dados completo de `user` (RD-SEG-060/061 so
-- listam as tabelas de RBAC propriamente ditas), mas RD-SEG-050 (inventario
-- LGPD) confirma os campos pessoais: "usuarios (nome, e-mail, matricula)".
-- Demais colunas inferidas diretamente dos requisitos funcionais citados
-- em cada comentario abaixo.

-- =============================================================================
-- user
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                          -- RD-SEG-050
  email TEXT NOT NULL,                          -- RD-SEG-050, RF-SEG-002 (login por e-mail)
  matricula TEXT,                               -- RD-SEG-050, RF-SEG-002 (login por matricula, opcional)
  -- area: nao existe no dicionario do DOC-12 como coluna de `user` --
  -- RD-SEG-010 define `area` em `role`, nao em `user`. Modelado aqui como
  -- classificacao inerente do usuario (nao so do papel) para tornar
  -- RF-SEG-006 ("usuarios do portal NAO PODEM receber atribuicoes de area
  -- INTERNAL") verificavel de forma simples: a atribuicao so e permitida se
  -- role.area = user.area (validado em user-role-assignment.service.ts).
  -- [LACUNA: DOC-12 nao detalha explicitamente esta coluna; decisao de
  -- modelagem documentada aqui, nao um valor inventado do documento.]
  area TEXT NOT NULL,
  client_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT, -- RF-SEG-006: portal fixa tenant_ids no proprio cliente
  password_hash TEXT NOT NULL,                  -- RF-SEG-002: Argon2id
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE, -- RF-SEG-002: troca obrigatoria no primeiro acesso
  password_changed_at TIMESTAMPTZ,
  failed_login_count INT NOT NULL DEFAULT 0,    -- RF-SEG-002: bloqueio apos 5 falhas
  locked_until TIMESTAMPTZ,                     -- RF-SEG-002: bloqueio de 15 min
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,    -- RF-SEG-005
  mfa_secret TEXT,                              -- RF-SEG-005: segredo TOTP (base32)
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,                              -- nullable: usuario bootstrap nao tem criador
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT user_email_unique UNIQUE (email),
  CONSTRAINT user_matricula_unique UNIQUE (matricula),
  CONSTRAINT user_area_check CHECK (area IN ('INTERNAL', 'CLIENT_PORTAL')),
  CONSTRAINT user_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  -- RF-SEG-006: usuario de portal e sempre de UM cliente; usuario interno
  -- nao tem client_id (suas atribuicoes definem os clientes que acessa).
  CONSTRAINT user_portal_requires_client CHECK (
    (area = 'CLIENT_PORTAL' AND client_id IS NOT NULL)
    OR (area = 'INTERNAL' AND client_id IS NULL)
  )
);

GRANT SELECT, INSERT, UPDATE ON wms.user TO wms_app;

-- Usuario "Sistema" (bootstrap) -- UUID fixo ja usado como created_by/
-- actor_user_id "de sistema" em TODAS as migrations desde a Sessao 2A
-- (00000000-0000-0000-0000-000000000001), mas que nunca correspondeu a uma
-- linha real em nenhuma tabela de usuario (wms.user nao existia ate esta
-- migration). Agora que wms.audit_log (migration 0019) tem
-- user_id UUID NOT NULL REFERENCES wms.user(id), acoes originadas do
-- proprio sistema (origin='SCHEDULER', ex.: expiracao automatica de
-- excecao, RN-SEG-042) precisam de um usuario real para atribuir a
-- auditoria. password_hash e um valor propositalmente invalido para
-- Argon2 -- este usuario NUNCA deve autenticar via login (nao e um
-- "usuario compartilhado" na acepcao de RF-SEG-001, e a identidade de
-- processos do proprio sistema, nao de uma pessoa).
INSERT INTO wms.user (id, name, email, area, password_hash, must_change_password, status, created_by)
VALUES (
  '00000000-0000-0000-0000-000000000001', 'Sistema', 'sistema@wms.invalid', 'INTERNAL',
  'SYSTEM_USER_NO_LOGIN_NOT_A_VALID_ARGON2_HASH', FALSE, 'ACTIVE', '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- user_password_history — RF-SEG-002: historico das ultimas 5 senhas
-- (impede reuso). Tabela de log, nao editada -- UPDATE tambem revogado
-- (alem do DELETE, ja sem grant por padrao desde a migration 0010).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.user_password_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_password_history_user ON wms.user_password_history (user_id, created_at DESC);

GRANT SELECT, INSERT ON wms.user_password_history TO wms_app;
REVOKE UPDATE ON wms.user_password_history FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (15, 'DOC-12 user: wms.user, wms.user_password_history (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
