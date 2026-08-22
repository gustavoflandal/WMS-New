-- Migration: 0054
-- DOC-10 §3 — Catálogo de permissões PAI.*: PAI.PAINEL_OPERACOES (WAREHOUSE),
-- PAI.DASHBOARD (WAREHOUSE), PAI.DASHBOARD_CLIENTE (CLIENT_WAREHOUSE, portal —
-- catalogada agora; consumo fica para a sessão do portal do cliente, DOC-13,
-- fora de escopo aqui), PAI.CHAT (WAREHOUSE). Sem exceções próprias neste
-- módulo (DOC-10 §3: "Sem exceções próprias neste módulo").

INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('PAI.PAINEL_OPERACOES',  'WAREHOUSE',         'Painel de Operacoes Pendentes (DOC-10 RF-PAI-001)',            FALSE, '00000000-0000-0000-0000-000000000001'),
  ('PAI.DASHBOARD',         'WAREHOUSE',         'Dashboards de performance diaria (DOC-10 RF-PAI-040)',         FALSE, '00000000-0000-0000-0000-000000000001'),
  ('PAI.DASHBOARD_CLIENTE', 'CLIENT_WAREHOUSE',  'Dashboard restrito ao proprio estoque, portal (DOC-10 RF-PAI-040)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('PAI.CHAT',              'WAREHOUSE',         'Chat operacional, salas de armazem-turno e de operacao (DOC-10 RF-PAI-030)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Atribuição a papéis de seed: DOC-10 §3 diz "Todos os usuários internos" para
-- o Painel (RF-PAI-001) e não restringe o Chat (§4.4, sem exceção de acesso
-- citada) — lido como todo papel INTERNAL que opera o armazém no dia a dia.
-- Exclui ADMIN_SISTEMA/ADMIN_SEGURANCA: migration 0016 os mantém com SOMENTE
-- permissões GLOBAL de propósito (RD-SEG-010 permite atribuição sem
-- warehouse_id/client_id só quando TODAS as permissões do papel são GLOBAL;
-- rbac-resolution.integration.spec.ts trava esse invariante) — dar-lhes
-- PAI.PAINEL_OPERACOES/CHAT (WAREHOUSE) quebraria essa premissa sem
-- necessidade operacional real (administração de sistema/segurança não
-- acompanha o chão de armazém). Dashboards completos ficam com Gestor/Líder
-- (§3 literal). PAI.DASHBOARD_CLIENTE vai para os papéis de portal
-- (CLIENTE_*), mesmo que o consumo (UI do portal) seja de outra sessão — o
-- catálogo de permissão não depende da UI existir.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('PAI.PAINEL_OPERACOES'), ('PAI.CHAT')) AS p(code)
WHERE r.area = 'INTERNAL' AND r.code NOT IN ('ADMIN_SISTEMA', 'ADMIN_SEGURANCA')
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'PAI.DASHBOARD', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'PAI.DASHBOARD_CLIENTE', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.area = 'CLIENT_PORTAL'
ON CONFLICT DO NOTHING;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (54, 'DOC-10: catalogo de permissoes PAI.PAINEL_OPERACOES/DASHBOARD/DASHBOARD_CLIENTE/CHAT', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
