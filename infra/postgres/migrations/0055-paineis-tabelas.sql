-- Migration: 0055
-- DOC-10 §7 (RD-PAI-001..005) — kpi_daily/kpi_event_applied (§4.5 RN-PAI-041/
-- 042), alert/alert_read (§4.2 RF-PAI-010, §5.2), chat_room/chat_message
-- (§4.4 RF-PAI-030/RN-PAI-031), user_board_preference (§4.1 RF-PAI-002).
--
-- Decisão de modelagem — "linhas consolidadas por armazém" (RD-PAI-001) e
-- alertas sem cliente natural (Edge Agent, cartão atrasado): mesmo padrão já
-- usado por wms.app_parameter (migration 0004) para scope WAREHOUSE —
-- client_id/tenant_id NULL é uma categoria legítima ("não há dimensão de
-- cliente", não "todos os clientes agregados"), visível a qualquer sessão
-- com o warehouse_id certo, sem checar client_id. Ver texto completo no
-- relatório da sessão.

-- =============================================================================
-- 1. wms.kpi_daily (RD-PAI-001) — RN-PAI-041/042
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.kpi_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- NULL = KPI sem dimensão de cliente (K-02/03/09/10/11/13/14/17 — doca,
  -- pátio, ocupação, cartões atrasados); NOT NULL = fatia por cliente dos
  -- KPIs que têm essa dimensão (K-01/04/05/06/07/08/12/15/16).
  client_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  day DATE NOT NULL,
  kpi_code TEXT NOT NULL,
  value NUMERIC(18,4) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  created_by UUID NOT NULL,
  CONSTRAINT kpi_daily_code_check CHECK (kpi_code IN (
    'K-01','K-02','K-03','K-04','K-05','K-06','K-07','K-08','K-09','K-10',
    'K-11','K-12','K-13','K-14','K-15','K-16','K-17'
  )),
  CONSTRAINT kpi_daily_unique UNIQUE NULLS NOT DISTINCT (day, warehouse_id, client_id, kpi_code)
);

CREATE INDEX IF NOT EXISTS idx_kpi_daily_lookup ON wms.kpi_daily (warehouse_id, day, kpi_code);

ALTER TABLE wms.kpi_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.kpi_daily FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kpi_daily_visibility ON wms.kpi_daily;
CREATE POLICY kpi_daily_visibility ON wms.kpi_daily
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (client_id IS NULL OR client_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (client_id IS NULL OR client_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  );

-- RN-PAI-042: worker de materialização + comando de recontagem escrevem via
-- transactionAsWorker (BYPASSRLS, ADR-006) — cross-tenant/cross-warehouse por
-- natureza. GRANT explícito para wms_worker (BYPASSRLS não é GRANT de
-- tabela — achado da Sessão 5C, ver CLAUDE.md).
-- ALTER DEFAULT PRIVILEGES (migration 0010) concede INSERT/UPDATE a wms_app
-- por padrão em toda tabela nova — wms_app só LÊ kpi_daily (dashboard); só
-- o worker escreve.
REVOKE INSERT, UPDATE ON wms.kpi_daily FROM wms_app;
GRANT SELECT, INSERT, UPDATE ON wms.kpi_daily TO wms_worker;

-- =============================================================================
-- 2. wms.kpi_event_applied (RD-PAI-002) — RN-PAI-042 idempotência por event_id
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.kpi_event_applied (
  event_id UUID PRIMARY KEY,
  kpi_codes TEXT[] NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela de bookkeeping do worker apenas — nenhuma linha tem significado
-- por tenant (o mesmo event_id pode ter afetado KPIs de warehouses/clientes
-- diferentes); GLOBAL, sem RLS, mesmo padrão de wms.schema_migration.
-- wms_app não tem NENHUM privilégio (só o worker toca esta tabela) —
-- ALTER DEFAULT PRIVILEGES concede SELECT/INSERT/UPDATE por padrão.
REVOKE SELECT, INSERT, UPDATE ON wms.kpi_event_applied FROM wms_app;
GRANT SELECT, INSERT ON wms.kpi_event_applied TO wms_worker;

-- =============================================================================
-- 3. wms.alert + wms.alert_read (RD-PAI-003) — RF-PAI-010, §5.2
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.alert (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = alerta sem cliente natural (Edge Agent offline, falha de
  -- integração, cartão atrasado de tipo sem tenant claro no momento do
  -- alerta); NOT NULL = origem tem cliente (estoque de segurança, lote a
  -- vencer, exceção aguardando alçada, cartão atrasado de um pedido/ordem).
  tenant_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  source_entity TEXT,
  source_entity_id UUID,
  -- Dedup de alertas EVENT-DRIVEN (event_outbox.event_id da origem).
  source_event_id UUID,
  status TEXT NOT NULL DEFAULT 'EMITIDO',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT alert_severity_check CHECK (severity IN ('INFO', 'WARN', 'CRIT')),
  CONSTRAINT alert_status_check CHECK (status IN ('EMITIDO', 'RESOLVIDO')),
  CONSTRAINT alert_type_check CHECK (alert_type IN (
    'EXCECAO_AGUARDANDO', 'EDGE_AGENT_OFFLINE', 'ESTOQUE_SEGURANCA_VIOLADO',
    'LOTE_A_VENCER', 'LOTE_VENCIDO', 'CROSSDOCK_TEMPO_EXCEDIDO',
    'TRANSBORDO_PENDENTE', 'CARTAO_ATRASADO', 'FALHA_INTEGRACAO'
  ))
);

-- Dedup: no máximo 1 alerta EMITIDO por (tipo, origem) — reaberto só depois
-- de RESOLVIDO (§5.2: "RESOLVIDO quando o objeto de origem sai da condição").
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_open_dedup
  ON wms.alert (alert_type, source_entity, source_entity_id)
  WHERE status = 'EMITIDO';
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_event_dedup
  ON wms.alert (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alert_warehouse_status ON wms.alert (warehouse_id, status, created_at DESC);

ALTER TABLE wms.alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.alert FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_visibility ON wms.alert;
CREATE POLICY alert_visibility ON wms.alert
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  );

GRANT SELECT, INSERT, UPDATE ON wms.alert TO wms_app;
GRANT SELECT, INSERT, UPDATE ON wms.alert TO wms_worker;

CREATE TABLE IF NOT EXISTS wms.alert_read (
  alert_id UUID NOT NULL REFERENCES wms.alert(id) ON DELETE RESTRICT,
  -- Duplicado do alert pai para a policy RLS (mesmo padrão de flow_step
  -- duplicando tenant_id de operation_flow, migration 0034).
  tenant_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, user_id)
);

ALTER TABLE wms.alert_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.alert_read FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_read_visibility ON wms.alert_read;
CREATE POLICY alert_read_visibility ON wms.alert_read
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  );

-- Marcação de leitura é INSERT-only (uma linha por alert×user); sem UPDATE.
GRANT SELECT, INSERT ON wms.alert_read TO wms_app;
REVOKE UPDATE ON wms.alert_read FROM wms_app;

-- =============================================================================
-- 4. wms.chat_room + wms.chat_message (RD-PAI-004) — RF-PAI-030, RN-PAI-031
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.chat_room (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = sala armazém-turno (persistente, sem cliente). NOT NULL = sala
  -- de operação, "herda o tenant_id" do Fluxo Operacional (RF-PAI-030).
  tenant_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  room_type TEXT NOT NULL,
  -- Só para room_type = 'OPERACAO'.
  operation_flow_id UUID REFERENCES wms.operation_flow(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT chat_room_type_check CHECK (room_type IN ('ARMAZEM_TURNO', 'OPERACAO')),
  CONSTRAINT chat_room_operation_flow_required CHECK (
    (room_type = 'OPERACAO' AND operation_flow_id IS NOT NULL)
    OR (room_type = 'ARMAZEM_TURNO' AND operation_flow_id IS NULL)
  )
);

-- [LACUNA: DOC-10 não define catálogo de turnos — "armazém-turno" modelado
-- como 1 sala persistente por armazém, não 1 por turno/dia, na ausência de
-- um catálogo de turno em qualquer DOC já implementado.]
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_room_warehouse_shift
  ON wms.chat_room (warehouse_id) WHERE room_type = 'ARMAZEM_TURNO';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_room_operation
  ON wms.chat_room (operation_flow_id) WHERE room_type = 'OPERACAO';

ALTER TABLE wms.chat_room ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.chat_room FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_room_visibility ON wms.chat_room;
CREATE POLICY chat_room_visibility ON wms.chat_room
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  );

-- Salas não são editadas depois de criadas (sem campo mutável no MVP desta
-- sessão); sem UPDATE.
GRANT SELECT, INSERT ON wms.chat_room TO wms_app;
REVOKE UPDATE ON wms.chat_room FROM wms_app;

CREATE TABLE IF NOT EXISTS wms.chat_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES wms.chat_room(id) ON DELETE RESTRICT,
  -- Duplicados da sala para a policy RLS (mesmo padrão de flow_step).
  tenant_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  sender_user_id UUID NOT NULL,
  body TEXT NOT NULL,
  attachment_url TEXT,
  mentioned_user_ids UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT chat_message_body_length CHECK (char_length(body) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_room ON wms.chat_message (room_id, created_at);

ALTER TABLE wms.chat_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.chat_message FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_message_visibility ON wms.chat_message;
CREATE POLICY chat_message_visibility ON wms.chat_message
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  );

-- RF-PAI-030 "mensagens são ... imutáveis": append-only, mesmo padrão de
-- package_content/loading_scan (Sessão 6B) — REVOKE UPDATE explícito
-- (achado transversal do MARCO §2: ALTER DEFAULT PRIVILEGES concede UPDATE
-- por padrão a toda tabela nova).
GRANT SELECT, INSERT ON wms.chat_message TO wms_app;
REVOKE UPDATE ON wms.chat_message FROM wms_app;

-- =============================================================================
-- 4.5. OperationsBoardService (RF-PAI-001) lê operation_flow/flow_step/
-- inbound_order/outbound_order/client CROSS-CLIENT via transactionAsWorker
-- (o painel mostra vários clientes ao mesmo tempo no mesmo armazém — o
-- filtro RN-SEG-011 já foi aplicado em código antes da query, não é RLS
-- fazendo esse trabalho aqui). wms_worker nunca havia lido estas 4 tabelas
-- antes (achado igual ao das Sessões 5A/5B/5C, ver CLAUDE.md — GRANT
-- explícito por consumidor, sem exceção para o painel).
GRANT SELECT ON wms.operation_flow TO wms_worker;
GRANT SELECT ON wms.flow_step TO wms_worker;
GRANT SELECT ON wms.inbound_order TO wms_worker;
GRANT SELECT ON wms.client TO wms_worker;

-- =============================================================================
-- 5. wms.user_board_preference (RD-PAI-005, GLOBAL) — RF-PAI-002
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.user_board_preference (
  user_id UUID PRIMARY KEY REFERENCES wms.user(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GLOBAL, sem RLS (mesmo padrão de wms.user) — o serviço sempre filtra por
-- user_id = principal autenticado; nenhuma rota expõe leitura/escrita da
-- preferência de outro usuário.
GRANT SELECT, INSERT, UPDATE ON wms.user_board_preference TO wms_app;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (55, 'DOC-10: kpi_daily/kpi_event_applied, alert/alert_read, chat_room/chat_message, user_board_preference', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
