-- Migration: 0052
-- DOC-05 §4.7 (Sessão 5C) — Inventários: RF-EST-060 (tipos/escopo),
-- RN-EST-061 (congelamento), RN-EST-062 (rodadas), RN-EST-063 (ajuste com
-- alçada), RF-EST-064 (acuracidade). RD-EST-003 pede 3 tabelas
-- (inventory_count + inventory_count_location + inventory_count_round); a
-- 6B (migration 0051) já criou uma wms.inventory_count MÍNIMA (1 linha = 1
-- endereço) só para o gatilho automático do corte de picking, deixando
-- explícito que a execução real é desta sessão. Ver
-- docs/relatorios/SESSAO-5C-relatorio.md §"Decisão de modelagem" para a
-- justificativa completa do grão adotado abaixo.

-- =============================================================================
-- 1. A tabela da 6B vira a tabela de CÉLULAS (endereço × produto × lote) —
-- RD-EST-003 nomeia "inventory_count_location"; nenhum DROP, nenhuma perda
-- de dado (ambiente de teste recria o banco do zero a cada execução; não há
-- dado de produção a preservar).
-- =============================================================================
ALTER TABLE wms.inventory_count RENAME TO inventory_count_location;
ALTER POLICY inventory_count_tenant_isolation ON wms.inventory_count_location RENAME TO inventory_count_location_tenant_isolation;

-- =============================================================================
-- 2. Novo wms.inventory_count — CABEÇALHO/documento (RN-DAD-040, prefixo INV
-- já cadastrado em document-numbering.service.ts). Espelha a máquina de
-- estados do DOC-05 §5.1 (PLANNED -> IN_PROGRESS -> ADJUSTMENT_PENDING ->
-- COMPLETED; PLANNED -> CANCELLED).
-- =============================================================================
CREATE TABLE wms.inventory_count (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  document_number TEXT,
  count_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  -- RF-EST-060: parâmetros de escopo — só os relevantes ao count_type são
  -- preenchidos (ex.: scope_product_ids só para ROTATIVO_PRODUTO).
  scope_product_ids UUID[],
  scope_zone_ids UUID[],
  scope_species TEXT[],
  -- POR_SORTEIO — RN-EST-060/§6 "sorteio reprodutível": semente registrada.
  random_seed TEXT,
  -- EST.INV_INCLUI_VAZIOS (parâmetro, RD-EST-003 §7): GERAL inclui endereços
  -- sem saldo quando true.
  include_empty BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  -- RF-EST-064 — apurada e publicada (estoque.inventario_concluido) ao
  -- concluir; "por cliente" não ganha coluna própria porque o cabeçalho já é
  -- de um único tenant_id (ver decisão de modelagem) — accuracy_quantity É o
  -- número "por cliente" deste inventário.
  accuracy_location NUMERIC(5,4),
  accuracy_quantity NUMERIC(5,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT inventory_count_count_type_check CHECK (count_type IN (
    'GERAL', 'ROTATIVO_PRODUTO', 'ROTATIVO_DIA', 'POR_SORTEIO', 'POR_ZONA', 'POR_ESPECIE', 'POR_ENDERECO'
  )),
  CONSTRAINT inventory_count_status_check CHECK (status IN (
    'PLANNED', 'IN_PROGRESS', 'ADJUSTMENT_PENDING', 'COMPLETED', 'CANCELLED'
  ))
);

CREATE INDEX idx_inventory_count_tenant_warehouse ON wms.inventory_count (tenant_id, warehouse_id, status);

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

GRANT SELECT, INSERT, UPDATE ON wms.inventory_count TO wms_app;

-- =============================================================================
-- 3. wms.inventory_count_location (ex-inventory_count da 6B) — ALTER
-- aditivo: grão vira a CÉLULA contável (endereço × produto × lote), não só
-- o endereço (ver decisão de modelagem no relatório). product_id/batch_id
-- ficam NULL para células "verificar vazio" (EST.INV_INCLUI_VAZIOS).
-- =============================================================================
ALTER TABLE wms.inventory_count_location
  ADD COLUMN header_id UUID REFERENCES wms.inventory_count(id) ON DELETE RESTRICT,
  ADD COLUMN product_id UUID REFERENCES wms.product(id) ON DELETE RESTRICT,
  ADD COLUMN batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  -- RN-EST-062: saldo do sistema no momento do PLANEJAMENTO (o planejador já
  -- vê o volume antes de iniciar) — sempre a parcela AVAILABLE (ver decisão
  -- de modelagem: contagem/ajuste operam só sobre qty_available).
  ADD COLUMN system_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- RN-EST-063: "rejeição exige nova contagem (volta à 1ª rodada)" — as
  -- rodadas de um ciclo anterior ficam registradas (auditoria), mas deixam
  -- de contar para a decisão RN-EST-062 assim que o ciclo avança.
  ADD COLUMN cycle SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  ADD COLUMN frozen_at TIMESTAMPTZ,
  ADD COLUMN released_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ,
  ADD COLUMN updated_by UUID;

ALTER TABLE wms.inventory_count_location
  ADD CONSTRAINT inventory_count_location_status_check CHECK (status IN (
    'PENDING', 'COUNTING', 'ADJUSTMENT_PENDING', 'COMPLETED'
  ));

CREATE INDEX idx_inventory_count_location_header ON wms.inventory_count_location (header_id);
CREATE INDEX idx_inventory_count_location_cell ON wms.inventory_count_location (location_id, product_id, batch_id, status);

-- [DEBITO: 5C] fechado — a 6B reteve o UPDATE de propósito (só CRIAVA o
-- documento); a execução (congelar/contar/liberar) precisa de UPDATE real.
GRANT UPDATE ON wms.inventory_count_location TO wms_app;

-- =============================================================================
-- 4. wms.inventory_count_round (nova) — RN-EST-062 [INVIOLÁVEL]: "todas as
-- contagens são registradas". Append-only (nenhuma rodada é corrigida
-- depois de registrada).
-- =============================================================================
CREATE TABLE wms.inventory_count_round (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  count_location_id UUID NOT NULL REFERENCES wms.inventory_count_location(id) ON DELETE RESTRICT,
  round_number SMALLINT NOT NULL,
  cycle SMALLINT NOT NULL DEFAULT 1,
  counted_qty NUMERIC(18,6) NOT NULL,
  counted_by UUID NOT NULL,
  -- RN-EST-062: "1ª contagem cega (sem exibir saldo do sistema)" — a 2ª
  -- rodada também é cega (operador diferente); a 3ª (LIDER_TURNO) decide por
  -- prevalência, não por cegueira, mas nada no texto exige exibir o sistema
  -- a ela — mantém-se cega pelas 3, TRUE é o valor real em toda rodada
  -- registrada nesta sessão.
  is_blind BOOLEAN NOT NULL DEFAULT TRUE,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT inventory_count_round_number_check CHECK (round_number IN (1, 2, 3)),
  CONSTRAINT inventory_count_round_qty_check CHECK (counted_qty >= 0)
);

CREATE INDEX idx_inventory_count_round_cell ON wms.inventory_count_round (count_location_id, cycle, round_number);

ALTER TABLE wms.inventory_count_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inventory_count_round FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_count_round_tenant_isolation ON wms.inventory_count_round;
CREATE POLICY inventory_count_round_tenant_isolation ON wms.inventory_count_round
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.inventory_count_round TO wms_app;
-- Achado transversal do MARCO §2: ALTER DEFAULT PRIVILEGES (migration 0010)
-- concede UPDATE por padrão a toda tabela nova — append-only precisa de
-- REVOKE explícito (mesmo padrão de package_content/loading_scan, 6B).
REVOKE UPDATE ON wms.inventory_count_round FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (52, 'DOC-05 5C: inventory_count (cabecalho) + inventory_count_location (celula, ex-6B) + inventory_count_round (RF-EST-060..064)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
