-- Migration: 0011
-- DOC-02 §5.3 — Catalogo de produtos.
-- product_species (GLOBAL, RN-DAD-004) + commercial_category, product,
-- product_packaging, product_barcode, product_warehouse_parameter (DE
-- TENANT, RN-DAD-004: tenant_id = client.id, RLS obrigatorio).
-- Ordem de criacao: product_species -> commercial_category -> product ->
-- product_packaging -> product_barcode (referencia packaging_id) ->
-- product_warehouse_parameter.

-- =============================================================================
-- product_species — DOC-02 §5.3
-- Lista fechada, extensivel apenas por versao do documento. Valores e flags
-- inseridos AQUI (dado definitorio do documento, nao e seed de exemplo).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.product_species (
  code TEXT PRIMARY KEY,
  requires_batch BOOLEAN NOT NULL,
  requires_expiration BOOLEAN NOT NULL,
  default_giro_policy TEXT NOT NULL,
  segregation_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT product_species_code_check CHECK (code IN (
    'GERAL', 'MEDICAMENTO', 'ALIMENTO', 'INFLAMAVEL', 'COMBUSTIVEL',
    'QUIMICO_CONTROLADO', 'REFRIGERADO', 'CONGELADO', 'FRAGIL', 'VALIOSO'
  )),
  CONSTRAINT product_species_giro_policy_check CHECK (default_giro_policy IN ('FEFO', 'FIFO', 'LIFO', 'JIT'))
);

GRANT SELECT, INSERT, UPDATE ON wms.product_species TO wms_app;

-- Valores iniciais obrigatorios do DOC-02 §5.3:
-- MEDICAMENTO, ALIMENTO, REFRIGERADO, CONGELADO => requires_batch=true,
-- requires_expiration=true, giro FEFO.
-- INFLAMAVEL, COMBUSTIVEL, QUIMICO_CONTROLADO => requires_batch=true
-- (requires_expiration/giro NAO especificados pelo documento para estes 3).
-- GERAL, FRAGIL, VALIOSO: nao mencionados na lista obrigatoria -> inferido
-- requires_batch=false, requires_expiration=false (ausencia de mencao =
-- sem exigencia regulatoria declarada).
-- [LACUNA: DOC-02 nao define default_giro_policy para INFLAMAVEL,
-- COMBUSTIVEL, QUIMICO_CONTROLADO, GERAL, FRAGIL, VALIOSO -- usando FIFO
-- como default neutro (nao exige ordenacao por validade) ate DOC-05
-- definir politica especifica.]
-- [LACUNA: DOC-02 nao define os valores de segregation_class (a matriz de
-- compatibilidade e do DOC-05/LAC-003, fora do escopo desta sessao) --
-- usando o proprio `code` como segregation_class provisorio (cada especie
-- na sua propria classe, sem compatibilidade cruzada assumida) ate o
-- DOC-05 definir a matriz real.]
INSERT INTO wms.product_species (code, requires_batch, requires_expiration, default_giro_policy, segregation_class, created_by) VALUES
  ('GERAL',               FALSE, FALSE, 'FIFO', 'GERAL',               '00000000-0000-0000-0000-000000000001'),
  ('MEDICAMENTO',         TRUE,  TRUE,  'FEFO', 'MEDICAMENTO',         '00000000-0000-0000-0000-000000000001'),
  ('ALIMENTO',            TRUE,  TRUE,  'FEFO', 'ALIMENTO',            '00000000-0000-0000-0000-000000000001'),
  ('INFLAMAVEL',          TRUE,  FALSE, 'FIFO', 'INFLAMAVEL',          '00000000-0000-0000-0000-000000000001'),
  ('COMBUSTIVEL',         TRUE,  FALSE, 'FIFO', 'COMBUSTIVEL',         '00000000-0000-0000-0000-000000000001'),
  ('QUIMICO_CONTROLADO',  TRUE,  FALSE, 'FIFO', 'QUIMICO_CONTROLADO',  '00000000-0000-0000-0000-000000000001'),
  ('REFRIGERADO',         TRUE,  TRUE,  'FEFO', 'REFRIGERADO',         '00000000-0000-0000-0000-000000000001'),
  ('CONGELADO',           TRUE,  TRUE,  'FEFO', 'CONGELADO',           '00000000-0000-0000-0000-000000000001'),
  ('FRAGIL',              FALSE, FALSE, 'FIFO', 'FRAGIL',              '00000000-0000-0000-0000-000000000001'),
  ('VALIOSO',             FALSE, FALSE, 'FIFO', 'VALIOSO',             '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- commercial_category — DOC-02 §5.3 (DE TENANT)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.commercial_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES wms.commercial_category(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT commercial_category_tenant_code_unique UNIQUE (tenant_id, code)
);

ALTER TABLE wms.commercial_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.commercial_category FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commercial_category_tenant_isolation ON wms.commercial_category;
CREATE POLICY commercial_category_tenant_isolation ON wms.commercial_category
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.commercial_category TO wms_app;

-- =============================================================================
-- product — DOC-02 §5.3 (DE TENANT); UNIQUE(tenant_id, sku); sku imutavel
-- (RF-DAD-050); species_code imutavel com saldo > 0 (RN-DAD-020 — trigger
-- adicionado na migration 0013, quando wms.stock_balance passar a existir).
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.prevent_sku_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'RF-DAD-050: sku is immutable after creation (% -> %)', OLD.sku, NEW.sku
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS wms.product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  species_code TEXT NOT NULL REFERENCES wms.product_species(code) ON DELETE RESTRICT,
  commercial_category_id UUID REFERENCES wms.commercial_category(id) ON DELETE RESTRICT,
  base_uom TEXT NOT NULL,
  is_weight_variable BOOLEAN NOT NULL DEFAULT FALSE,
  net_weight_kg NUMERIC(12,3),
  gross_weight_kg NUMERIC(12,3),
  length_m NUMERIC(8,3),
  width_m NUMERIC(8,3),
  height_m NUMERIC(8,3),
  giro_policy TEXT,
  min_shelf_life_pct NUMERIC(5,2),
  shelf_life_days INT,
  ncm TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT product_tenant_sku_unique UNIQUE (tenant_id, sku),
  CONSTRAINT product_sku_length CHECK (char_length(sku) <= 40),
  CONSTRAINT product_base_uom_check CHECK (base_uom IN ('UN', 'KG', 'L', 'M', 'M2', 'M3', 'CX', 'PC')),
  CONSTRAINT product_giro_policy_check CHECK (giro_policy IS NULL OR giro_policy IN ('FEFO', 'FIFO', 'LIFO', 'JIT')),
  CONSTRAINT product_status_check CHECK (status IN ('ACTIVE', 'BLOCKED', 'DISCONTINUED'))
);

CREATE TRIGGER product_sku_immutable
  BEFORE UPDATE ON wms.product
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_sku_update();

ALTER TABLE wms.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.product FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_tenant_isolation ON wms.product;
CREATE POLICY product_tenant_isolation ON wms.product
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.product TO wms_app;

-- =============================================================================
-- product_packaging — DOC-02 §5.3 (DE TENANT); UNIQUE(product_id, code)
-- qty_in_base_uom > 0 (RN-DAD-021 — base da conversao de unidades)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.product_packaging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  qty_in_base_uom NUMERIC(18,6) NOT NULL,
  is_default_receiving BOOLEAN NOT NULL DEFAULT FALSE,
  is_default_picking BOOLEAN NOT NULL DEFAULT FALSE,
  ballast INT,
  layers INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT product_packaging_product_code_unique UNIQUE (product_id, code),
  CONSTRAINT product_packaging_qty_positive CHECK (qty_in_base_uom > 0)
);

ALTER TABLE wms.product_packaging ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.product_packaging FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_packaging_tenant_isolation ON wms.product_packaging;
CREATE POLICY product_packaging_tenant_isolation ON wms.product_packaging
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.product_packaging TO wms_app;

-- =============================================================================
-- product_barcode — DOC-02 §5.3 (DE TENANT); UNIQUE global em barcode
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.product_barcode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  barcode TEXT NOT NULL,
  barcode_type TEXT NOT NULL,
  packaging_id UUID REFERENCES wms.product_packaging(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT product_barcode_unique UNIQUE (barcode),
  CONSTRAINT product_barcode_type_check CHECK (barcode_type IN ('EAN13', 'EAN8', 'DUN14', 'INTERNAL'))
);

ALTER TABLE wms.product_barcode ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.product_barcode FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_barcode_tenant_isolation ON wms.product_barcode;
CREATE POLICY product_barcode_tenant_isolation ON wms.product_barcode
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.product_barcode TO wms_app;

-- =============================================================================
-- product_warehouse_parameter — DOC-02 §5.3 (DE TENANT)
-- UNIQUE(tenant_id, product_id, warehouse_id)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.product_warehouse_parameter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  safety_stock_qty NUMERIC(18,6),
  kanban_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kanban_trigger_qty NUMERIC(18,6),
  kanban_replenish_qty NUMERIC(18,6),
  default_picking_location_id UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  putaway_zone_preference UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT product_warehouse_parameter_unique UNIQUE (tenant_id, product_id, warehouse_id),
  CONSTRAINT product_warehouse_parameter_kanban_check CHECK (
    NOT kanban_enabled OR (kanban_trigger_qty IS NOT NULL AND kanban_replenish_qty IS NOT NULL)
  )
);

ALTER TABLE wms.product_warehouse_parameter ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.product_warehouse_parameter FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_warehouse_parameter_tenant_isolation ON wms.product_warehouse_parameter;
CREATE POLICY product_warehouse_parameter_tenant_isolation ON wms.product_warehouse_parameter
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.product_warehouse_parameter TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (11, 'DOC-02 product catalog: product_species (GLOBAL), commercial_category, product, product_packaging, product_barcode, product_warehouse_parameter (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
