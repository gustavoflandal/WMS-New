-- Seed: 0001-seed-sp01
-- DOC-02 ENTREGÁVEL 4 (SESSÃO 2A): 1 armazém de exemplo, zonas dos tipos
-- principais, 1 storage_equipment de cada equipment_type, endereços gerados
-- por lógica equivalente a RF-DAD-054, 2 docas, 4 vagas de pátio (1 HAZMAT).
--
-- Idempotente: cada bloco depende de ON CONFLICT DO NOTHING (ou
-- WHERE NOT EXISTS) sobre as constraints UNIQUE já existentes nas migrations
-- 0008/0009 — pode rodar múltiplas vezes sem duplicar linhas.
--
-- Separado das migrations de propósito (não roda no boot do
-- `docker compose up` / `DatabaseModule.onModuleInit` — só via `pnpm db:seed`).
--
-- created_by/updated_by: não há tabela wms.user ainda (DOC-12 é futuro),
-- então usamos um UUID fixo "ator de seed" documentado aqui, igual ao
-- [DEBITO: FK created_by/updated_by para wms.user quando DOC-12 existir] já
-- registrado nas migrations 0008/0009.

-- =============================================================================
-- warehouse — SP01
-- =============================================================================
INSERT INTO wms.warehouse (
  code, name, cnpj, timezone,
  address_street, address_number, address_district, address_city,
  address_state, address_zip_code, created_by
)
VALUES (
  'SP01', 'Armazém São Paulo 01', '11222333000181', 'America/Sao_Paulo',
  'Rodovia Anhanguera', '1000', 'Distrito Industrial', 'São Paulo',
  'SP', '05000000', '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- zone — tipos principais do fluxo operacional
-- =============================================================================
INSERT INTO wms.zone (warehouse_id, code, name, zone_type, created_by)
SELECT w.id, z.code, z.name, z.zone_type, '00000000-0000-0000-0000-000000000001'
FROM wms.warehouse w
CROSS JOIN (VALUES
  ('REC', 'Recebimento', 'RECEIVING'),
  ('QUA', 'Quarentena', 'QUARANTINE'),
  ('STO', 'Armazenagem', 'STORAGE'),
  ('PIC', 'Picking', 'PICKING'),
  ('PAC', 'Packing', 'PACKING'),
  ('DIS', 'Expedição', 'DISPATCH')
) AS z(code, name, zone_type)
WHERE w.code = 'SP01'
ON CONFLICT (warehouse_id, code) DO NOTHING;

-- =============================================================================
-- storage_equipment — 1 de cada equipment_type (9 linhas)
-- =============================================================================
INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by)
SELECT w.id, se.code, se.equipment_type, '00000000-0000-0000-0000-000000000001'
FROM wms.warehouse w
CROSS JOIN (VALUES
  ('PP01', 'PORTA_PALETES'),
  ('DI01', 'DRIVE_IN'),
  ('DT01', 'DRIVE_THRU'),
  ('CT01', 'CANTILEVER'),
  ('FR01', 'FLOWRACK'),
  ('ES01', 'ESTANTE'),
  ('GV01', 'GAVETEIRO'),
  ('CR01', 'CARROSSEL'),
  ('BL01', 'BLOCADO')
) AS se(code, equipment_type)
WHERE w.code = 'SP01'
ON CONFLICT (warehouse_id, code) DO NOTHING;

-- =============================================================================
-- location — RF-DAD-054: geração em massa por intervalo de coordenadas
-- Ruas A1-A2 x módulos 001-003 x níveis 00-01 x vãos 01-02 = 24 endereços,
-- todos na zona STORAGE, no equipamento PORTA_PALETES.
-- =============================================================================
INSERT INTO wms.location (
  warehouse_id, zone_id, storage_equipment_id, aisle, module, level, slot,
  location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, abc_class, created_by
)
SELECT
  w.id, z.id, se.id,
  aisle_label,
  lpad(module_n::text, 3, '0'),
  lpad(level_n::text, 2, '0'),
  lpad(slot_n::text, 2, '0'),
  'STORAGE', 1000.000, 1.5000, 1, 5.000, 'B',
  '00000000-0000-0000-0000-000000000001'
FROM wms.warehouse w
JOIN wms.zone z ON z.warehouse_id = w.id AND z.code = 'STO'
JOIN wms.storage_equipment se ON se.warehouse_id = w.id AND se.code = 'PP01'
CROSS JOIN (VALUES ('A1'), ('A2')) AS aisles(aisle_label)
CROSS JOIN generate_series(1, 3) AS module_n
CROSS JOIN generate_series(0, 1) AS level_n
CROSS JOIN generate_series(1, 2) AS slot_n
WHERE w.code = 'SP01'
ON CONFLICT (warehouse_id, aisle, module, level, slot) DO NOTHING;

-- =============================================================================
-- dock — 2 docas
-- =============================================================================
INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, created_by)
SELECT w.id, d.code, d.dock_type, d.has_leveler, '00000000-0000-0000-0000-000000000001'
FROM wms.warehouse w
CROSS JOIN (VALUES
  ('DOC01', 'INBOUND', TRUE),
  ('DOC02', 'OUTBOUND', TRUE)
) AS d(code, dock_type, has_leveler)
WHERE w.code = 'SP01'
ON CONFLICT (warehouse_id, code) DO NOTHING;

-- =============================================================================
-- yard_slot — 4 vagas de pátio (1 HAZMAT)
-- =============================================================================
INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by)
SELECT w.id, y.code, y.slot_type, '00000000-0000-0000-0000-000000000001'
FROM wms.warehouse w
CROSS JOIN (VALUES
  ('YD01', 'WAITING'),
  ('YD02', 'WAITING'),
  ('YD03', 'PARKING'),
  ('YD04', 'HAZMAT')
) AS y(code, slot_type)
WHERE w.code = 'SP01'
ON CONFLICT (warehouse_id, code) DO NOTHING;
