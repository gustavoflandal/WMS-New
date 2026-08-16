-- Migration: 0023
-- DOC-03 §3 — catálogo de permissões e exceções da Portaria e Pátio.
-- POR.DADO_PESSOAL_COMPLETO já existe (migration 0016, Sessão 3/DOC-12) —
-- não reinserida aqui. DOC-03 §3 lista a coluna "Interação" do Porteiro
-- como "Gate-in/gate-out, cadastro de visitantes/motoristas, acionamento
-- de cancela" — NÃO cita visualização de dado pessoal completo; portanto
-- o papel-semente PORTEIRO NÃO recebe POR.DADO_PESSOAL_COMPLETO por
-- padrão aqui (concessão granular fica a critério do GESTOR_ARMAZEM via
-- role_permission/grant específico, fora desta migration de catálogo —
-- RN-SEG-051 mantém o mascaramento como padrão, testado desde a Sessão 3
-- em cpf-masking-audit.integration.spec.ts). Os outros 8 códigos POR.* de
-- §3 são novos desta sessão.

-- =============================================================================
-- permission — DOC-03 §3 (8 códigos novos; POR.DADO_PESSOAL_COMPLETO é o 9º
-- item da tabela do documento, já existente desde a Sessão 3)
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('POR.GATE_IN',                      'WAREHOUSE',        'Registro de gate-in de veiculos/pessoas (DOC-03 §3)',               FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.GATE_OUT',                     'WAREHOUSE',        'Registro de gate-out de veiculos/pessoas (DOC-03 §3)',              FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.CADASTRO_MOTORISTA_VISITANTE', 'WAREHOUSE',        'Cadastro/edicao de motorista, veiculo e visitante (DOC-03 §3)',    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.AGENDAMENTO_CRIAR',            'CLIENT_WAREHOUSE', 'Criacao de agendamento (DOC-03 RF-POR-001)',                       FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.AGENDAMENTO_GERIR',            'WAREHOUSE',        'Gestao (remarcar/cancelar apos inicio da janela) de agendamentos (DOC-03 RF-POR-003)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.FILA_PRIORIZAR',               'WAREHOUSE',        'Marcar prioridade manual na fila de patio (DOC-03 RN-POR-021)',    TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('POR.CHAMADA_DOCA',                 'WAREHOUSE',        'Confirmar chamada de veiculo para doca (DOC-03 RF-POR-022)',       FALSE, '00000000-0000-0000-0000-000000000001'),
  ('POR.ACIONAR_CANCELA',              'WAREHOUSE',        'Acionamento manual/override de cancela (DOC-03 RF-POR-014)',       TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Concede as novas permissoes aos papeis semente pertinentes (DOC-03 §3:
-- Porteiro, Lider de Turno, Cliente-Operacao, Gestor de Armazem).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('POR.GATE_IN'), ('POR.GATE_OUT'), ('POR.CADASTRO_MOTORISTA_VISITANTE'),
  ('POR.ACIONAR_CANCELA')
) AS p(code)
WHERE r.code = 'PORTEIRO'
ON CONFLICT DO NOTHING;

-- Lider de Turno: fila de patio, chamadas para doca, e decisao de excecoes
-- (DOC-03 §3 lista "excecoes" como interacao do Lider de Turno; SEG.APROVACAO_EXCECAO
-- ja existe desde a migration 0016, ate entao concedida apenas ao GESTOR_ARMAZEM —
-- estender ao LIDER_TURNO tambem e o que torna RN-POR-040 (2 aprovadores distintos
-- para POR.SAIDA_COM_PENDENCIA) exercitavel com papeis realistas de portaria).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('POR.FILA_PRIORIZAR'), ('POR.CHAMADA_DOCA'), ('SEG.APROVACAO_EXCECAO')
) AS p(code)
WHERE r.code = 'LIDER_TURNO'
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('POR.AGENDAMENTO_GERIR')) AS p(code)
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('POR.AGENDAMENTO_CRIAR')) AS p(code)
WHERE r.code = 'CLIENTE_OPERACAO'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- exception_type — DOC-03 §3 (4 tipos)
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('POR.VEICULO_SEM_AGENDAMENTO', 'Veiculo sem agendamento',            1, TRUE, 4, '00000000-0000-0000-0000-000000000001'),
  ('POR.FORA_DA_JANELA',          'Chegada fora da janela agendada',    1, TRUE, 4, '00000000-0000-0000-0000-000000000001'),
  ('POR.SAIDA_COM_PENDENCIA',     'Saida forcada com pendencia',        2, TRUE, 2, '00000000-0000-0000-0000-000000000001'),
  ('POR.DIVERGENCIA_LACRE',       'Divergencia de lacre na conferencia',1, TRUE, 8, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- app_parameter — DOC-03 §7. POR.JANELA_CAPACIDADE citado em RN-POR-002 NAO
-- e inserido aqui como parametro global: RD-POR-007 modela capacidade como
-- coluna por janela individual (armazem+dia+faixa+sentido) em
-- appointment_window_config, granularidade que um unico parametro escalar
-- nao permite representar (haveria uma capacidade so, nao "por janela").
-- [LACUNA/decisao de modelagem: §4.1 cita "configuracao POR.JANELA_CAPACIDADE"
-- como se fosse parametro unico, mas §7/RD-POR-007 exige capacidade por
-- janela — adotada a modelagem de RD-POR-007, mais especifica e coerente
-- com "sugerir as 5 proximas janelas com vaga" (multiplas janelas, cada
-- uma com sua propria capacidade).]
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'POR.TOLERANCIA_ATRASO_MIN', '60'),
  ('GLOBAL', 'POR.PESO_PRIORIDADE_P1',    '4'),
  ('GLOBAL', 'POR.PESO_PRIORIDADE_P2',    '3'),
  ('GLOBAL', 'POR.PESO_PRIORIDADE_P3',    '2'),
  ('GLOBAL', 'POR.PESO_PRIORIDADE_P4',    '8'),
  ('GLOBAL', 'POR.CHECKLIST_HAZMAT',      '["ROTULO_RISCO","FICHA_EMERGENCIA"]'),
  ('GLOBAL', 'POR.EXIGE_LACRE_SAIDA',     'false'),
  ('GLOBAL', 'SEG.RETENCAO_PORTARIA_MESES', '24')
ON CONFLICT DO NOTHING;

-- RN-POR-004: o worker de no-show (ADR-006, BYPASSRLS) le POR.TOLERANCIA_ATRASO_MIN
-- cross-tenant via transactionAsWorker — BYPASSRLS nao concede privilegio de
-- tabela automaticamente (mesmo gap ja encontrado 3x na Sessao 3).
GRANT SELECT ON wms.app_parameter TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (23, 'DOC-03 catalog: 8 permissoes POR.*, 4 exception_type POR.*, grants aos papeis semente, app_parameter defaults', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
