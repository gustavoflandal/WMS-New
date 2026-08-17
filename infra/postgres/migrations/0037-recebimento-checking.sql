-- Migration: 0037
-- DOC-04 RD-REC-003 — checking + checking_item (TENANT, RLS). "contagens
-- 1a/recontagem, conferentes, modo cego/informado" (RD-REC-003 observação).
-- checking = sessão de conferência da ordem (1:1 com inbound_order); cada
-- checking_item é UM EVENTO DE CONTAGEM (round 1 = primeira contagem,
-- round 2 = recontagem RN-REC-022) de um item específico, com o
-- conferente que a executou — um item divergente gera 2 linhas de
-- checking_item (uma por round), nunca sobrescreve a primeira.

CREATE TABLE IF NOT EXISTS wms.checking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  inbound_order_id UUID NOT NULL REFERENCES wms.inbound_order(id) ON DELETE RESTRICT,
  -- RF-REC-021: modo desta sessão. Snapshot inicial = inbound_order.
  -- blind_checking; troca pontual (REC.ENCERRAR_CONFERENCIA + motivo) altera
  -- só aqui, não retroage sobre outras ordens.
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  mode_switch_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  CONSTRAINT checking_order_unique UNIQUE (inbound_order_id),
  CONSTRAINT checking_mode_check CHECK (mode IN ('BLIND', 'INFORMED')),
  CONSTRAINT checking_status_check CHECK (status IN ('IN_PROGRESS', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_checking_tenant ON wms.checking (tenant_id);

ALTER TABLE wms.checking ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.checking FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checking_tenant_isolation ON wms.checking;
CREATE POLICY checking_tenant_isolation ON wms.checking
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.checking TO wms_app;

CREATE TABLE IF NOT EXISTS wms.checking_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  checking_id UUID NOT NULL REFERENCES wms.checking(id) ON DELETE RESTRICT,
  inbound_order_item_id UUID NOT NULL REFERENCES wms.inbound_order_item(id) ON DELETE RESTRICT,
  round INT NOT NULL,
  conferente_user_id UUID NOT NULL,
  qty_counted NUMERIC(18,6) NOT NULL,
  -- RN-REC-022 [INVIOLÁVEL]: recontagem exige conferente DIFERENTE do
  -- round anterior QUANDO houver mais de um conferente elegível disponível;
  -- "caso contrário, o mesmo, com marcação" — esta coluna É a marcação.
  forced_same_conferente BOOLEAN NOT NULL DEFAULT FALSE,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT checking_item_round_unique UNIQUE (checking_id, inbound_order_item_id, round),
  -- round NÃO é travado em 2: RN-REC-023 ("Item volta para recontagem" ao
  -- REJEITAR a decisão de uma Divergência FALTA/AVARIA/TROCA) reabre uma
  -- NOVA rodada de contagem além da recontagem original (round 3, 4...) —
  -- só o mínimo de 1 é garantido.
  CONSTRAINT checking_item_round_check CHECK (round >= 1),
  CONSTRAINT checking_item_qty_check CHECK (qty_counted >= 0)
);

CREATE INDEX IF NOT EXISTS idx_checking_item_checking ON wms.checking_item (checking_id);
CREATE INDEX IF NOT EXISTS idx_checking_item_order_item ON wms.checking_item (inbound_order_item_id);

ALTER TABLE wms.checking_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.checking_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checking_item_tenant_isolation ON wms.checking_item;
CREATE POLICY checking_item_tenant_isolation ON wms.checking_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.checking_item TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (37, 'DOC-04 RD-REC-003: checking + checking_item (TENANT, RLS) - contagens 1a/recontagem por round', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
