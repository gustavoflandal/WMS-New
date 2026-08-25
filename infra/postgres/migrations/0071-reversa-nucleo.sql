-- Migration: 0071
-- DOC-07 — Sessão 9A: núcleo da Logística Reversa. Catálogo REV.* (3
-- permissões, 1 exceção), wms.return_order + wms.return_order_item
-- (RD-REV-001) e wms.triage_record (RD-REV-002).
--
-- ESCOPO 9A (ver docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md): só os tipos
-- de Ordem que 9A de fato cria (`DEVOLUCAO_CLIENTE_FINAL`,
-- `AVARIA_TRANSPORTE`, `REVERSA_AVULSA`) entram no CHECK. `RECUSA_ENTREGA`
-- (gate-in automático) e `RECALL` (RF-REV-030) são 9B — mesmo padrão de "tipo
-- não implementado não aparece" já usado em operations-board.service.ts.
-- wms.recall (RD-REV-003) também fica para a migration da 9B.

-- =============================================================================
-- 1. Permissões REV.* — DOC-07 §3
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('REV.AUTORIZAR',   'CLIENT_WAREHOUSE', 'Autorizacao de Ordem de Devolucao (DOC-07 RN-REV-002)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REV.TRIAGEM',     'CLIENT_WAREHOUSE', 'Registro de triagem por item (DOC-07 RF-REV-020)',       FALSE, '00000000-0000-0000-0000-000000000001'),
  ('REV.DESTINACAO',  'CLIENT_WAREHOUSE', 'Confirmacao de destinacao (DOC-07 RN-REV-021/022)',      FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- "Cliente (portal/API): Autorizacao de devolucoes" (§3) — interno com a
-- permissao tambem pode autorizar (RN-REV-002: "ou de interno com a
-- permissao + registro da anuencia do cliente").
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('REV.AUTORIZAR')) AS p(code)
WHERE r.code IN ('CLIENTE_OPERACAO', 'LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- "Conferente: Descarga e triagem" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('REV.TRIAGEM')) AS p(code)
WHERE r.code IN ('CONFERENTE', 'LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- "Lider de Turno: Excecoes, destinacoes" (§3).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('REV.DESTINACAO')) AS p(code)
WHERE r.code IN ('LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. Excecao REV.ITEM_NAO_EXPEDIDO — DOC-07 §3 (Passos 1 | motivo obrigatorio
-- | expira 24h). REV.SEM_AUTORIZACAO fica para a 9B (so tem chamador no
-- gate-in de devolucao). REV.REINTEGRACAO_VENCIDO NAO e catalogada: a propria
-- tabela do §3 marca "PROIBIDA, sem excecao" — bloqueio de codigo, nao workflow.
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('REV.ITEM_NAO_EXPEDIDO', 'Item fora do pedido de origem (DOC-07 RN-REV-003)', 1, TRUE, 24, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 3. RD-REV-001 — wms.return_order (TENANT, RLS). Estados: DOC-07 §5.1 EXATOS.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.return_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,                          -- mascara DEV (RN-DAD-040)
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  -- RF-REV-001: DEVOLUCAO_CLIENTE_FINAL/AVARIA_TRANSPORTE exigem vinculo ao
  -- Pedido de origem; REVERSA_AVULSA nao tem pedido no sistema.
  source_outbound_order_id UUID REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  vehicle_visit_id UUID REFERENCES wms.vehicle_visit(id) ON DELETE RESTRICT,
  dock_id UUID REFERENCES wms.dock(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL,
  authorized_by UUID,
  authorized_at TIMESTAMPTZ,
  denied_by UUID,
  denied_at TIMESTAMPTZ,
  denied_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  -- RN-REV-023: a etapa Destinacao so conclui com o tratamento fiscal
  -- registrado (ou dispensado em INTEGRADO_ERP/REVERSA_AVULSA).
  fiscal_treatment_done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT return_order_number_unique UNIQUE (number),
  CONSTRAINT return_order_type_check CHECK (type IN ('DEVOLUCAO_CLIENTE_FINAL', 'AVARIA_TRANSPORTE', 'REVERSA_AVULSA')),
  CONSTRAINT return_order_status_check CHECK (status IN (
    'REQUESTED', 'AUTHORIZED', 'IN_RECEIPT', 'IN_TRIAGE', 'IN_DISPOSITION', 'COMPLETED', 'DENIED', 'CANCELLED'
  )),
  -- RF-REV-001: so REVERSA_AVULSA pode nao ter pedido de origem.
  CONSTRAINT return_order_source_required_check CHECK (type = 'REVERSA_AVULSA' OR source_outbound_order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_return_order_tenant_status ON wms.return_order (tenant_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_return_order_source ON wms.return_order (source_outbound_order_id) WHERE source_outbound_order_id IS NOT NULL;

ALTER TABLE wms.return_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.return_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS return_order_tenant_isolation ON wms.return_order;
CREATE POLICY return_order_tenant_isolation ON wms.return_order
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.return_order TO wms_app;

-- =============================================================================
-- RD-REV-001 — wms.return_order_item
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.return_order_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  return_order_id UUID NOT NULL REFERENCES wms.return_order(id) ON DELETE RESTRICT,
  line_number INT NOT NULL,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  -- RN-REV-003: item do pedido de origem que esta linha devolve. NULL para
  -- REVERSA_AVULSA (sem pedido no sistema) e para item aprovado por
  -- REV.ITEM_NAO_EXPEDIDO (fora do pedido de origem).
  source_outbound_order_item_id UUID REFERENCES wms.outbound_order_item(id) ON DELETE RESTRICT,
  qty_authorized NUMERIC(18,6) NOT NULL,
  qty_received NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT return_order_item_line_unique UNIQUE (return_order_id, line_number),
  CONSTRAINT return_order_item_qty_authorized_check CHECK (qty_authorized > 0),
  CONSTRAINT return_order_item_qty_received_check CHECK (qty_received >= 0)
);

CREATE INDEX IF NOT EXISTS idx_return_order_item_order ON wms.return_order_item (return_order_id);
CREATE INDEX IF NOT EXISTS idx_return_order_item_source ON wms.return_order_item (source_outbound_order_item_id) WHERE source_outbound_order_item_id IS NOT NULL;

ALTER TABLE wms.return_order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.return_order_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS return_order_item_tenant_isolation ON wms.return_order_item;
CREATE POLICY return_order_item_tenant_isolation ON wms.return_order_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.return_order_item TO wms_app;

-- =============================================================================
-- 4. RD-REV-002 — wms.triage_record. Fotos: mesma convencao de
-- wms.discrepancy.photo_keys (migration 0038) — TEXT[] sem FK, CHECK de
-- obrigatoriedade quando o estado fisico nao e INTEGRO (RF-REV-020).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.triage_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  return_order_id UUID NOT NULL REFERENCES wms.return_order(id) ON DELETE RESTRICT,
  return_order_item_id UUID NOT NULL REFERENCES wms.return_order_item(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  -- RN-REV-020: lote ilegivel/ausente -> lote provisorio DEV-<ordem>-<seq>,
  -- que E um wms.batch real (para poder ser referenciado por stock_balance/
  -- stock_movement) marcado aqui como provisorio, para rastreabilidade.
  batch_provisional BOOLEAN NOT NULL DEFAULT FALSE,
  qty NUMERIC(18,6) NOT NULL,
  physical_state TEXT NOT NULL,
  photo_keys TEXT[] NOT NULL DEFAULT '{}',
  disposition_suggested TEXT NOT NULL,
  -- RN-REV-021 (bloqueio absoluto): TRUE quando o item está vencido, ou
  -- íntegro porém abaixo do shelf life mínimo — nesses dois casos,
  -- REINTEGRAR nunca pode ser confirmado, nem por decisão do cliente.
  -- Calculado e gravado na triagem (não recomputado na destinação) para não
  -- depender de reconsultar lote/produto e arriscar divergir do que foi
  -- efetivamente mostrado ao conferente. MEDICAMENTO e lote provisório
  -- também sugerem QUARENTENA mas NÃO ativam este bloqueio — podem
  -- reintegrar após liberação de qualidade (RN-REV-021 nota de rodapé).
  shelf_life_blocks_reintegration BOOLEAN NOT NULL DEFAULT FALSE,
  disposition_confirmed TEXT,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT triage_record_qty_check CHECK (qty > 0),
  CONSTRAINT triage_record_physical_state_check CHECK (physical_state IN ('INTEGRO', 'EMBALAGEM_VIOLADA', 'DANIFICADO', 'VENCIDO')),
  CONSTRAINT triage_record_disposition_suggested_check CHECK (disposition_suggested IN ('REINTEGRAR', 'AVARIA', 'QUARENTENA', 'DESCARTE', 'RETORNO_CLIENTE')),
  CONSTRAINT triage_record_disposition_confirmed_check CHECK (disposition_confirmed IS NULL OR disposition_confirmed IN ('REINTEGRAR', 'AVARIA', 'QUARENTENA', 'DESCARTE', 'RETORNO_CLIENTE')),
  CONSTRAINT triage_record_photo_required_check CHECK (physical_state = 'INTEGRO' OR cardinality(photo_keys) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_triage_record_order ON wms.triage_record (return_order_id);
CREATE INDEX IF NOT EXISTS idx_triage_record_item ON wms.triage_record (return_order_item_id);

ALTER TABLE wms.triage_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.triage_record FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS triage_record_tenant_isolation ON wms.triage_record;
CREATE POLICY triage_record_tenant_isolation ON wms.triage_record
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.triage_record TO wms_app;

-- =============================================================================
-- 5. RD-DAD-040 — mascara de numeracao 'RETURN_ORDER' -> prefixo DEV. Ja
-- cadastrada em document-numbering.service.ts (DocumentType); nada a alterar
-- aqui alem de confirmar (documentado no relatorio da sessao).
-- =============================================================================

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (71, 'DOC-07 9A: catalogo REV.* (3 permissoes/1 excecao) + return_order(_item) + triage_record', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
