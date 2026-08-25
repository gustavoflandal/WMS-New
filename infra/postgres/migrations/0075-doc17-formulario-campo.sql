-- Migration: 0075
-- DOC-17 Parte B (fatia 1) — Sessão 10B: Formulário de Campo (§7).
-- RD-TEL-001 (wms.field_form) / RD-TEL-002 (wms.field_form_line), máquina de
-- estados §9.1, permissões TEL.FORMULARIO_EMITIR/REEMITIR/CANCELAR (§4),
-- parâmetro TEL.FORMULARIO_VALIDADE_H (RF-TEL-020, padrão 12h), coluna de
-- reserva field_form_id em wms.putaway_task (RN-TEL-021 — só Putaway está
-- ligado a uma tabela de tarefa real nesta sessão, ver prompt §1).
--
-- Padrão polimórfico (task_entity/task_entity_id em field_form_line) igual ao
-- já usado por wms.operation_flow (entity/entity_id) — mesmo motivo: 6 tipos
-- de origem diferentes (RF-TEL-022) sem criar uma tabela de linha por tipo.

-- 1. wms.field_form (RD-TEL-001, TENANT, RLS).
CREATE TABLE IF NOT EXISTS wms.field_form (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  form_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'EMITIDO',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ NOT NULL,
  declared_executor_name TEXT NOT NULL,
  declared_executor_registration TEXT,
  reissue_seq INT NOT NULL DEFAULT 0,
  replaces_form_id UUID REFERENCES wms.field_form(id) ON DELETE RESTRICT,
  cancel_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES wms.user(id) ON DELETE RESTRICT,
  pdf_storage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES wms.user(id) ON DELETE RESTRICT,
  CONSTRAINT field_form_number_unique UNIQUE (warehouse_id, number),
  -- RF-TEL-022: catálogo fechado dos 6 tipos de formulário.
  CONSTRAINT field_form_type_check CHECK (form_type IN (
    'PICKING', 'PUTAWAY', 'CONFERENCIA', 'CONTAGEM', 'REPOSICAO_TRANSFERENCIA', 'CARREGAMENTO'
  )),
  -- §9.1: EMITIDO -> EM_TRANSCRICAO -> {PARCIALMENTE_TRANSCRITO <-> EM_TRANSCRICAO} -> TRANSCRITO;
  -- EMITIDO -> EXPIRADO | CANCELADO | SUBSTITUIDO.
  CONSTRAINT field_form_status_check CHECK (status IN (
    'EMITIDO', 'EM_TRANSCRICAO', 'PARCIALMENTE_TRANSCRITO', 'TRANSCRITO', 'EXPIRADO', 'CANCELADO', 'SUBSTITUIDO'
  ))
);

CREATE INDEX IF NOT EXISTS idx_field_form_warehouse_status ON wms.field_form (warehouse_id, status);

ALTER TABLE wms.field_form ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.field_form FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_form_tenant_isolation ON wms.field_form;
CREATE POLICY field_form_tenant_isolation ON wms.field_form
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.field_form TO wms_app;

-- 2. wms.field_form_line (RD-TEL-002, TENANT, RLS).
CREATE TABLE IF NOT EXISTS wms.field_form_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  field_form_id UUID NOT NULL REFERENCES wms.field_form(id) ON DELETE RESTRICT,
  line_number INT NOT NULL,
  -- Padrão polimórfico (ver comentário do cabeçalho). NULL quando o tipo de
  -- formulário ainda não tem hook de reserva de tarefa real nesta sessão
  -- (só PUTAWAY tem — [DEBITO: 10B]).
  task_entity TEXT,
  task_entity_id UUID,
  -- RN-TEL-031.1: "cada linha tem chave de idempotência própria, gerada na
  -- emissão" — já criada aqui, mesmo sem consumidor nesta sessão (Transcrição
  -- é sessão seguinte), para não versionar o schema duas vezes.
  form_line_id UUID NOT NULL DEFAULT gen_random_uuid(),
  previsto JSONB NOT NULL,
  transcrito JSONB,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  motivo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  CONSTRAINT field_form_line_unique UNIQUE (field_form_id, line_number),
  CONSTRAINT field_form_line_form_line_id_unique UNIQUE (form_line_id),
  -- §9.2.
  CONSTRAINT field_form_line_status_check CHECK (status IN (
    'PENDENTE', 'APLICADA', 'DESCARTADA_DUPLICIDADE', 'REJEITADA_REGRA', 'NAO_PREENCHIDA'
  ))
);

CREATE INDEX IF NOT EXISTS idx_field_form_line_form ON wms.field_form_line (field_form_id);
CREATE INDEX IF NOT EXISTS idx_field_form_line_task ON wms.field_form_line (task_entity, task_entity_id) WHERE task_entity IS NOT NULL;

ALTER TABLE wms.field_form_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.field_form_line FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_form_line_tenant_isolation ON wms.field_form_line;
CREATE POLICY field_form_line_tenant_isolation ON wms.field_form_line
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.field_form_line TO wms_app;

-- 3. RN-TEL-021 — reserva da tarefa na emissão. Só wms.putaway_task nesta
-- sessão (ver prompt §1); field_form_id IS NOT NULL é a marca "EM_FORMULARIO"
-- (não um novo valor de putaway_task.status — preserva a máquina de estados
-- original do módulo, a spec só exige que a tarefa "deixe de aparecer" para
-- atribuição, não um literal de enum).
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS field_form_id UUID REFERENCES wms.field_form(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_putaway_task_field_form ON wms.putaway_task (field_form_id) WHERE field_form_id IS NOT NULL;

-- 4. Numeração RN-DAD-040: FRM-<ARMAZÉM>-<SEQ8>, mesma sequência atômica
-- wms.document_sequence usada por todos os outros documentos numerados.
-- document_type tem CHECK fechado (widened a cada tipo novo — mesmo padrão
-- da migration 0069 para FISCAL_DOCUMENT); adiciona FIELD_FORM à lista.
ALTER TABLE wms.document_sequence DROP CONSTRAINT IF EXISTS document_sequence_type_check;
ALTER TABLE wms.document_sequence ADD CONSTRAINT document_sequence_type_check CHECK (document_type IN (
  'INBOUND_ORDER', 'OUTBOUND_ORDER', 'TRANSFER', 'INVENTORY', 'LPN',
  'PRE_INVOICE', 'RETURN_ORDER', 'APPOINTMENT', 'FISCAL_DOCUMENT', 'FIELD_FORM'
));

-- 5. Permissões (DOC-17 §4) — só as 3 com chamador nesta sessão.
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('TEL.FORMULARIO_EMITIR',   'WAREHOUSE', 'Emissao de Formulario de Campo (DOC-17 RF-TEL-020)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('TEL.FORMULARIO_REEMITIR', 'WAREHOUSE', 'Reemissao de formulario perdido/danificado, marca RE1/RE2/... (DOC-17 RF-TEL-024)', TRUE, '00000000-0000-0000-0000-000000000001'),
  ('TEL.FORMULARIO_CANCELAR', 'WAREHOUSE', 'Cancelamento de formulario emitido, devolve tarefas a fila (DOC-17 RF-TEL-024/RN-TEL-021)', TRUE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- DOC-17 §4: "Líder de Turno: Emite formulários, atribui, reemite, cancela".
-- Gestor de Armazém incluído pelo mesmo padrão já usado para operações
-- sensíveis equivalentes (PER.REIMPRESSAO, migration 0060).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('TEL.FORMULARIO_EMITIR'), ('TEL.FORMULARIO_REEMITIR'), ('TEL.FORMULARIO_CANCELAR')
) AS p(code)
WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- 6. Parâmetro RF-TEL-020: validade padrão do formulário em horas.
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'TEL.FORMULARIO_VALIDADE_H', '12')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (75, 'DOC-17 10B: Formulario de Campo (field_form/field_form_line), reserva de putaway_task, permissoes TEL.FORMULARIO_*, TEL.FORMULARIO_VALIDADE_H', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
