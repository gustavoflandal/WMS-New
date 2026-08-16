-- Seed: 0002-seed-catalog
-- DOC-02 ENTREGÁVEL 10 (SESSÃO 2B): estende o seed do SP01 (0001) com 1
-- cliente, 3 produtos (1 MEDICAMENTO com lote/validade, 1 GERAL, 1 de peso
-- variável), embalagens e códigos de barras. Espécies (product_species) já
-- são inseridas pela própria migration 0011 (dado definitório do documento,
-- não seed). Idempotente via ON CONFLICT DO NOTHING em cada bloco.
--
-- Pré-requisito: 0001-seed-sp01.sql já aplicado (usa o warehouse SP01).
-- created_by/updated_by: mesmo UUID fixo "ator de seed" de 0001 (não há
-- wms.user ainda — DOC-12 é futuro).

-- =============================================================================
-- client — ACME01
-- CNPJ 12345678000195: calculado pelo mesmo algoritmo de wms.is_valid_cnpj
-- (módulo 11) e confirmado válido via `SELECT wms.is_valid_cnpj(...)`.
-- =============================================================================
INSERT INTO wms.client (code, legal_name, trade_name, cnpj, contact_email, created_by)
VALUES (
  'ACME01', 'ACME Distribuidora Ltda', 'ACME', '12345678000195',
  'contato@acme-exemplo.invalid', '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- product — 3 produtos do cliente ACME01
-- MED001: espécie MEDICAMENTO (requires_batch/requires_expiration = true)
-- GER001: espécie GERAL (sem exigências)
-- VAR001: peso variável (is_weight_variable = true), base_uom KG
-- =============================================================================
INSERT INTO wms.product (tenant_id, sku, description, species_code, base_uom, is_weight_variable, shelf_life_days, created_by)
SELECT c.id, p.sku, p.description, p.species_code, p.base_uom, p.is_weight_variable, p.shelf_life_days, '00000000-0000-0000-0000-000000000001'
FROM wms.client c
CROSS JOIN (VALUES
  ('MED001', 'Medicamento Exemplo 500mg', 'MEDICAMENTO', 'UN', FALSE, 730),
  ('GER001', 'Produto Geral Exemplo',     'GERAL',       'UN', FALSE, NULL),
  ('VAR001', 'Queijo Exemplo Peso Variável', 'GERAL',    'KG', TRUE,  NULL)
) AS p(sku, description, species_code, base_uom, is_weight_variable, shelf_life_days)
WHERE c.code = 'ACME01'
ON CONFLICT (tenant_id, sku) DO NOTHING;

-- =============================================================================
-- batch — lote do MED001 (obrigatório: espécie MEDICAMENTO exige lote com
-- validade, RN-DAD-020, aplicado pelos triggers das migrations 0012/0014)
-- =============================================================================
INSERT INTO wms.batch (tenant_id, product_id, batch_code, manufacture_date, expiration_date, created_by)
SELECT c.id, p.id, 'LOTE2026A', DATE '2026-01-01', DATE '2027-01-01', '00000000-0000-0000-0000-000000000001'
FROM wms.client c
JOIN wms.product p ON p.tenant_id = c.id AND p.sku = 'MED001'
WHERE c.code = 'ACME01'
ON CONFLICT (tenant_id, product_id, batch_code) DO NOTHING;

-- =============================================================================
-- product_packaging — 1 embalagem por produto
-- =============================================================================
INSERT INTO wms.product_packaging (tenant_id, product_id, code, description, qty_in_base_uom, is_default_receiving, is_default_picking, created_by)
SELECT c.id, p.id, pk.code, pk.description, pk.qty_in_base_uom, pk.is_default_receiving, pk.is_default_picking, '00000000-0000-0000-0000-000000000001'
FROM wms.client c
JOIN wms.product p ON p.tenant_id = c.id
CROSS JOIN LATERAL (
  VALUES
    ('MED001', 'CX10', 'Caixa com 10 unidades', 10::numeric, TRUE, FALSE),
    ('GER001', 'CX12', 'Caixa com 12 unidades', 12::numeric, TRUE, TRUE),
    ('VAR001', 'UN1',  'Unidade avulsa (pesagem no packing)', 1::numeric, TRUE, TRUE)
) AS pk(sku, code, description, qty_in_base_uom, is_default_receiving, is_default_picking)
WHERE c.code = 'ACME01' AND p.sku = pk.sku
ON CONFLICT (product_id, code) DO NOTHING;

-- =============================================================================
-- product_barcode — 1 código de barras (unidade base) por produto
-- =============================================================================
INSERT INTO wms.product_barcode (tenant_id, product_id, barcode, barcode_type, created_by)
SELECT c.id, p.id, bc.barcode, 'EAN13', '00000000-0000-0000-0000-000000000001'
FROM wms.client c
JOIN wms.product p ON p.tenant_id = c.id
CROSS JOIN LATERAL (
  VALUES
    ('MED001', '7891000000015'),
    ('GER001', '7891000000022'),
    ('VAR001', '7891000000039')
) AS bc(sku, barcode)
WHERE c.code = 'ACME01' AND p.sku = bc.sku
ON CONFLICT (barcode) DO NOTHING;
