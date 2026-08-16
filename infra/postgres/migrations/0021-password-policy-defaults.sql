-- Migration: 0021
-- DOC-12 RF-SEG-002 — parâmetros de política de senha em app_parameter
-- (chaves SEG.PASSWORD_*, escopo GLOBAL). Valores EXATOS do documento:
-- "10 caracteres, 3 classes de caracteres, bloqueio por 15 min após 5
-- falhas consecutivas, histórico das últimas 5 senhas".
--
-- Nota: reaproveita o schema JÁ EXISTENTE de wms.app_parameter (migration
-- 0004, DOC-01) — colunas (scope, name, value TEXT, warehouse_id,
-- client_id), que diverge do dicionário do DOC-02 §5.7 (key/value jsonb/
-- value_type), débito já registrado no relatório da Sessão 2A (§4) e não
-- tocado aqui ("não refatore código que já passa nos testes").
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'SEG.PASSWORD_MIN_LENGTH',       '10'),
  ('GLOBAL', 'SEG.PASSWORD_MIN_CLASSES',      '3'),
  ('GLOBAL', 'SEG.PASSWORD_LOCKOUT_MINUTES',  '15'),
  ('GLOBAL', 'SEG.PASSWORD_LOCKOUT_THRESHOLD','5'),
  ('GLOBAL', 'SEG.PASSWORD_HISTORY_COUNT',    '5')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (21, 'DOC-12 RF-SEG-002: default SEG.PASSWORD_* app_parameter values', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
