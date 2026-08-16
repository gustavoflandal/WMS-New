-- Migration: 0016
-- DOC-12 §4.2 — RBAC multi-dimensional [INVIOLÁVEL]. permission, role,
-- role_permission, user_role_assignment (RD-SEG-010). Todas GLOBAIS
-- (RD-SEG-061: "referenciam cliente por coluna, sem RLS — a resolução de
-- acesso é da aplicação").

-- =============================================================================
-- permission — RD-SEG-010, catalogo fechado
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.permission (
  code TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  description TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT permission_scope_check CHECK (scope IN ('GLOBAL', 'WAREHOUSE', 'CLIENT_WAREHOUSE')),
  CONSTRAINT permission_code_format CHECK (code ~ '^[A-Z]+\.[A-Z_]+$')
);

GRANT SELECT, INSERT, UPDATE ON wms.permission TO wms_app;

-- RD-SEG-014: catalogo inicial de permissoes transversais (valores EXATOS
-- do documento). Inseridos aqui como dado definitorio (mesmo padrao de
-- wms.product_species na Sessao 2B), nao como seed de exemplo.
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('EST.PUTAWAY_OVERRIDE',            'CLIENT_WAREHOUSE', 'Override de putaway (AD-006)',                                TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EST.QUEBRA_POLITICA_GIRO',        'CLIENT_WAREHOUSE', 'Quebra de politica de giro (RG-006)',                         TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EST.LOGICAL_WAREHOUSE_OVERFLOW',  'CLIENT_WAREHOUSE', 'Alocacao em transbordo do armazem logico (RG-015)',           TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EST.VINCULO_ARMAZEM_LOGICO',      'CLIENT_WAREHOUSE', 'Vinculo/desvinculo de endereco a armazem logico (RG-015.4)',  FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.DIGITACAO_LPN',               'WAREHOUSE',        'Digitacao manual de LPN (RG-007)',                            FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.BLOQUEIO_CADASTRO',           'CLIENT_WAREHOUSE', 'Bloqueio/desbloqueio de cadastro (RF-DAD-052)',               TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('SEG.CONSULTA_AUDITORIA',          'WAREHOUSE',        'Consulta e exportacao da trilha de auditoria (DOC-12 §4.4)',  TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('SEG.GESTAO_PAPEIS',               'GLOBAL',           'Gestao de papeis e permissoes (DOC-12 §4.2)',                 TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('SEG.GESTAO_ATRIBUICOES',          'GLOBAL',           'Gestao de atribuicoes usuario x papel x escopo (DOC-12 §4.2)',TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('SEG.APROVACAO_EXCECAO',           'CLIENT_WAREHOUSE', 'Aprovacao/rejeicao de excecao operacional (DOC-12 §4.5)',    TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Catalogo DAD.* desta sessao: DOC-02 (Sessoes 2A/2B) deixou
-- [LACUNA: RBAC DOC-12] em todos os controllers sem declarar codigos de
-- permissao propriamente ditos. Estes sao DECLARADOS agora, consolidando
-- por dominio de entidade (nao 1 permissao por rota/verbo HTTP -- reduz o
-- catalogo a um tamanho gerenciavel, no mesmo espirito dos exemplos de
-- RD-SEG-014 que tambem agrupam por capacidade, nao por tabela).
-- [LACUNA: DOC-02 nao declarou estes codigos -- nomes/escopo sao decisao
-- desta sessao, nao valores extraidos do documento.]
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('DAD.WAREHOUSE_MANAGE',                  'GLOBAL',           'CRUD de warehouse (DOC-02 §5.2)',                                    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.PHYSICAL_STRUCTURE_MANAGE',         'WAREHOUSE',        'CRUD de zone/storage_equipment/location/dock/yard_slot (DOC-02 §5.2)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.CLIENT_MANAGE',                     'GLOBAL',           'CRUD de client (DOC-02 §5.1)',                                       FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE',  'CLIENT_WAREHOUSE', 'CRUD de client_warehouse_settings (DOC-02 §5.1)',                    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.LOGICAL_WAREHOUSE_MANAGE',          'CLIENT_WAREHOUSE', 'CRUD de logical_warehouse + vinculo de enderecos (DOC-02 §5.1)',     FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.PRODUCT_CATALOG_MANAGE',            'CLIENT_WAREHOUSE', 'CRUD de product/product_packaging/product_barcode (DOC-02 §5.3)',    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DAD.BATCH_MANAGE',                      'CLIENT_WAREHOUSE', 'CRUD de batch (DOC-02 §5.4)',                                        FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- POR.DADO_PESSOAL_COMPLETO: DOC-12 §4.6 (RN-SEG-051) referencia esta
-- permissao nominalmente ("declarada no DOC-03") e a usa no proprio
-- criterio de aceite (§6, mascaramento de CPF). DOC-03 (Portaria) nao
-- existe nesta sessao para declara-la "oficialmente" -- inserida aqui
-- citando a fonte exata (DOC-12 §4.6/§6), nao inventada. Escopo WAREHOUSE
-- por ser tipicamente uma operacao de portaria por armazem.
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('POR.DADO_PESSOAL_COMPLETO', 'WAREHOUSE', 'Exibicao de CPF/CNH completos sem mascaramento (DOC-12 RN-SEG-051)', TRUE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- RN-SEG-012 exige declaracao de permissao tambem em handlers WebSocket
-- (realtime.gateway.ts). DOC-12 nao declara codigos especificos para
-- subscribe/resync -- inseridos aqui como capacidade minima transversal,
-- analoga aos demais codigos de RD-SEG-014. [LACUNA: DOC-12 nao define
-- granularidade de permissao por topico de realtime.]
-- Escopo WAREHOUSE (nao GLOBAL): assinar tempo real e uma capacidade por
-- armazem, nao administrativa. Importante tambem por efeito colateral:
-- RF-SEG-005 exige MFA para QUALQUER permissao de escopo GLOBAL -- se
-- estas fossem GLOBAL e concedidas a todo papel interno (como sao), TODO
-- usuario interno passaria a exigir MFA so por poder assinar um topico de
-- WebSocket, o que nao e a intencao de RF-SEG-005.
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('SEG.REALTIME_SUBSCRIBE', 'WAREHOUSE', 'Assinar topicos de tempo real via WebSocket (RF-ARQ-041)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('SEG.REALTIME_RESYNC',    'WAREHOUSE', 'Resincronizar historico de eventos via WebSocket (RF-ARQ-043)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- role — RD-SEG-010
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT role_code_unique UNIQUE (code),
  CONSTRAINT role_area_check CHECK (area IN ('INTERNAL', 'CLIENT_PORTAL')),
  CONSTRAINT role_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.role TO wms_app;

-- RF-SEG-013: papeis semente (13 codigos EXATOS do documento). Composicao
-- de permissoes: DOC-12 refere um "anexo gerado ao final da especificacao,
-- consolidando os catalogos dos modulos" que NAO esta presente no DOC-12
-- fornecido nesta sessao -- [LACUNA: anexo RF-SEG-013 ausente]. Mapeamento
-- de permissoes feito abaixo (bloco role_permission) apenas onde o proprio
-- DOC-12 da sinal direto (ex.: RN-SEG-021 cita GESTOR_ARMAZEM como alvo do
-- escalonamento; DOC-12 §3 descreve ADMIN_SEGURANCA); os demais papeis sao
-- criados SEM permissoes, documentado como debito no relatorio.
INSERT INTO wms.role (code, name, area, created_by) VALUES
  ('ADMIN_SISTEMA',           'Administrador de Sistema',       'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('ADMIN_SEGURANCA',         'Administrador de Seguranca',     'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('GESTOR_ARMAZEM',          'Gestor de Armazem',              'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('LIDER_TURNO',             'Lider de Turno',                 'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('PORTEIRO',                'Porteiro',                       'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('CONFERENTE',              'Conferente',                     'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('OPERADOR_EMPILHADEIRA',   'Operador de Empilhadeira',       'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('OPERADOR_PICKING',        'Operador de Picking',            'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('FATURISTA',               'Faturista',                      'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('FISCAL',                  'Fiscal',                         'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('INVENTARIANTE',           'Inventariante',                  'INTERNAL',      '00000000-0000-0000-0000-000000000001'),
  ('CLIENTE_CONSULTA',        'Cliente - Consulta',             'CLIENT_PORTAL', '00000000-0000-0000-0000-000000000001'),
  ('CLIENTE_OPERACAO',        'Cliente - Operacao',             'CLIENT_PORTAL', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- role_permission — vinculo N:N (RD-SEG-010)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.role_permission (
  role_id UUID NOT NULL REFERENCES wms.role(id) ON DELETE RESTRICT,
  permission_code TEXT NOT NULL REFERENCES wms.permission(code) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  PRIMARY KEY (role_id, permission_code)
);

GRANT SELECT, INSERT, UPDATE ON wms.role_permission TO wms_app;

-- ADMIN_SISTEMA: TODAS as permissoes de escopo GLOBAL (necessidade de
-- bootstrap -- sem isso, nenhum usuario poderia conceder a primeira
-- atribuicao do sistema). Deliberadamente NAO inclui permissoes
-- WAREHOUSE/CLIENT_WAREHOUSE: um "administrador de sistema" gerencia
-- configuracao global (papeis, armazens, clientes), nao operacao do
-- dia-a-dia por armazem -- e, por RD-SEG-010, so pode ser atribuido SEM
-- warehouse_id/client_id se o papel so contiver permissoes GLOBAL (o
-- trigger user_role_assignment_validate abaixo aplica exatamente essa
-- regra). [LACUNA: nao e um valor do "anexo" ausente do RF-SEG-013, e uma
-- decisao de bootstrap documentada aqui.]
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN wms.permission p
WHERE r.code = 'ADMIN_SISTEMA' AND p.scope = 'GLOBAL'
ON CONFLICT DO NOTHING;

-- ADMIN_SEGURANCA: DOC-12 §3 "Gestao de papeis, atribuicoes, alcadas,
-- consulta de auditoria".
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('SEG.GESTAO_PAPEIS'), ('SEG.GESTAO_ATRIBUICOES'), ('SEG.CONSULTA_AUDITORIA')
) AS p(code)
WHERE r.code = 'ADMIN_SEGURANCA'
ON CONFLICT DO NOTHING;

-- GESTOR_ARMAZEM: alvo do escalonamento automatico (RN-SEG-021) --
-- precisa poder aprovar excecoes e usar os overrides operacionais mais
-- comuns do proprio armazem.
-- POR.DADO_PESSOAL_COMPLETO incluida aqui: DOC-12 nao diz qual papel a
-- recebe (declarada "no DOC-03", RD-SEG-050/051), mas GESTOR_ARMAZEM e um
-- alvo razoavel (supervisiona a portaria do proprio armazem).
-- [LACUNA: composicao real definida quando o DOC-03 existir.]
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('SEG.APROVACAO_EXCECAO'), ('SEG.CONSULTA_AUDITORIA'),
  ('EST.PUTAWAY_OVERRIDE'), ('EST.QUEBRA_POLITICA_GIRO'),
  ('EST.LOGICAL_WAREHOUSE_OVERFLOW'), ('EST.VINCULO_ARMAZEM_LOGICO'),
  ('DAD.BLOQUEIO_CADASTRO'), ('POR.DADO_PESSOAL_COMPLETO')
) AS p(code)
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- CONFERENTE: DOC-04 (Recebimento/Conferencia) ainda nao existe nesta
-- sessao, entao nao ha catalogo REC.* real. Usa-se DAD.PRODUCT_CATALOG_MANAGE
-- como capacidade CLIENT_WAREHOUSE concreta para exercitar a resolucao
-- multi-dimensional (RN-SEG-011) nos testes desta sessao.
-- [LACUNA: permissoes reais de CONFERENTE dependem do catalogo REC.* do DOC-04]
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('DAD.PRODUCT_CATALOG_MANAGE')) AS p(code)
WHERE r.code = 'CONFERENTE'
ON CONFLICT DO NOTHING;

-- Concede as permissoes de realtime aos papeis internos OPERACIONAIS
-- (capacidade basica, nao administrativa) -- EXCLUI ADMIN_SISTEMA de
-- proposito: mante-lo com permissoes exclusivamente GLOBAL e o que permite
-- atribui-lo sem warehouse_id/client_id (RD-SEG-010, ver nota acima sobre
-- o proprio ADMIN_SISTEMA). Um administrador de sistema que precisar
-- assinar tempo real de um armazem especifico recebe uma atribuicao
-- adicional com warehouse_id, como qualquer outro papel WAREHOUSE.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('SEG.REALTIME_SUBSCRIBE'), ('SEG.REALTIME_RESYNC')) AS p(code)
WHERE r.area = 'INTERNAL' AND r.code <> 'ADMIN_SISTEMA'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- user_role_assignment — RD-SEG-010
-- UNIQUE(user_id, role_id, warehouse_id, client_id): implementado
-- literalmente; NULL != NULL em UNIQUE do Postgres (mesma nuance ja
-- documentada em wms.stock_balance, Sessao 2B), nao contornada aqui.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.user_role_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  role_id UUID NOT NULL REFERENCES wms.role(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  client_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  valid_from DATE,
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT user_role_assignment_unique UNIQUE (user_id, role_id, warehouse_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignment_user ON wms.user_role_assignment (user_id);

GRANT SELECT, INSERT, UPDATE ON wms.user_role_assignment TO wms_app;

-- Validacoes cruzadas (nao expressaveis em CHECK simples -- dependem de
-- outras tabelas): RD-SEG-010 (warehouse_id/client_id NULL somente quando
-- o papel so contem permissoes de escopo mais amplo) + decisao de
-- modelagem desta sessao (role.area = user.area, RF-SEG-006).
CREATE OR REPLACE FUNCTION wms.validate_user_role_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_area TEXT;
  v_user_area TEXT;
  v_has_non_global BOOLEAN;
  v_has_client_warehouse BOOLEAN;
BEGIN
  SELECT area INTO v_role_area FROM wms.role WHERE id = NEW.role_id;
  SELECT area INTO v_user_area FROM wms.user WHERE id = NEW.user_id;

  IF v_role_area IS DISTINCT FROM v_user_area THEN
    RAISE EXCEPTION 'RF-SEG-006: role area (%) must match user area (%)', v_role_area, v_user_area
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM wms.role_permission rp JOIN wms.permission p ON p.code = rp.permission_code
    WHERE rp.role_id = NEW.role_id AND p.scope <> 'GLOBAL'
  ) INTO v_has_non_global;

  IF NEW.warehouse_id IS NULL AND v_has_non_global THEN
    RAISE EXCEPTION 'RD-SEG-010: warehouse_id is required — role has non-GLOBAL permissions'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM wms.role_permission rp JOIN wms.permission p ON p.code = rp.permission_code
    WHERE rp.role_id = NEW.role_id AND p.scope = 'CLIENT_WAREHOUSE'
  ) INTO v_has_client_warehouse;

  IF NEW.client_id IS NULL AND v_has_client_warehouse THEN
    RAISE EXCEPTION 'RD-SEG-010: client_id is required — role has CLIENT_WAREHOUSE permissions'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER user_role_assignment_validate
  BEFORE INSERT OR UPDATE ON wms.user_role_assignment
  FOR EACH ROW EXECUTE FUNCTION wms.validate_user_role_assignment();

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (16, 'DOC-12 RBAC: permission, role, role_permission, user_role_assignment (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
