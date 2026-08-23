-- Migration: 0060
-- DOC-11 §3 — Catálogo de permissões PER.*: PER.GESTAO_DISPOSITIVOS
-- (WAREHOUSE, sensível — pareamento de Edge Agent, cadastro de
-- dispositivo/estação), PER.GESTAO_TEMPLATES (GLOBAL, sensível — só quem
-- tem esta permissão edita/ativa versão de label_template, RN-PER-020),
-- PER.REIMPRESSAO (WAREHOUSE — reimpressão de etiqueta, RN-SEG-032 PRINT).
-- "Sem exceções próprias" (DOC-11 §3) além das 3 acima.

INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('PER.GESTAO_DISPOSITIVOS', 'WAREHOUSE', 'Registro de Edge Agents, dispositivos e estacoes (DOC-11 RNF-PER-001/RF-PER-004)', TRUE, '00000000-0000-0000-0000-000000000001'),
  ('PER.GESTAO_TEMPLATES',    'GLOBAL',    'Edicao e ativacao de versao de label_template (DOC-11 RN-PER-020)',                TRUE, '00000000-0000-0000-0000-000000000001'),
  ('PER.REIMPRESSAO',         'WAREHOUSE', 'Reimpressao de etiqueta com motivo, marca RE1/RE2/... (DOC-11 RF-PER-021)',        FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Atribuição a papéis de seed: PER.GESTAO_DISPOSITIVOS é WAREHOUSE (não
-- GLOBAL) — NÃO pode ir para ADMIN_SISTEMA/ADMIN_SEGURANCA (migration 0016:
-- esses papéis só recebem atribuição sem warehouse_id/client_id quando
-- TODAS as suas permissões são GLOBAL; rbac-resolution.integration.spec.ts
-- trava esse invariante — mesma nota já registrada na migration 0054 para
-- PAI.*, esquecida uma vez aqui e corrigida antes do commit). Gestão de
-- dispositivos de um armazém é papel do Gestor daquele armazém.
-- Reimpressão é operacional (líder de turno decide, mesmo nível de
-- RN-EXP-051).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'PER.GESTAO_DISPOSITIVOS', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'PER.GESTAO_TEMPLATES', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code = 'ADMIN_SISTEMA'
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'PER.REIMPRESSAO', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- RD-PER (final do §7): parâmetros PER.*.
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'PER.LPR_CONFIANCA_MIN',         '0.85'),
  ('GLOBAL', 'PER.WEIGH_TIMEOUT_MS',          '10000'),
  ('GLOBAL', 'PER.PRINT_FILA_VALIDADE_MIN',   '30')
ON CONFLICT DO NOTHING;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (60, 'DOC-11: catalogo de permissoes PER.GESTAO_DISPOSITIVOS/GESTAO_TEMPLATES/REIMPRESSAO + parametros PER.*', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
