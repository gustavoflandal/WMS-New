-- Migration: 0042
-- DOC-04 RF-REC-030 (Etiquetagem/paletização) — wms.pallet/wms.pallet_content
-- (migration 0012, Sessão 2B, JÁ COMMITADA — por isso um ALTER TABLE aqui,
-- não uma edição direta daquele arquivo) não tinham NENHUM vínculo com
-- inbound_order/inbound_order_item. RF-REC-020 §5.1 exige rastrear
-- "quantidades conferidas restantes" por item ao formar cada palete
-- (conteúdo do palete = quantidades conferidas restantes) — sem esse
-- vínculo não há como calcular quanto de cada item já foi paletizado nem
-- saber a quais Ordens os paletes formados pertencem. Ambas as colunas são
-- NULLABLE: pallet/pallet_content são conceitos genéricos do DOC-02,
-- reutilizados fora do fluxo de recebimento (ex.: repaletização em
-- expedição, DOC-06, quando existir).

ALTER TABLE wms.pallet ADD COLUMN IF NOT EXISTS inbound_order_id UUID REFERENCES wms.inbound_order(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_pallet_inbound_order ON wms.pallet (inbound_order_id);

ALTER TABLE wms.pallet_content ADD COLUMN IF NOT EXISTS inbound_order_item_id UUID REFERENCES wms.inbound_order_item(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_pallet_content_order_item ON wms.pallet_content (inbound_order_item_id);

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (42, 'DOC-04 RF-REC-030: pallet.inbound_order_id + pallet_content.inbound_order_item_id (ALTER de tabelas ja commitadas na migration 0012)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
