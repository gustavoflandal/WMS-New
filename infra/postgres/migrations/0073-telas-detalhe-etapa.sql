-- Migration: 0073
-- DOC-17 — Sessão 10A: Parte A (Detalhe de Etapa / drill-down). Só a
-- permissão de consulta entra aqui — o restante do catálogo TEL.* (§4 do
-- DOC-17: EXECUCAO_TELA, FORMULARIO_*, TRANSCREVER*, MODO_EXECUCAO_CONFIGURAR)
-- é da Parte B (10B), sem chamador nesta sessão.

INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('TEL.DETALHE_CONSULTAR', 'CLIENT_WAREHOUSE', 'Consulta de detalhe de etapa do Fluxo Operacional (DOC-17 RF-TEL-001)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- DOC-17 §4: "qualquer usuário com permissão de consulta do módulo" — todos
-- os papéis internos operacionais + cliente (portal, RF-TEL-004/RF-PAI-020).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('TEL.DETALHE_CONSULTAR')) AS p(code)
WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO', 'CONFERENTE', 'OPERADOR_PICKING', 'FATURISTA', 'CLIENTE_OPERACAO')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (73, 'DOC-17 10A: permissao TEL.DETALHE_CONSULTAR (Parte A - detalhe de etapa)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
