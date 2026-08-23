-- Migration: 0068
-- DOC-15 (Sessão COL-2A) — motor offline: enum normativo da sync_operation
-- (DOC-01 §5.2), idempotência de operationId em checking/stock_transfer/
-- inventory_count (RG-009), COL.PACOTE_TURNO_MAX (RF-ARQ-051),
-- exception_type da Divergência de sincronização (AD-007, decisão 4 da
-- RN-ARQ-053) e alert_type do dispositivo offline com fila pendente
-- (RNF-COL-051).

-- =============================================================================
-- 1. wms.sync_operation_status -> nomes normativos do DOC-01 §5.2
-- (LOCAL_PENDENTE/ENVIANDO/APLICADA/DESCARTADA_DUPLICIDADE/
-- REJEITADA_TAREFA_INVALIDA/REJEITADA_REGRA). DECISÃO (ver relatório): migrar
-- para os nomes normativos em vez de manter PENDING/IN_PROGRESS/SYNCED/
-- CONFLICT/FAILED/EXPIRED com uma tabela de mapeamento — evita uma tradução
-- implícita "o que o banco diz" x "o que a especificação diz" em todo
-- consumidor futuro (CLAUDE.md: máquinas de estado explícitas, fiéis à
-- especificação). Não há dado real hoje (migration 0006 comentava "sem
-- produtor até a Sessão PWA" — COL-2A é o primeiro produtor real), mas a
-- migração de dados abaixo é escrita corretamente mesmo assim (USING com
-- CASE), não presumindo tabela vazia. EXPIRED (TTL de 7 dias, sem
-- correspondente na máquina normativa) é absorvido em REJEITADA_TAREFA_
-- INVALIDA (mesma família semântica: operação que não pode mais ser
-- aplicada, vira pendência de supervisão).
ALTER TYPE wms.sync_operation_status RENAME TO sync_operation_status_old;

CREATE TYPE wms.sync_operation_status AS ENUM (
  'LOCAL_PENDENTE', 'ENVIANDO', 'APLICADA',
  'DESCARTADA_DUPLICIDADE', 'REJEITADA_TAREFA_INVALIDA', 'REJEITADA_REGRA'
);

-- Os 2 índices parciais da migration 0006 têm predicado WHERE com literais
-- do enum ANTIGO ('PENDING'/'CONFLICT'/...) — precisam ser derrubados ANTES
-- do ALTER COLUMN ... TYPE abaixo. Deixá-los para depois (ordem originalmente
-- tentada nesta sessão) falha em runtime com "operator does not exist:
-- sync_operation_status = sync_operation_status_old": o rewrite de ALTER
-- COLUMN TYPE precisa reconciliar o predicado do índice dependente com o
-- tipo NOVO da coluna, e o literal do predicado ainda está ligado ao OID do
-- tipo velho (renomeado, não convertido) — não há cast implícito entre dois
-- enums distintos. Confirmado batendo a migration contra o Postgres de teste
-- (ver docs/relatorios da sessão).
DROP INDEX IF EXISTS wms.idx_sync_operation_pending;
DROP INDEX IF EXISTS wms.idx_sync_operation_expired;

ALTER TABLE wms.sync_operation ALTER COLUMN status DROP DEFAULT;
ALTER TABLE wms.sync_operation
  ALTER COLUMN status TYPE wms.sync_operation_status
  USING (
    CASE status::text
      WHEN 'PENDING' THEN 'LOCAL_PENDENTE'
      WHEN 'IN_PROGRESS' THEN 'ENVIANDO'
      WHEN 'SYNCED' THEN 'APLICADA'
      WHEN 'CONFLICT' THEN 'DESCARTADA_DUPLICIDADE'
      WHEN 'FAILED' THEN 'REJEITADA_TAREFA_INVALIDA'
      WHEN 'EXPIRED' THEN 'REJEITADA_TAREFA_INVALIDA'
    END
  )::wms.sync_operation_status;
ALTER TABLE wms.sync_operation ALTER COLUMN status SET DEFAULT 'LOCAL_PENDENTE';

DROP TYPE wms.sync_operation_status_old;

-- Recria os índices agora que a coluna já está no enum novo (os literais do
-- predicado abaixo só são válidos depois do ALTER COLUMN TYPE acima).
CREATE INDEX IF NOT EXISTS idx_sync_operation_pending
  ON wms.sync_operation (tenant_id, status, created_at)
  WHERE status IN ('LOCAL_PENDENTE', 'ENVIANDO');

CREATE INDEX IF NOT EXISTS idx_sync_operation_expired
  ON wms.sync_operation (expires_at)
  WHERE status NOT IN ('APLICADA', 'DESCARTADA_DUPLICIDADE');

-- =============================================================================
-- 2. Idempotência por operationId (RNF-ARQ-050/RG-009) em CheckingService
-- (T4: countFirstRound/recount), StockTransferService (T6: transferInternal)
-- e InventoryCountExecutionService.submitRound (T5). Mesmo desenho de
-- wms.putaway_operation/wms.replenishment_operation (migrations 0043/0047):
-- tabela PRÓPRIA por serviço, operation_id UNIQUE (PK), result JSONB com a
-- resposta original devolvida tal e qual em todo reenvio. checking_item/
-- stock_transfer/inventory_count_round NÃO são particionadas (diferente de
-- putaway_task/replenishment_task) — mesmo assim optou-se pela tabela
-- própria, e não por uma coluna operation_id nessas tabelas de domínio, por
-- uniformidade com o padrão já estabelecido e testado (CLAUDE.md: "herde
-- padrões, não reinvente") e porque replay precisa devolver a MESMA resposta
-- computada (item + divergência / task / resultado da rodada), não só
-- detectar "já existe".
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.checking_operation (
  operation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  inbound_order_item_id UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checking_operation_item ON wms.checking_operation (inbound_order_item_id);
ALTER TABLE wms.checking_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.checking_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checking_operation_tenant_isolation ON wms.checking_operation;
CREATE POLICY checking_operation_tenant_isolation ON wms.checking_operation
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  WITH CHECK (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID);
GRANT SELECT, INSERT ON wms.checking_operation TO wms_app;

CREATE TABLE IF NOT EXISTS wms.stock_transfer_operation (
  operation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  stock_transfer_id UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_operation_transfer ON wms.stock_transfer_operation (stock_transfer_id);
ALTER TABLE wms.stock_transfer_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_transfer_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_transfer_operation_tenant_isolation ON wms.stock_transfer_operation;
CREATE POLICY stock_transfer_operation_tenant_isolation ON wms.stock_transfer_operation
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  WITH CHECK (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID);
GRANT SELECT, INSERT ON wms.stock_transfer_operation TO wms_app;

CREATE TABLE IF NOT EXISTS wms.inventory_count_operation (
  operation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  count_location_id UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_count_operation_cell ON wms.inventory_count_operation (count_location_id);
ALTER TABLE wms.inventory_count_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inventory_count_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_count_operation_tenant_isolation ON wms.inventory_count_operation;
CREATE POLICY inventory_count_operation_tenant_isolation ON wms.inventory_count_operation
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
  WITH CHECK (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID);
GRANT SELECT, INSERT ON wms.inventory_count_operation TO wms_app;

-- =============================================================================
-- 2b. RNF-COL-051 — telemetria mínima: "tamanho da fila, falhas de leitura
-- por origem (físico/câmera)" além de bateria/last_sync_at (já existentes,
-- migration 0066). Usado pelo job de alerta (dispositivo sem contato > 24h
-- com fila > 0, ver worker desta sessão).
-- =============================================================================
ALTER TABLE wms.field_device ADD COLUMN IF NOT EXISTS queue_size INT;
ALTER TABLE wms.field_device ADD COLUMN IF NOT EXISTS read_failures_physical INT NOT NULL DEFAULT 0;
ALTER TABLE wms.field_device ADD COLUMN IF NOT EXISTS read_failures_camera INT NOT NULL DEFAULT 0;

-- =============================================================================
-- 3. COL.PACOTE_TURNO_MAX (RF-ARQ-051: "máx. 2.000 tarefas").
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'COL.PACOTE_TURNO_MAX', '2000')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 4. Divergência de sincronização offline (RN-ARQ-053 decisão 4, AD-007) —
-- exception_type novo, mesmo catálogo genérico já usado por EST.AJUSTE_
-- INVENTARIO/REC.DIVERGENCIA_*. Sem approval_authority pré-configurada:
-- ApprovalAuthorityService.exceedsAllConfiguredAuthorities() já trata "nenhuma
-- alçada configurada" como escalada automática (ESCALATED, decide por
-- GESTOR_ARMAZEM) — comportamento seguro por padrão, mesmo caminho de
-- qualquer exception_type novo sem alçada seedada nesta base.
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('COL.SINCRONIZACAO_REJEITADA', 'Operacao offline rejeitada por violacao de regra (RN-ARQ-053 decisao 4)', 1, TRUE, 48, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 5. Alerta de dispositivo sem contato com fila pendente (RNF-COL-051).
-- =============================================================================
ALTER TABLE wms.alert DROP CONSTRAINT IF EXISTS alert_type_check;
ALTER TABLE wms.alert ADD CONSTRAINT alert_type_check CHECK (alert_type IN (
  'EXCECAO_AGUARDANDO', 'EDGE_AGENT_OFFLINE', 'ESTOQUE_SEGURANCA_VIOLADO',
  'LOTE_A_VENCER', 'LOTE_VENCIDO', 'CROSSDOCK_TEMPO_EXCEDIDO',
  'TRANSBORDO_PENDENTE', 'CARTAO_ATRASADO', 'FALHA_INTEGRACAO',
  'DISPOSITIVO_CAMPO_OFFLINE'
));

-- =============================================================================
-- 6. Grants por consumidor real desta sessão (ADR-006 — não especulativo).
-- ShiftPackageService agrega tarefas de campo por operador cross-tenant
-- (mesmo raciocínio de MyTasksService, RN-SEG-011) via transactionAsWorker —
-- primeiras leituras reais de checking/checking_item/stock_transfer/
-- stock_transfer_item/inventory_count_location por wms_worker. wms.
-- inbound_order_item/wms.picking_task/wms.inventory_count JÁ têm SELECT
-- concedido a wms_worker (DOC-10 K-04/K-15/K-12) — não repetido aqui.
-- =============================================================================
GRANT SELECT ON wms.checking TO wms_worker;
GRANT SELECT ON wms.checking_item TO wms_worker;
GRANT SELECT ON wms.stock_transfer TO wms_worker;
GRANT SELECT ON wms.stock_transfer_item TO wms_worker;
GRANT SELECT ON wms.inventory_count_location TO wms_worker;
-- FieldDeviceService.checkOfflineWithPendingQueue() (RNF-COL-051, worker
-- desta sessão) varre wms.field_device inteiro, cross-armazém, via
-- transactionAsWorker.
GRANT SELECT ON wms.field_device TO wms_worker;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (68, 'DOC-15 COL-2A: enum normativo sync_operation (DOC-01 SS5.2), idempotencia checking/stock_transfer/inventory_count, COL.PACOTE_TURNO_MAX, exception_type COL.SINCRONIZACAO_REJEITADA, alert_type DISPOSITIVO_CAMPO_OFFLINE, grants wms_worker', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
