-- Migration: 0012
-- DOC-02 §5.4 — Lotes e paletes (DE TENANT, RN-DAD-004: tenant_id = client.id,
-- RLS obrigatorio). batch, pallet, pallet_content.

-- =============================================================================
-- batch — DOC-02 §5.4; UNIQUE(tenant_id, product_id, batch_code);
-- batch_code imutavel (RF-DAD-050); expiration_date > manufacture_date;
-- expiration_date obrigatoria quando product_species.requires_expiration
-- (RN-DAD-020).
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.prevent_batch_code_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_code IS DISTINCT FROM OLD.batch_code THEN
    RAISE EXCEPTION 'RF-DAD-050: batch_code is immutable after creation (% -> %)', OLD.batch_code, NEW.batch_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS wms.batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_code TEXT NOT NULL,
  manufacture_date DATE,
  expiration_date DATE,
  status TEXT NOT NULL DEFAULT 'RELEASED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT batch_tenant_product_code_unique UNIQUE (tenant_id, product_id, batch_code),
  CONSTRAINT batch_code_length CHECK (char_length(batch_code) <= 30),
  CONSTRAINT batch_expiration_after_manufacture CHECK (
    expiration_date IS NULL OR manufacture_date IS NULL OR expiration_date > manufacture_date
  ),
  CONSTRAINT batch_status_check CHECK (status IN ('RELEASED', 'QUARANTINE', 'BLOCKED', 'RECALLED'))
);

CREATE TRIGGER batch_code_immutable
  BEFORE UPDATE ON wms.batch
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_batch_code_update();

-- RN-DAD-020: "QUANDO requires_expiration = true, todo lote DEVE ter
-- expiration_date". Validado aqui via lookup product -> product_species
-- (nao pode ser CHECK simples: depende de outra tabela).
CREATE OR REPLACE FUNCTION wms.check_batch_expiration_required()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_requires_expiration BOOLEAN;
BEGIN
  SELECT ps.requires_expiration INTO v_requires_expiration
  FROM wms.product p
  JOIN wms.product_species ps ON ps.code = p.species_code
  WHERE p.id = NEW.product_id;

  IF v_requires_expiration AND NEW.expiration_date IS NULL THEN
    RAISE EXCEPTION 'RN-DAD-020: expiration_date is required for this product species'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER batch_expiration_required
  BEFORE INSERT OR UPDATE ON wms.batch
  FOR EACH ROW EXECUTE FUNCTION wms.check_batch_expiration_required();

ALTER TABLE wms.batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.batch FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS batch_tenant_isolation ON wms.batch;
CREATE POLICY batch_tenant_isolation ON wms.batch
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.batch TO wms_app;

-- =============================================================================
-- pallet — DOC-02 §5.4; lpn UNIQUE global, formato RN-DAD-030 (18 digitos)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.pallet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  lpn TEXT NOT NULL,
  pallet_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_RECEIVING',
  current_location_id UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT pallet_lpn_unique UNIQUE (lpn),
  CONSTRAINT pallet_lpn_format CHECK (lpn ~ '^[0-9]{18}$'),
  CONSTRAINT pallet_type_check CHECK (pallet_type IN ('PBR', 'EURO', 'DESCARTAVEL', 'METALICO', 'VOLUME')),
  CONSTRAINT pallet_status_check CHECK (status IN (
    'IN_RECEIVING', 'STORED', 'IN_MOVE', 'IN_PICKING', 'IN_DISPATCH', 'SHIPPED', 'EMPTY', 'CANCELLED'
  ))
);

ALTER TABLE wms.pallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.pallet FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pallet_tenant_isolation ON wms.pallet;
CREATE POLICY pallet_tenant_isolation ON wms.pallet
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.pallet TO wms_app;

-- =============================================================================
-- pallet_content — DOC-02 §5.4; qty > 0. Nao classificada explicitamente em
-- RN-DAD-004 (so `pallet` e citado) -- tratada como DE TENANT por ser tabela
-- transacional filha de pallet ("todas as tabelas transacionais dos
-- modulos" no catch-all de RN-DAD-004). [LACUNA: DOC-02 nao declara
-- constraint de unicidade para pallet_content (pallet_id, product_id,
-- batch_id) -- nao inventada aqui; multiplas linhas para a mesma
-- combinacao sao permitidas pelo schema.]
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.pallet_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  pallet_id UUID NOT NULL REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT pallet_content_qty_positive CHECK (qty > 0)
);

ALTER TABLE wms.pallet_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.pallet_content FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pallet_content_tenant_isolation ON wms.pallet_content;
CREATE POLICY pallet_content_tenant_isolation ON wms.pallet_content
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.pallet_content TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (12, 'DOC-02 batches and pallets: batch, pallet, pallet_content (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
