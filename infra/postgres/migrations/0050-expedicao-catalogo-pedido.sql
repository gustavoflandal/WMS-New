-- Migration: 0050
-- DOC-06 §3/§4.1/§4.3/§7 — Sessão 6A: catálogo EXP.* (permissões e exceções),
-- wms.outbound_order + wms.outbound_order_item (RD-EXP-001), wms.wave +
-- wms.wave_order (RD-EXP-003) e a extensão de wms.flow_step para a regra 5 de
-- RN-EXP-011 (exceção vinculada mantém a etapa vermelha).
--
-- CONSOLIDAÇÃO DE operation_flow (RD-EXP-002): a estrutura genérica
-- wms.operation_flow + wms.flow_step JÁ EXISTE desde a migration 0034
-- (Sessão 4A, DOC-04 RF-REC-020), criada explicitamente como "máquina de
-- fluxo genérica reutilizável entre módulos". NÃO é criada uma segunda:
-- esta migration apenas ESTENDE o que falta para o DOC-06 (vínculo de
-- exceção por etapa). Ver relatório da sessão para a análise completa.

-- =============================================================================
-- 1. Permissões EXP.* — DOC-06 §3 (valores EXATOS da tabela)
-- A tabela do §3 tem 8 LINHAS, mas duas delas contêm 2 códigos cada
-- ("EXP.PEDIDO_LIBERAR / EXP.ONDA_GERIR" e "EXP.PICKING_EXECUTAR /
-- EXP.PACKING_EXECUTAR") — são 10 códigos distintos, implementados aqui.
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('EXP.PEDIDO_CRIAR',          'CLIENT_WAREHOUSE', 'Criacao de pedido de saida (DOC-06 RF-EXP-001)',            FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.PEDIDO_LIBERAR',        'CLIENT_WAREHOUSE', 'Liberacao de pedido (DOC-06 RN-EXP-002/003)',               FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.ONDA_GERIR',            'CLIENT_WAREHOUSE', 'Formacao e liberacao de ondas (DOC-06 RF-EXP-020)',         FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.PICKING_EXECUTAR',      'CLIENT_WAREHOUSE', 'Execucao de picking (DOC-06 RF-EXP-031)',                   FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.PACKING_EXECUTAR',      'CLIENT_WAREHOUSE', 'Execucao de packing/volumacao (DOC-06 RF-EXP-040)',         FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.PESAGEM_EXECUTAR',      'WAREHOUSE',        'Pesagem de volumes (DOC-06 RF-EXP-050)',                    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.EXPEDICAO_LIBERAR',     'CLIENT_WAREHOUSE', 'Etapa de expedicao documental (DOC-06 RF-EXP-060)',         FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.CARREGAMENTO_EXECUTAR', 'WAREHOUSE',        'Carregamento de volumes no veiculo (DOC-06 RF-EXP-061)',    FALSE, '00000000-0000-0000-0000-000000000001'),
  ('EXP.PEDIDO_CANCELAR',       'CLIENT_WAREHOUSE', 'Cancelamento de pedido (DOC-06 RN-EXP-071)',                TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('EXP.ESTORNO',               'CLIENT_WAREHOUSE', 'Estorno de etapa do fluxo (DOC-06 RN-EXP-070)',             TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Atribuição a papéis de seed. DOC-06 §3 NOMEIA o ator típico de cada
-- interação (diferente do DOC-05 §3, onde a atribuição foi [LACUNA]): a
-- tabela "Atores e permissões" liga Cliente→criação/acompanhamento,
-- Líder de Turno→ondas/liberação/exceções/estornos, Operador de
-- Picking→picking e packing, Conferente→pesagem e conferência de
-- carregamento, Faturista→etapa Expedição. As atribuições abaixo seguem
-- essa tabela literalmente.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EXP.PEDIDO_CRIAR')) AS p(code)
WHERE r.code IN ('CLIENTE_OPERACAO', 'LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- "Líder de Turno: Ondas, liberação, exceções, estornos" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES
  ('EXP.PEDIDO_LIBERAR'), ('EXP.ONDA_GERIR'), ('EXP.ESTORNO'), ('EXP.PEDIDO_CANCELAR')
) AS p(code)
WHERE r.code IN ('LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- "Operador de Picking: Execução de picking e packing" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EXP.PICKING_EXECUTAR'), ('EXP.PACKING_EXECUTAR')) AS p(code)
WHERE r.code IN ('OPERADOR_PICKING', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- "Conferente de Expedição: Pesagem, conferência de carregamento" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EXP.PESAGEM_EXECUTAR'), ('EXP.CARREGAMENTO_EXECUTAR')) AS p(code)
WHERE r.code IN ('CONFERENTE', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- "Faturista: Etapa Expedição (documentos)" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('EXP.EXPEDICAO_LIBERAR')) AS p(code)
WHERE r.code IN ('FATURISTA', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. Exceções EXP.* — DOC-06 §3 (Passos | Motivo obrigatório | Expira em)
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('EXP.CORTE_PICKING',     'Corte de picking (RN-EXP-032)',              1, TRUE, 8,  '00000000-0000-0000-0000-000000000001'),
  ('EXP.DIVERGENCIA_PESO',  'Divergencia de peso (RN-EXP-051)',           1, TRUE, 8,  '00000000-0000-0000-0000-000000000001'),
  ('EXP.ESTORNO_PICKING',   'Estorno de picking/embalagem (RN-EXP-070)',  1, TRUE, 8,  '00000000-0000-0000-0000-000000000001'),
  ('EXP.ESTORNO_POS_FISCAL','Estorno pos-fiscal (RN-EXP-070)',            2, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('EXP.CANCELAMENTO_TARDIO','Cancelamento tardio de pedido (RN-EXP-071)', 2, TRUE, 24, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 3. Parâmetros — DOC-06 §7
-- NOT EXISTS em vez de ON CONFLICT: wms.app_parameter (migration 0004) não tem
-- UNIQUE em (scope, name) — ON CONFLICT sem alvo nunca dispara e a reexecução
-- duplicaria a linha (achado registrado no relatório da Sessão 4B).
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value)
SELECT 'GLOBAL', 'EXP.PERMITE_LIBERACAO_PARCIAL', 'true'
WHERE NOT EXISTS (SELECT 1 FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.PERMITE_LIBERACAO_PARCIAL');

INSERT INTO wms.app_parameter (scope, name, value)
SELECT 'GLOBAL', 'EXP.RESERVA_VALIDADE_H', '72'
WHERE NOT EXISTS (SELECT 1 FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.RESERVA_VALIDADE_H');

INSERT INTO wms.app_parameter (scope, name, value)
SELECT 'GLOBAL', 'EXP.ONDA_MAX_PEDIDOS', '200'
WHERE NOT EXISTS (SELECT 1 FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.ONDA_MAX_PEDIDOS');

-- =============================================================================
-- 4. RD-EXP-001 — wms.outbound_order (TENANT, RLS). Estados: §5.1 EXATOS.
--
-- `RELEASED_EXPIRED` NÃO é valor do enum: o §5.1 diz literalmente que é
-- "substado de RELEASED exibido como alerta", e ele não aparece no diagrama
-- de estados. REG-GLO-004 [INVIOLÁVEL] proíbe criar estados ausentes do
-- diagrama. Modelado como o par (status = 'RELEASED', reservation_expired =
-- TRUE); a API o expõe como estado DERIVADO 'RELEASED_EXPIRED' para o
-- consumidor, sem inventar um estado persistido.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.outbound_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,                         -- máscara PED (RN-DAD-040)
  status TEXT NOT NULL DEFAULT 'DRAFT',
  -- RN-EXP-003: reserva expirada devolve o pedido a RELEASED_EXPIRED
  -- (substado de RELEASED — ver comentário acima).
  reservation_expired BOOLEAN NOT NULL DEFAULT FALSE,
  reserved_at TIMESTAMPTZ,
  -- RF-EXP-001: destinatário e previsão. Dados fiscais do destinatário são
  -- do DOC-08 (emissão própria) — aqui só o mínimo que o §4.1 nomeia.
  recipient_name TEXT,
  recipient_document TEXT,
  expected_dispatch_date DATE,
  carrier_name TEXT,
  -- Vínculo opcional a Agendamento outbound (DOC-03).
  appointment_id UUID REFERENCES wms.appointment(id) ON DELETE RESTRICT,
  -- RN-EXP-002: liberação parcial gera pedido remanescente VINCULADO.
  remainder_of_order_id UUID REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  wave_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  released_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT outbound_order_number_unique UNIQUE (number),
  -- §5.1 — estados canônicos, valores EXATOS do diagrama.
  CONSTRAINT outbound_order_status_check CHECK (status IN (
    'DRAFT', 'RELEASED', 'IN_PICKING', 'PICKED', 'IN_PACKING', 'PACKED',
    'WEIGHED', 'IN_DISPATCH', 'IN_LOADING', 'LOADED', 'GATE_OUT',
    'COMPLETED', 'CANCELLED'
  )),
  -- O substado só faz sentido sobre RELEASED.
  CONSTRAINT outbound_order_reservation_expired_check CHECK (NOT reservation_expired OR status = 'RELEASED')
);

CREATE INDEX IF NOT EXISTS idx_outbound_order_tenant_status ON wms.outbound_order (tenant_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_outbound_order_wave ON wms.outbound_order (wave_id);

ALTER TABLE wms.outbound_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.outbound_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_order_tenant_isolation ON wms.outbound_order;
CREATE POLICY outbound_order_tenant_isolation ON wms.outbound_order
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.outbound_order TO wms_app;
-- RN-EXP-003: o job de expiração de reserva roda no scheduler (cross-tenant).
GRANT SELECT, UPDATE ON wms.outbound_order TO wms_worker;

-- =============================================================================
-- RD-EXP-001 — wms.outbound_order_item
-- "item: pedido, reservado, separado, cortado, embalado" (§7)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.outbound_order_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  outbound_order_id UUID NOT NULL REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  line_number INT NOT NULL,
  -- RF-EXP-001: quantidade na UNIDADE BASE. Quando o pedido chega em
  -- embalagem, a conversão RN-DAD-021 (qty_in_base_uom) é aplicada na
  -- criação e o par informado fica registrado para rastreabilidade.
  qty_ordered NUMERIC(18,6) NOT NULL,
  source_packaging_id UUID REFERENCES wms.product_packaging(id) ON DELETE RESTRICT,
  source_qty NUMERIC(18,6),
  qty_reserved NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_picked NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_short NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_packed NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- RN-EXP-002 (liberação parcial): o item que não pôde ser liberado MIGRA
  -- para o pedido remanescente. O item original NÃO é apagado — DELETE é
  -- proibido em tabela de negócio (RG-003: rastreabilidade total; ver
  -- core/database/__tests__/business-table-delete-denied.integration.spec.ts)
  -- — fica com o vínculo para onde foi, e some das leituras do pedido por
  -- `moved_to_order_id IS NULL`. Preserva o histórico do que foi pedido
  -- originalmente, que é justamente o que a proibição de DELETE protege.
  moved_to_order_id UUID REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT outbound_order_item_line_unique UNIQUE (outbound_order_id, line_number),
  CONSTRAINT outbound_order_item_qty_check CHECK (qty_ordered > 0),
  CONSTRAINT outbound_order_item_reserved_check CHECK (qty_reserved >= 0),
  CONSTRAINT outbound_order_item_picked_check CHECK (qty_picked >= 0),
  CONSTRAINT outbound_order_item_short_check CHECK (qty_short >= 0),
  CONSTRAINT outbound_order_item_packed_check CHECK (qty_packed >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outbound_order_item_order ON wms.outbound_order_item (outbound_order_id);

ALTER TABLE wms.outbound_order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.outbound_order_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_order_item_tenant_isolation ON wms.outbound_order_item;
CREATE POLICY outbound_order_item_tenant_isolation ON wms.outbound_order_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.outbound_order_item TO wms_app;
-- RN-EXP-003: o job de expiração zera o reservado dos itens (cross-tenant).
GRANT SELECT, UPDATE ON wms.outbound_order_item TO wms_worker;

-- RN-EXP-003: o job também encerra as linhas de reserva (wms.stock_reservation,
-- migration 0049) ao devolver o saldo — até aqui essa tabela só era escrita
-- em contexto de request.
GRANT SELECT, UPDATE ON wms.stock_reservation TO wms_worker;

-- =============================================================================
-- 5. RD-EXP-003 — wms.wave + wms.wave_order (§4.3)
-- "filtros aplicados, pedidos, estado" (§7). Os pedidos da onda ficam numa
-- tabela de vínculo em vez de array em wave: o pedido também referencia a
-- onda (outbound_order.wave_id) e a tabela de vínculo guarda a ORDEM de
-- entrada, que o sequenciamento do picking (6B) vai consumir.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.wave (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  -- Filtros que formaram a onda (§4.3: cliente, transportadora, agendamento,
  -- zona de picking, data prevista), guardados como aplicados.
  filters JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  released_at TIMESTAMPTZ,
  CONSTRAINT wave_status_check CHECK (status IN ('CREATED', 'RELEASED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_wave_tenant_status ON wms.wave (tenant_id, warehouse_id, status);

ALTER TABLE wms.wave ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.wave FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wave_tenant_isolation ON wms.wave;
CREATE POLICY wave_tenant_isolation ON wms.wave
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.wave TO wms_app;

CREATE TABLE IF NOT EXISTS wms.wave_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  wave_id UUID NOT NULL REFERENCES wms.wave(id) ON DELETE RESTRICT,
  outbound_order_id UUID NOT NULL REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  sequence_order INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  -- RF-EXP-020: um pedido pertence a no máximo uma onda.
  CONSTRAINT wave_order_unique UNIQUE (outbound_order_id)
);

CREATE INDEX IF NOT EXISTS idx_wave_order_wave ON wms.wave_order (wave_id, sequence_order);

ALTER TABLE wms.wave_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.wave_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wave_order_tenant_isolation ON wms.wave_order;
CREATE POLICY wave_order_tenant_isolation ON wms.wave_order
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.wave_order TO wms_app;

-- FK de outbound_order.wave_id só agora, depois de wms.wave existir.
ALTER TABLE wms.outbound_order DROP CONSTRAINT IF EXISTS outbound_order_wave_fk;
ALTER TABLE wms.outbound_order ADD CONSTRAINT outbound_order_wave_fk
  FOREIGN KEY (wave_id) REFERENCES wms.wave(id) ON DELETE RESTRICT;

-- =============================================================================
-- 6. RN-EXP-011 regra 5 — "exceção PENDING/ESCALATED vinculada à etapa mantém
-- a etapa VERMELHA com indicador de bloqueio (RN-SEG-042)".
--
-- wms.flow_step (migration 0034) não tinha como saber que está bloqueada por
-- uma exceção. Coluna ADITIVA (NULLable): fluxos existentes do DOC-04 seguem
-- funcionando sem nenhuma mudança de comportamento — a etapa só é reportada
-- como bloqueada quando o vínculo é explicitamente gravado.
-- =============================================================================
ALTER TABLE wms.flow_step ADD COLUMN IF NOT EXISTS blocking_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_flow_step_blocking_exception ON wms.flow_step (blocking_exception_id) WHERE blocking_exception_id IS NOT NULL;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (50, 'DOC-06 6A: catalogo EXP.* (10 permissoes/5 excecoes/3 parametros) + outbound_order(_item) + wave(_order) + blocking_exception_id em flow_step', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
