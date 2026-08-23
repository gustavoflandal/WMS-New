-- Migration: 0064
-- DOC-11 RNF-PER-040 [INVIOLÁVEL] — "o peso gravado no negócio SEMPRE
-- inclui device_code e raw_frame para perícia". wms.package (migration
-- 0051) não tinha onde guardar essa evidência quando o peso vem de balança
-- integrada (RF-EXP-050) — fecha o `[LACUNA: DOC-11]` de pesagem.

ALTER TABLE wms.package ADD COLUMN IF NOT EXISTS weight_device_code TEXT;
ALTER TABLE wms.package ADD COLUMN IF NOT EXISTS weight_raw_frame TEXT;

-- RNF-PER-040: peso de origem SCALE sem evidência é o próprio bug que esta
-- migration fecha — não permitir daqui em diante.
ALTER TABLE wms.package ADD CONSTRAINT package_scale_weight_requires_evidence CHECK (
  weight_source IS DISTINCT FROM 'SCALE' OR (weight_device_code IS NOT NULL AND weight_raw_frame IS NOT NULL)
);

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (64, 'DOC-11 RNF-PER-040: wms.package.weight_device_code/weight_raw_frame (evidencia de pesagem por balanca)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
