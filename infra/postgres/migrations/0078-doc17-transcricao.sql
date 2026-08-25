-- Migration: 0078
-- DOC-17 §8 — Sessão 10D: Transcrição de Formulário de Campo.
-- RD-TEL-003 (wms.form_transcription), permissões TEL.TRANSCREVER e
-- TEL.TRANSCREVER_PROPRIO (§4), exceções TEL.TRANSCRICAO_DIVERGENTE /
-- TEL.FORMULARIO_EXPIRADO / TEL.SEGREGACAO_TRANSCRICAO (§4), parâmetros
-- TEL.EXIGE_SEGREGACAO_TRANSCRICAO e TEL.DUPLA_DIGITACAO (§11).

-- ── 1. Vínculo do executante com um usuário real (RN-TEL-032) ─────────────
-- A 10B gravava só `declared_executor_name` (o texto impresso no papel).
-- RN-TEL-032 fala em "o USUÁRIO que consta como executante" — sem este
-- vínculo a segregação de funções é inaplicável. Anulável: o executante
-- pode legitimamente não ser usuário do sistema (terceiro, temporário), e
-- nesse caso não há segregação a aferir.
ALTER TABLE wms.field_form ADD COLUMN IF NOT EXISTS declared_executor_user_id UUID REFERENCES wms.user(id) ON DELETE RESTRICT;

COMMENT ON COLUMN wms.field_form.declared_executor_user_id IS
  'DOC-17 RN-TEL-032: usuario que consta como executante, para aferir a segregacao de funcoes na transcricao. NULL = executante nao e usuario do sistema.';

-- ── 2. RD-TEL-003 — wms.form_transcription (TENANT, RLS) ──────────────────
CREATE TABLE IF NOT EXISTS wms.form_transcription (
  id UUID PRIMARY KEY DEFAULT wms.uuid_v7(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  field_form_id UUID NOT NULL REFERENCES wms.field_form(id) ON DELETE RESTRICT,
  transcribed_by UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- RN-TEL-032: quando a segregação foi dispensada por TEL.TRANSCREVER_PROPRIO,
  -- guarda a exceção que registrou a dispensa.
  segregation_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  -- RN-TEL-033: transcrição após a validade exige TEL.FORMULARIO_EXPIRADO.
  expiry_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  -- RF-TEL-034: resultado consolidado por linha (aplicada/descartada/etc.).
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  -- RN-TEL-031 item 2 [INVIOLÁVEL]: "um formulário só pode ser transcrito
  -- UMA vez". A unicidade é do BANCO, não da aplicação — duas transcrições
  -- concorrentes do mesmo formulário não podem existir nem sob corrida.
  CONSTRAINT form_transcription_form_unique UNIQUE (field_form_id)
);

CREATE INDEX IF NOT EXISTS idx_form_transcription_warehouse ON wms.form_transcription (warehouse_id, created_at);

ALTER TABLE wms.form_transcription ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.form_transcription FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_transcription_tenant_isolation ON wms.form_transcription;
CREATE POLICY form_transcription_tenant_isolation ON wms.form_transcription
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.form_transcription TO wms_app;

-- ── 3. Permissões (DOC-17 §4) ─────────────────────────────────────────────
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('TEL.TRANSCREVER',         'CLIENT_WAREHOUSE', 'Digitar o resultado de um Formulario de Campo (DOC-17 RF-TEL-030)',                    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('TEL.TRANSCREVER_PROPRIO', 'CLIENT_WAREHOUSE', 'Transcrever formulario que o proprio usuario executou (DOC-17 RN-TEL-032, sensivel)', TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- DOC-17 §4: "Digitador / Auxiliar administrativo transcreve formulários
-- preenchidos"; o Líder de Turno "transcreve ou supervisiona". Não há papel
-- DIGITADOR no catálogo de seed (migration 0016) — LIDER_TURNO e
-- GESTOR_ARMAZEM recebem TEL.TRANSCREVER, e a quebra de segregação
-- (TRANSCREVER_PROPRIO, sensível) fica só com o Gestor.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'TEL.TRANSCREVER', '00000000-0000-0000-0000-000000000001'
FROM wms.role r WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'TEL.TRANSCREVER_PROPRIO', '00000000-0000-0000-0000-000000000001'
FROM wms.role r WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- ── 4. Exceções (DOC-17 §4) ───────────────────────────────────────────────
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('TEL.TRANSCRICAO_DIVERGENTE', 'Transcricao fora do previsto no formulario (DOC-17 RN-TEL-033)', 1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('TEL.FORMULARIO_EXPIRADO',    'Transcrever apos a validade do formulario (DOC-17 RN-TEL-033)',  1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('TEL.SEGREGACAO_TRANSCRICAO', 'Executante transcreve a si mesmo (DOC-17 RN-TEL-032)',           1, TRUE, 8,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- ── 5. Parâmetros (DOC-17 §11) ────────────────────────────────────────────
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'TEL.EXIGE_SEGREGACAO_TRANSCRICAO', 'true'),
  -- RF-TEL-034: "padrão true para inventário". Mapa por tipo de formulário,
  -- não escalar único — CONTAGEM e CONFERENCIA são os tipos que a regra cita.
  ('GLOBAL', 'TEL.DUPLA_DIGITACAO', '{"CONTAGEM": true, "CONFERENCIA": false}')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (78, 'DOC-17 10D: Transcricao (form_transcription, permissoes TEL.TRANSCREVER*, excecoes TEL.*, parametros de segregacao e dupla digitacao)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
