-- Migration: 0044
-- DOC-05 §3 — Catálogo central do módulo Estoque/Movimentação: 8 permissões
-- EST.* (7 linhas da tabela §3; BLOQUEAR_SALDO/DESBLOQUEAR_SALDO somam 2
-- códigos distintos numa única linha), correção do exception_type
-- EST.QUEBRA_FEFO (placeholder da Sessão 3, migration 0018, para os valores
-- reais do §3) + 3 novos exception_type, e wms.stock_block_reason (RD-EST-004).

-- =============================================================================
-- 1. Permissões EST.* — DOC-05 §3 (valores EXATOS da tabela)
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('EST.TRANSFERIR_INTERNO',        'CLIENT_WAREHOUSE', 'Transferencia interna endereco/palete (DOC-05 RF-EST-050)',        FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.TRANSFERIR_ARMAZEM',        'CLIENT_WAREHOUSE', 'Transferencia entre armazens (DOC-05 RF-EST-051)',                 TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EST.BLOQUEAR_SALDO',            'CLIENT_WAREHOUSE', 'Bloqueio manual de saldo (DOC-05 RF-EST-030)',                     FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.DESBLOQUEAR_SALDO',         'CLIENT_WAREHOUSE', 'Desbloqueio manual de saldo (DOC-05 RF-EST-030)',                  FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.INVENTARIO_PLANEJAR',       'WAREHOUSE',         'Planejamento de inventario (DOC-05 RF-EST-060)',                   FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.INVENTARIO_CONTAR',         'CLIENT_WAREHOUSE', 'Execucao de contagem de inventario (DOC-05 RN-EST-062)',           FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EST.INVENTARIO_APROVAR_AJUSTE', 'CLIENT_WAREHOUSE', 'Aprovacao de ajuste de inventario (DOC-05 RN-EST-063)',            TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EST.DESCARTE',                  'CLIENT_WAREHOUSE', 'Descarte fisico de saldo (DOC-05 RF-EST-031)',                     TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Atribuição a papéis de seed: DOC-05 não nomeia o papel-alvo de cada
-- permissão (diferente de trechos do DOC-04 §3) — [LACUNA: composição por
-- papel é decisão desta sessão, não valor extraído do documento]. Segue a
-- mesma lógica categórica já usada nas migrations 0016/0043: GESTOR_ARMAZEM
-- acumula as capacidades sensíveis/de supervisão (já detém EST.PUTAWAY_OVERRIDE,
-- EST.QUEBRA_POLITICA_GIRO etc.); LIDER_TURNO acumula as operacionais do
-- dia a dia (mesmo papel que já decide exceções, §3 do DOC-04);
-- INVENTARIANTE (papel dedicado, migration 0016) recebe a contagem em si.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('EST.TRANSFERIR_ARMAZEM'), ('EST.BLOQUEAR_SALDO'), ('EST.DESBLOQUEAR_SALDO'),
  ('EST.INVENTARIO_PLANEJAR'), ('EST.INVENTARIO_APROVAR_AJUSTE'), ('EST.DESCARTE')
) AS p(code)
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EST.TRANSFERIR_INTERNO')) AS p(code)
WHERE r.code IN ('LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EST.INVENTARIO_CONTAR')) AS p(code)
WHERE r.code = 'INVENTARIANTE'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. Correção de EST.QUEBRA_FEFO + novos exception_type — DOC-05 §3
-- (valores EXATOS da tabela: Passos | Motivo obrigatório | Expira em)
-- =============================================================================
-- EST.QUEBRA_FEFO foi inserido na Sessão 3 (migration 0018) com valores
-- PLACEHOLDER (2 passos/24h), documentados explicitamente ali como
-- inferência provisória "até o DOC-05 ser implementado". O DOC-05 §3 real diz
-- 1 passo/8h — corrigido aqui via UPDATE idempotente (mesmo padrão já usado
-- para product_species.segregation_class na Sessão 4B, migration 0043).
-- Efeito colateral: apps/backend/src/core/workflow/__tests__/
-- two-step-distinct-approvers.integration.spec.ts, que exercitava o fluxo de
-- 2 passos sobre EST.QUEBRA_FEFO, foi migrado nesta sessão para
-- EST.DESCARTE_SALDO (que É 2 passos por definição real do §3) — não perde
-- cobertura, só troca de fixture.
UPDATE wms.exception_type
SET default_steps = 1, requires_reason = TRUE, auto_expire_hours = 8, updated_by = '00000000-0000-0000-0000-000000000001', updated_at = now()
WHERE code = 'EST.QUEBRA_FEFO'
  AND (default_steps IS DISTINCT FROM 1 OR requires_reason IS DISTINCT FROM TRUE OR auto_expire_hours IS DISTINCT FROM 8);

INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  -- "1 (2 acima da alçada)": default_steps fica 1 aqui; a escalada condicional
  -- para 2 passos quando acima da alçada é responsabilidade de
  -- approval_authority (limite de qty/valor por papel), não do exception_type
  -- em si — mesmo mecanismo genérico do OperationalExceptionService (DOC-12),
  -- não um campo novo. [LACUNA: DOC-05 não detalha COMO a alçada eleva de 1
  -- para 2 passos dinamicamente — implementado na Sessão 5A apenas o registro
  -- do catálogo; a resolução de alçada usa approval_authority.max_qty/max_value
  -- já existente, sem mecanismo de "passos dinâmicos" — ver relatório.]
  ('EST.AJUSTE_INVENTARIO',          'Ajuste de inventario (RN-EST-063)',                    1, TRUE, 48, '00000000-0000-0000-0000-000000000001'),
  ('EST.DESCARTE_SALDO',             'Descarte fisico de saldo (RF-EST-031)',                2, TRUE, 72, '00000000-0000-0000-0000-000000000001'),
  ('EST.TRANSBORDO_ARMAZEM_LOGICO',  'Transbordo de armazem logico (RG-015 item 3)',         1, TRUE, 8,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 3. wms.stock_block_reason (RD-EST-004) — catálogo GLOBAL, RF-EST-030
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.stock_block_reason (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  requires_text BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

GRANT SELECT, INSERT ON wms.stock_block_reason TO wms_app;

-- RF-EST-030: "motivo tipificado (VENCIDO, QUALIDADE, DIVERGENCIA,
-- ORDEM_CLIENTE, OUTRO+texto)".
INSERT INTO wms.stock_block_reason (code, description, requires_text, created_by) VALUES
  ('VENCIDO',       'Lote vencido (RN-EST-014)',                    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('QUALIDADE',     'Retencao por qualidade',                       FALSE, '00000000-0000-0000-0000-000000000001'),
  ('DIVERGENCIA',   'Divergencia identificada',                     FALSE, '00000000-0000-0000-0000-000000000001'),
  ('ORDEM_CLIENTE', 'Bloqueio a pedido do cliente',                 FALSE, '00000000-0000-0000-0000-000000000001'),
  ('OUTRO',         'Outro motivo (texto livre obrigatorio)',       TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (44, 'DOC-05 Sessao 5A: catalogo EST.* (permissoes/excecoes/stock_block_reason)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
