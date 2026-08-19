-- Migration: 0051
-- DOC-06 §4.4-§4.7 — Sessão 6B: Picking, Packing, Pesagem, Expedição
-- documental, Carregamento e Saída. RD-EXP-004 (picking_task, particionada
-- como task), RD-EXP-005 (package + package_content), RD-EXP-006 (loading +
-- loading_scan, com loading_order como estrutural companion — mesmo padrão
-- de wave_order na 6A: RD-EXP-003 só nomeia "wave", mas a ordem de entrada
-- exigiu uma tabela de vínculo própria; aqui loading precisa da mesma coisa
-- para saber QUAIS pedidos pertencem à carga antes de qualquer leitura).
--
-- DECISÃO — wms.package NÃO referencia wms.pallet: o §2 do DOC-06 diz que o
-- Volume é "identificado por LPN próprio (pallet_type = VOLUME ou palete)".
-- Lido como: o Volume usa o MESMO mecanismo de geração de LPN de wms.pallet
-- (RN-DAD-030, LpnService, mesma sequência wms.document_sequence 'LPN') —
-- não como exigência de criar uma linha em wms.pallet. wms.pallet.status
-- (IN_RECEIVING/STORED/...) não cobre o ciclo de vida do packing/pesagem/
-- carregamento, e RD-EXP-005 já pede uma estrutura própria com colunas que
-- pallet não tem (tara, pesos teórico/lido, sequência n/N). wms.package.lpn
-- reaproveita a MESMA sequência global de LPN (sem colisão possível).
--
-- DECISÃO — nenhuma movimentação de saldo ocorre no PICKING: RF-EXP-061 diz
-- literalmente "a conclusão [do CARREGAMENTO] efetiva a movimentação
-- SAIDA_EXPEDICAO (baixa definitiva do saldo físico)". O catálogo fechado de
-- RN-EST-001 (migration 0045) também define 'PICKING' (reserved -> null) e
-- 'SAIDA_EXPEDICAO' (reserved -> null) com o MESMO efeito de bucket — usar os
-- dois debitaria a mesma reserva duas vezes. Adotado: a reserva persiste
-- intacta (RESERVED) do zero até o carregamento; picking/packing/pesagem só
-- movimentam as estruturas PRÓPRIAS (picking_task/package/package_content); a
-- ÚNICA baixa de wms.stock_balance do ciclo de saída acontece em
-- RF-EXP-061, via SAIDA_EXPEDICAO, lendo as linhas de wms.stock_reservation
-- originais. 'PICKING' (movement_type) permanece no catálogo fechado sem uso
-- nesta sessão — não é removido (RN-EST-001 é fechado, não podado).

-- =============================================================================
-- 1. Permissão EXP.PESO_MANUAL — [LACUNA da 6A fechada aqui]: citada em
-- §4.5/§4.6 mas ausente do catálogo de permissões do §3. Usada tanto na
-- pesagem por volume (RF-EXP-050) quanto na pesagem de produto
-- is_weight_variable durante o picking (RF-EXP-031, que fala em "permissão
-- EST.DIGITACAO_LPN equivalente" — lido como "o equivalente conceitual
-- desta sessão", isto é, a MESMA EXP.PESO_MANUAL, não uma permissão nova).
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('EXP.PESO_MANUAL', 'WAREHOUSE', 'Digitacao manual de peso quando balanca indisponivel (DOC-06 RF-EXP-031/050)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- "Conferente de Expedição: Pesagem" já tem EXP.PESAGEM_EXECUTAR (6A); aqui
-- estende a quem efetivamente pesa/pica: Conferente, Operador de Picking
-- (RF-EXP-031) e Líder de Turno (supervisão).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EXP.PESO_MANUAL')) AS p(code)
WHERE r.code IN ('CONFERENTE', 'OPERADOR_PICKING', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. Parâmetro EXP.TOLERANCIA_PESO_PCT — DOC-06 §7/RN-EXP-051 (padrão 2).
-- Guardado como NÚMERO INTEIRO de percentual (2 = 2%), não fração — mesma
-- convenção de legibilidade de EXP.ONDA_MAX_PEDIDOS (200, não 0.2).
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value)
SELECT 'GLOBAL', 'EXP.TOLERANCIA_PESO_PCT', '2'
WHERE NOT EXISTS (SELECT 1 FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.TOLERANCIA_PESO_PCT');

-- =============================================================================
-- 3. wms.package_type — DOC-06 §4.5/§7 "catálogo EXP.EMBALAGENS_VOLUME com
-- tara". [LACUNA: §7 lista EXP.EMBALAGENS_VOLUME entre os parâmetros
-- escalares, mas §4.5 descreve como CATÁLOGO com tara — modelado como
-- catálogo GLOBAL, mesmo padrão de wms.stock_block_reason (migration 0044:
-- code TEXT PK, sem tenant_id), não como app_parameter escalar. Seeds
-- mínimos abaixo não são normativos exceto CAIXA_PADRAO (tara 0,350 kg
-- casa com o exemplo normativo de RN-EXP-051, §4.6).]
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.package_type (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  tare_kg NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  CONSTRAINT package_type_tare_check CHECK (tare_kg >= 0)
);

GRANT SELECT, INSERT, UPDATE ON wms.package_type TO wms_app;

INSERT INTO wms.package_type (code, description, tare_kg, created_by) VALUES
  ('CAIXA_PADRAO',    'Caixa de papelao padrao (exemplo normativo RN-EXP-051)', 0.350,  '00000000-0000-0000-0000-000000000001'),
  ('PALETE_FECHADO',  'Palete fechado (envolvido/filmado)',                     25.000, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 4. RD-EXP-004 — wms.picking_task (TENANT, RLS), particionada mensalmente
-- como `task` (RNF-ARQ-090, mesmo padrão de wms.putaway_task, migration 0039).
--
-- §5.2: CREATED -> ASSIGNED -> IN_EXECUTION -> DONE; ramos SHORT_REPORTED
-- (-> decisão RN-EXP-032 -> DONE parcial ou nova tarefa), CANCELLED, REVERSED
-- (estorno, RN-EXP-070).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.picking_task (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  outbound_order_id UUID NOT NULL REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  outbound_order_item_id UUID NOT NULL REFERENCES wms.outbound_order_item(id) ON DELETE RESTRICT,
  stock_reservation_id UUID NOT NULL REFERENCES wms.stock_reservation(id) ON DELETE RESTRICT,
  wave_id UUID REFERENCES wms.wave(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  location_id_from UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id_from UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  -- RF-EXP-031: "destino = posição de consolidação da onda/pedido em zona PACKING".
  location_id_to UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  -- RF-EXP-030: sequenciamento da rota (zona -> rua serpenteando -> módulo -> nível),
  -- calculado por picking-route.util.ts na geração.
  route_sequence INT NOT NULL,
  qty_suggested NUMERIC(18,6) NOT NULL,
  qty_confirmed NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_short NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- "quantidade != sugerida exige selecao de motivo" (RF-EXP-031).
  reason_code TEXT,
  reason_text TEXT,
  -- RF-EXP-031: produto is_weight_variable exige pesagem por unidade/volume.
  weight_kg NUMERIC(12,3),
  weight_source TEXT,
  -- RF-EXP-031: "idempotente por operation_id para offline" — a execução
  -- repete a mesma operation_id sem reaplicar o efeito (ver PickingTaskService.execute).
  last_operation_id UUID,
  -- RN-EXP-032: exceção EXP.CORTE_PICKING aberta por ESTA tarefa (distinto do
  -- vínculo único em flow_step.blocking_exception_id, que só guarda a ÚLTIMA
  -- exceção vinculada à etapa — a tarefa precisa saber qual é A SUA).
  short_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  assigned_to_user_id UUID,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  PRIMARY KEY (id, created_at),
  CONSTRAINT picking_task_status_check CHECK (status IN (
    'CREATED', 'ASSIGNED', 'IN_EXECUTION', 'DONE', 'SHORT_REPORTED', 'CANCELLED', 'REVERSED'
  )),
  CONSTRAINT picking_task_weight_source_check CHECK (weight_source IS NULL OR weight_source IN ('SCALE', 'MANUAL')),
  CONSTRAINT picking_task_qty_check CHECK (qty_suggested > 0 AND qty_confirmed >= 0 AND qty_short >= 0)
) PARTITION BY RANGE (created_at);

CREATE OR REPLACE FUNCTION wms.ensure_picking_task_partition(p_year INT, p_month INT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
DECLARE
  v_partition_name TEXT;
  v_start DATE;
  v_end DATE;
BEGIN
  v_partition_name := format('picking_task_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.picking_task FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wms.%I TO wms_app', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_picking_task_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_picking_task_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

CREATE INDEX IF NOT EXISTS idx_picking_task_warehouse_status ON wms.picking_task (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_picking_task_order ON wms.picking_task (outbound_order_id);
CREATE INDEX IF NOT EXISTS idx_picking_task_item ON wms.picking_task (outbound_order_item_id);
CREATE INDEX IF NOT EXISTS idx_picking_task_reservation ON wms.picking_task (stock_reservation_id);

ALTER TABLE wms.picking_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.picking_task FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS picking_task_tenant_isolation ON wms.picking_task;
CREATE POLICY picking_task_tenant_isolation ON wms.picking_task
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.picking_task TO wms_app;

-- =============================================================================
-- 5. RD-EXP-005 — wms.package (Volume) + wms.package_content.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.package (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  outbound_order_id UUID NOT NULL REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  lpn TEXT NOT NULL,
  package_type_code TEXT NOT NULL REFERENCES wms.package_type(code) ON DELETE RESTRICT,
  tare_kg NUMERIC(12,3) NOT NULL,
  -- "sequência do volume n/N" (§4.5) — N (total) é derivado por COUNT(*) na
  -- leitura (evita coluna redundante que ficaria desatualizada a cada novo
  -- volume do mesmo pedido); n (sequence_number) é atribuído na criação.
  sequence_number INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  theoretical_weight_kg NUMERIC(12,3),
  actual_weight_kg NUMERIC(12,3),
  weight_source TEXT,
  weight_reason_text TEXT,
  weighed_at TIMESTAMPTZ,
  weight_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  -- RF-EXP-060: leitura de conferência na consolidação em staging DISPATCH.
  staged_at TIMESTAMPTZ,
  loaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  closed_at TIMESTAMPTZ,
  CONSTRAINT package_lpn_unique UNIQUE (lpn),
  CONSTRAINT package_lpn_format CHECK (lpn ~ '^[0-9]{18}$'),
  CONSTRAINT package_order_sequence_unique UNIQUE (outbound_order_id, sequence_number),
  -- §5.2 não define sub-máquina de package: [LACUNA] modelada por esta
  -- sessão a partir dos efeitos que §4.5/§4.6/§4.7/§4.8 exigem.
  CONSTRAINT package_status_check CHECK (status IN (
    'OPEN', 'CLOSED', 'WEIGHED', 'WEIGHT_DIVERGENT', 'LOADED', 'CANCELLED'
  )),
  CONSTRAINT package_weight_source_check CHECK (weight_source IS NULL OR weight_source IN ('SCALE', 'MANUAL'))
);

CREATE INDEX IF NOT EXISTS idx_package_order ON wms.package (outbound_order_id, status);

ALTER TABLE wms.package ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.package FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS package_tenant_isolation ON wms.package;
CREATE POLICY package_tenant_isolation ON wms.package
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.package TO wms_app;

CREATE TABLE IF NOT EXISTS wms.package_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  package_id UUID NOT NULL REFERENCES wms.package(id) ON DELETE RESTRICT,
  outbound_order_item_id UUID NOT NULL REFERENCES wms.outbound_order_item(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT package_content_qty_check CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_package_content_package ON wms.package_content (package_id);
CREATE INDEX IF NOT EXISTS idx_package_content_item ON wms.package_content (outbound_order_item_id);

ALTER TABLE wms.package_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.package_content FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS package_content_tenant_isolation ON wms.package_content;
CREATE POLICY package_content_tenant_isolation ON wms.package_content
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

-- UPDATE não é concedido por design (conteúdo declarado é imutável — uma
-- correção desfaz o VOLUME inteiro via estorno §4.8, não edita a linha).
-- ALTER DEFAULT PRIVILEGES (migration 0010) concede UPDATE por padrão a toda
-- tabela nova — precisa ser revogado explicitamente para valer SI de fato.
GRANT SELECT, INSERT ON wms.package_content TO wms_app;
REVOKE UPDATE ON wms.package_content FROM wms_app;

-- =============================================================================
-- 6. RD-EXP-006 — wms.loading + wms.loading_order (estrutural, ver
-- cabeçalho) + wms.loading_scan.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.loading (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- RF-EXP-061: "com veículo EM_DOCA vinculado". Sem FK direta de tipo (DOC-03
  -- vehicle_visit é DE TENANT, mesmo padrão de outbound_order.appointment_id).
  vehicle_visit_id UUID REFERENCES wms.vehicle_visit(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT loading_status_check CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_loading_warehouse_status ON wms.loading (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_loading_vehicle_visit ON wms.loading (vehicle_visit_id);

ALTER TABLE wms.loading ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.loading FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loading_tenant_isolation ON wms.loading;
CREATE POLICY loading_tenant_isolation ON wms.loading
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.loading TO wms_app;

CREATE TABLE IF NOT EXISTS wms.loading_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  loading_id UUID NOT NULL REFERENCES wms.loading(id) ON DELETE RESTRICT,
  outbound_order_id UUID NOT NULL REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
  -- Sem UNIQUE(outbound_order_id): diferente de wave_order (um pedido só
  -- entra em UMA onda, ponto final), um pedido PODE precisar de uma NOVA
  -- loading depois de um estorno de carregamento (RN-EXP-070) — a
  -- exclusividade "só uma loading ABERTA por pedido" é validada na app
  -- (LoadingService.open), não no banco.
);

CREATE INDEX IF NOT EXISTS idx_loading_order_loading ON wms.loading_order (loading_id);
CREATE INDEX IF NOT EXISTS idx_loading_order_order ON wms.loading_order (outbound_order_id);

ALTER TABLE wms.loading_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.loading_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loading_order_tenant_isolation ON wms.loading_order;
CREATE POLICY loading_order_tenant_isolation ON wms.loading_order
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.loading_order TO wms_app;
REVOKE UPDATE ON wms.loading_order FROM wms_app;

CREATE TABLE IF NOT EXISTS wms.loading_scan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  loading_id UUID NOT NULL REFERENCES wms.loading(id) ON DELETE RESTRICT,
  package_id UUID REFERENCES wms.package(id) ON DELETE RESTRICT,
  outbound_order_id UUID REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  scanned_lpn TEXT NOT NULL,
  result TEXT NOT NULL,
  rejection_detail TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by UUID NOT NULL,
  CONSTRAINT loading_scan_result_check CHECK (result IN ('ACCEPTED', 'REJECTED_FOREIGN', 'REJECTED_UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_loading_scan_loading ON wms.loading_scan (loading_id);

ALTER TABLE wms.loading_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.loading_scan FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loading_scan_tenant_isolation ON wms.loading_scan;
CREATE POLICY loading_scan_tenant_isolation ON wms.loading_scan
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.loading_scan TO wms_app;
REVOKE UPDATE ON wms.loading_scan FROM wms_app;

-- =============================================================================
-- 7. wms.inventory_count — RN-EXP-032(b): "cria inventário POR_ENDERECO
-- automático" para o endereço divergente. [DEBITO: 5C executa] — esta sessão
-- cria apenas o DOCUMENTO (cabeçalho); a EXECUÇÃO da contagem é da Sessão 5C,
-- fora de escopo aqui (ver FORA DE ESCOPO do prompt). [LACUNA: DOC-05 não
-- modela esta estrutura (RD-EST-* não a lista) — modelagem mínima desta
-- sessão, restrita ao único tipo/status que RN-EXP-032 exige; a 5C estende
-- (ALTER) quando implementar a execução, sem quebrar o que existe aqui.]
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.inventory_count (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  count_type TEXT NOT NULL DEFAULT 'POR_ENDERECO',
  location_id UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  trigger_ref_type TEXT,
  trigger_ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_count_location ON wms.inventory_count (location_id, status);

ALTER TABLE wms.inventory_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inventory_count FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_count_tenant_isolation ON wms.inventory_count;
CREATE POLICY inventory_count_tenant_isolation ON wms.inventory_count
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.inventory_count TO wms_app;
-- [DEBITO: 5C] SEM UPDATE nesta sessão — 6B só CRIA o documento; a execução
-- da contagem (5C) precisará conceder UPDATE quando implementar.
REVOKE UPDATE ON wms.inventory_count FROM wms_app;

-- =============================================================================
-- 8. wms.outbound_order — colunas ADITIVAS para o gatilho fiscal do
-- RF-EXP-060. RD-EXP-007 (fiscal_allocation) é do DOC-08 (prompt: "implemente
-- o ponto de integração"); aqui só o mínimo para o caminho INTEGRADO_ERP
-- (confirmação manual) e para expor a rejeição fiscal (Gherkin §6: "a etapa
-- deve estar vermelha exibindo o código e a mensagem de rejeição").
-- =============================================================================
ALTER TABLE wms.outbound_order ADD COLUMN IF NOT EXISTS fiscal_documents_authorized_at TIMESTAMPTZ;
ALTER TABLE wms.outbound_order ADD COLUMN IF NOT EXISTS fiscal_rejection_detail TEXT;

-- =============================================================================
-- 9. Grants wms_worker: nenhum job cross-tenant novo nesta sessão toca as
-- tabelas acima — nenhuma entrada abaixo concede a wms_worker (least privilege,
-- ADR-006). Ver core/database/__tests__/grants-contract.integration.spec.ts.
-- =============================================================================

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (51, 'DOC-06 6B: EXP.PESO_MANUAL, EXP.TOLERANCIA_PESO_PCT, package_type, picking_task (particionada), package(_content), loading(_order/_scan), inventory_count, colunas fiscais em outbound_order', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
