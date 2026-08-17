-- Migration: 0033
-- DOC-04 §3 — catálogo de permissões e exceções de Recebimento e Docas.

-- =============================================================================
-- permission — DOC-04 §3 (6 códigos)
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('REC.ATRACAR',              'WAREHOUSE',        'Registro de atracação de veículo na doca (DOC-04 RF-REC-002)',        FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REC.LIBERAR_DOCA',         'WAREHOUSE',         'Liberação de doca ao fim da operação (DOC-04 RF-REC-043)',           FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REC.CONFERIR',             'CLIENT_WAREHOUSE', 'Contagem/conferência de itens do recebimento (DOC-04 RF-REC-021)',   FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REC.RECONTAR',             'CLIENT_WAREHOUSE', 'Recontagem de item divergente (DOC-04 RN-REC-022)',                  FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REC.ENCERRAR_CONFERENCIA', 'CLIENT_WAREHOUSE', 'Encerramento da etapa de conferência (DOC-04 RF-REC-024)',           FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REC.LIBERAR_QUARENTENA',   'CLIENT_WAREHOUSE', 'Liberação de lote em quarentena (DOC-04 RN-REC-031)',                TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('REC.CANCELAR_RECEBIMENTO', 'CLIENT_WAREHOUSE', 'Cancelamento de Ordem de Recebimento sem contagem iniciada (DOC-04 §5.1)', TRUE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Concessões aos papéis semente — DOC-04 §3 "Atores e permissões envolvidas".
-- LIDER_TURNO: "Atracação, designação de conferentes, decisão de exceções"
-- -> REC.ATRACAR/REC.LIBERAR_DOCA (atracação/liberação são ações diretas do
-- líder); REC.ENCERRAR_CONFERENCIA tratado como ação de fechamento/decisão
-- (mesma categoria de "decisão de exceções"), não uma ação rotineira de
-- contagem do conferente.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('REC.ATRACAR'), ('REC.LIBERAR_DOCA'), ('REC.ENCERRAR_CONFERENCIA')
) AS p(code)
WHERE r.code = 'LIDER_TURNO'
ON CONFLICT DO NOTHING;

-- CONFERENTE: "Descarga assistida, contagem, registro de divergências e
-- avarias" -> REC.CONFERIR cobre contagem + registro de divergência/avaria
-- (não há código dedicado a "registrar divergência" no catálogo de 6);
-- REC.RECONTAR cobre a recontagem exigida por RN-REC-022 (a regra de
-- "conferente DIFERENTE" é aplicada no service, não na permissão em si —
-- ambos os conferentes precisam da MESMA permissão para estarem elegíveis).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('REC.CONFERIR'), ('REC.RECONTAR')
) AS p(code)
WHERE r.code = 'CONFERENTE'
ON CONFLICT DO NOTHING;

-- CLIENTE_OPERACAO: "Envio de ASN" — RF-REC-010(c) cita REC.CONFERIR
-- explicitamente como a permissão exigida para digitação manual; não há
-- código separado para upload de XML/ERP no catálogo de 6, então a mesma
-- permissão (escopo CLIENT_WAREHOUSE, compatível com o portal) governa a
-- criação da Ordem de Recebimento independente da origem.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'REC.CONFERIR', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code = 'CLIENTE_OPERACAO'
ON CONFLICT DO NOTHING;

-- "Qualidade" (DOC-04 §3: "papel com REC.LIBERAR_QUARENTENA") não é um dos
-- 13 papéis semente fixados desde a Sessão 3/DOC-12 (RF-SEG-013) — não é
-- criado um 14º papel aqui, decisão consistente com o padrão já registrado
-- no relatório da Sessão 3 (composição de permissões só onde o próprio
-- corpo do documento dá sinal direto de um papel EXISTENTE). REC.LIBERAR_
-- QUARENTENA e REC.CANCELAR_RECEBIMENTO são ambas sensíveis — concedidas a
-- GESTOR_ARMAZEM, mesmo padrão já usado para permissões sensíveis sem papel
-- dedicado (ex.: POR.DADO_PESSOAL_COMPLETO, DOC-12/Sessão 3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('REC.LIBERAR_QUARENTENA'), ('REC.CANCELAR_RECEBIMENTO')
) AS p(code)
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- exception_type — DOC-04 §3 (6 tipos, valores exatos da tabela)
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('REC.DIVERGENCIA_FALTA',     'Divergência de falta na conferência',      1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.DIVERGENCIA_SOBRA',     'Divergência de sobra na conferência',      1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.DIVERGENCIA_AVARIA',    'Divergência de avaria na conferência',     1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.DIVERGENCIA_TROCA',     'Divergência de troca de produto',          1, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.PRODUTO_SEM_CADASTRO',  'Item de ASN sem produto cadastrado',       2, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.RECUSA_TOTAL',          'Recusa total do recebimento',              2, TRUE, 8,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- app_parameter — DOC-04 §7, parâmetros em escopo desta sessão (4A). O
-- REC.CRITERIOS_PUTAWAY (§4.5, motor de putaway) NÃO é semeado aqui — é
-- parâmetro do motor de putaway, [DÉBITO: Sessão 4B], sem nada nesta sessão
-- que o leia; semeá-lo agora seria inventar um valor para uma feature ainda
-- não implementada.
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'REC.PERMITE_PALETE_MISTO',     'true'),
  ('GLOBAL', 'REC.QUARENTENA_ESPECIES',      '["MEDICAMENTO"]'),
  ('GLOBAL', 'REC.CROSSDOCK_TEMPO_MAX_H',    '24')
ON CONFLICT DO NOTHING;
-- REC.MAPA_DISTANCIA_DOCA_ZONA (matriz doca x zona em metros, RF-REC-003):
-- não é um escalar único — modelado como tabela própria
-- (wms.dock_zone_distance) na migration de docas, não como app_parameter
-- (mesma decisão de modelagem já tomada para POR.JANELA_CAPACIDADE na
-- Sessão 4/DOC-03: um parâmetro matricial não cabe em app_parameter
-- scope/name/value escalar).

-- RN-POR-004-like: o worker de alerta de cross-docking (RNF-REC-052, ADR-006)
-- lê REC.CROSSDOCK_TEMPO_MAX_H cross-tenant via transactionAsWorker.
GRANT SELECT ON wms.app_parameter TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (33, 'DOC-04 catalog: 6 permissoes REC.*, 6 exception_type REC.*, grants aos papeis semente, app_parameter defaults', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
