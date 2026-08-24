-- Migration: 0069
-- DOC-08 (Fiscal) SS4.1-SS4.6, SS4.8 — Sessao 8A: ciclo do Estoque Fiscal
-- (RG-014). Cria fiscal_document/fiscal_document_item (RD-FIS-001),
-- fiscal_allocation (RD-FIS-002), operation_nature (RD-FIS-003),
-- fiscal_pending_document (RD-FIS-006); ALTER em fiscal_stock_balance
-- (RD-FIS-005: qty_pending_writeoff + FK real) e outbound_order (vinculo
-- com a Nota de Devolucao emitida); parametros FIS.*, catalogo de permissao
-- FIS.* e excecoes FIS.PRAZO_ENTRADA_EXPIRADO/FIS.CONSUMO_MANUAL.
--
-- DECISAO DE ESCOPO (documentada tambem no relatorio da sessao): a "NF de
-- entrada" (RD-FIS-001 tipo NF_ENTRADA) NAO ganha uma linha fiscal_document
-- nesta sessao. wms.inbound_invoice (DOC-04, migration 0036) JA modela o
-- registro da NF de entrada + o prazo de regularizacao (RN-FIS-010 passo 1)
-- desde a Sessao 4B, com FK para inbound_order e regularization_deadline
-- calculado. Duplicar esse dado em fiscal_document fragmentaria a fonte
-- unica de verdade da NF de entrada. 'NF_ENTRADA' permanece RESERVADO no
-- CHECK de document_type (fechamento de catalogo pedido pelo prompt da
-- sessao), sem nenhuma linha gravada com esse tipo nesta sessao — o CONTROLE
-- de prazo (alertas 50/80/100%, bloqueio de liberacao) e implementado como
-- servico que LE wms.inbound_invoice diretamente (InboundInvoiceFiscalService,
-- apps/backend/src/modules/fiscal). 'NF_TRANSFERENCIA'/'NF_DEVOLUCAO_RECEBIDA'
-- tambem ficam reservados no CHECK, sem uso (fora do escopo desta sessao,
-- DOC-08 SS4.7/DOC-07).

-- =============================================================================
-- 1. wms.operation_nature (RD-FIS-003, RN-FIS-050) — TENANT com fallback
-- GLOBAL. tenant_id/warehouse_id NULOS = padrao de instalacao (regime de
-- armazem geral); uma linha tenant_id/warehouse_id preenchidos = override
-- de cadastro daquele cliente x armazem (RN-FIS-050 "e PROIBIDO emitir com
-- natureza nao cadastrada para o par cliente x tipo" fica satisfeito pelo
-- fallback ao padrao global quando o cliente nao tem override).
-- Politica de RLS: MESMO padrao da correcao de app_parameter GLOBAL
-- (migration 0053, achado 3x documentado em CLAUDE.md) — linha com
-- tenant_id NULL e visivel/gravavel sem contexto de tenant (queryGlobal()
-- seguro), linha com tenant_id preenchido exige contexto batendo.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.operation_nature (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  cfop TEXT NOT NULL,
  description TEXT,
  cst_csosn TEXT,
  icms_rate NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT operation_nature_tenant_warehouse_pair CHECK ((tenant_id IS NULL) = (warehouse_id IS NULL)),
  CONSTRAINT operation_nature_document_type_check CHECK (document_type IN ('NOTA_ARMAZENAGEM', 'NOTA_DEVOLUCAO_ARMAZENAGEM')),
  CONSTRAINT operation_nature_scope_type_check CHECK (scope_type IN ('INTERNO', 'INTERESTADUAL')),
  CONSTRAINT operation_nature_cfop_format CHECK (cfop ~ '^[0-9]{4}$'),
  CONSTRAINT operation_nature_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT operation_nature_scoped_unique UNIQUE (tenant_id, warehouse_id, document_type, scope_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_nature_global_default
  ON wms.operation_nature (document_type, scope_type)
  WHERE tenant_id IS NULL AND warehouse_id IS NULL;

ALTER TABLE wms.operation_nature ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.operation_nature FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operation_nature_visibility ON wms.operation_nature;
CREATE POLICY operation_nature_visibility ON wms.operation_nature
  FOR ALL
  USING (
    tenant_id IS NULL
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
    )
  )
  WITH CHECK (
    tenant_id IS NULL
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
    )
  );

GRANT SELECT, INSERT, UPDATE ON wms.operation_nature TO wms_app;

-- Padrao de instalacao (DOC-08 SS4.6, regime de armazem geral) — decisao de
-- homologacao contabil resolvida (ver docs/PROMPT-SESSAO-8A-fiscal-estoque.md
-- topo): posicao padrao, reconfiguravel por cliente x armazem sem migration
-- nova (basta INSERT de uma linha com tenant_id/warehouse_id preenchidos).
INSERT INTO wms.operation_nature (document_type, scope_type, cfop, description, created_by) VALUES
  ('NOTA_ARMAZENAGEM',          'INTERNO',       '5905', 'Remessa para armazem geral (padrao de instalacao, DOC-08 SS4.6)', '00000000-0000-0000-0000-000000000001'),
  ('NOTA_ARMAZENAGEM',          'INTERESTADUAL', '6905', 'Remessa para armazem geral (padrao de instalacao, DOC-08 SS4.6)', '00000000-0000-0000-0000-000000000001'),
  ('NOTA_DEVOLUCAO_ARMAZENAGEM','INTERNO',       '5906', 'Retorno de armazem geral (padrao de instalacao, DOC-08 SS4.6)',   '00000000-0000-0000-0000-000000000001'),
  ('NOTA_DEVOLUCAO_ARMAZENAGEM','INTERESTADUAL', '6906', 'Retorno de armazem geral (padrao de instalacao, DOC-08 SS4.6)',   '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. wms.fiscal_document + wms.fiscal_document_item (RD-FIS-001).
-- Estado restrito nesta sessao a DRAFT (montado)/REGISTRADA (documento que
-- ENTRA no sistema ja pronto — Nota de Armazenagem do cliente) e, via o
-- metodo explicito de "autorizacao" de 8A (RN-FIS-040, substituto testavel
-- do retorno real da SEFAZ), AUTHORIZED. SIGNED/TRANSMITTED/REJECTED/
-- DENIED/CANCELLED ficam RESERVADOS no CHECK (fechamento de catalogo desde
-- ja) mas SEM nenhuma transicao produzida nesta sessao — dependem do motor
-- de emissao real (assinatura+transmissao SEFAZ/SVC, cancelamento
-- homologado) que e da Sessao 8B (DOC-08 SS4.7/SS5.1).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  internal_number TEXT NOT NULL,
  access_key TEXT,
  issuer_cnpj TEXT,
  issuer_name TEXT,
  recipient_cnpj TEXT,
  recipient_name TEXT,
  -- Data de EMISSAO do documento — chave de ordenacao de RN-FIS-030
  -- (FIFO_EMISSAO/LIFO_EMISSAO). Para NOTA_ARMAZENAGEM = data informada no
  -- registro (XML/manual); para NOTA_DEVOLUCAO_ARMAZENAGEM = momento da
  -- "autorizacao" (metodo explicito desta sessao).
  issued_at TIMESTAMPTZ,
  total_value NUMERIC(18,2),
  xml_storage_key TEXT,
  operation_nature_id UUID REFERENCES wms.operation_nature(id) ON DELETE RESTRICT,
  rejection_detail TEXT,
  authorized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT fiscal_document_internal_number_unique UNIQUE (internal_number),
  CONSTRAINT fiscal_document_access_key_unique UNIQUE (access_key),
  CONSTRAINT fiscal_document_access_key_format CHECK (access_key IS NULL OR access_key ~ '^[0-9]{44}$'),
  CONSTRAINT fiscal_document_type_check CHECK (document_type IN (
    'NF_ENTRADA', 'NOTA_ARMAZENAGEM', 'NOTA_DEVOLUCAO_ARMAZENAGEM', 'NF_TRANSFERENCIA', 'NF_DEVOLUCAO_RECEBIDA'
  )),
  CONSTRAINT fiscal_document_status_check CHECK (status IN (
    'DRAFT', 'REGISTRADA', 'SIGNED', 'TRANSMITTED', 'AUTHORIZED', 'REJECTED', 'DENIED', 'CANCELLED'
  )),
  CONSTRAINT fiscal_document_total_value_check CHECK (total_value IS NULL OR total_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_document_tenant_warehouse ON wms.fiscal_document (tenant_id, warehouse_id, document_type, status);
CREATE INDEX IF NOT EXISTS idx_fiscal_document_issued_at ON wms.fiscal_document (tenant_id, warehouse_id, document_type, issued_at);

ALTER TABLE wms.fiscal_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_document FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_document_tenant_isolation ON wms.fiscal_document;
CREATE POLICY fiscal_document_tenant_isolation ON wms.fiscal_document
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_document TO wms_app;
-- InboundInvoiceFiscalService (worker de alerta de prazo, RN-FIS-010) le
-- cross-tenant para calcular cobertura (SUM de fiscal_document_item de
-- NOTA_ARMAZENAGEM referenciando uma inbound_invoice) via transactionAsWorker.
GRANT SELECT ON wms.fiscal_document TO wms_worker;

-- =============================================================================
-- fiscal_document_item — uma linha por (produto x nota consumida/referenciada).
-- reference_inbound_invoice_id: RF-FIS-020 ("referencia a NF de entrada") —
-- OBRIGATORIO em items de NOTA_ARMAZENAGEM (validado em StorageInvoiceService,
-- nao em CHECK de banco: o CHECK nao alcancaria o document_type do pai sem
-- um trigger dedicado — decisao de escopo documentada no relatorio). Quando
-- uma Nota de Armazenagem cobre produto vindo de MULTIPLAS NF de entrada
-- (RN-FIS-021 "PODE cobrir multiplas NF de entrada"), o chamador submete uma
-- linha por (produto x invoice), nao uma coluna N:M.
-- reference_fiscal_document_id: RN-FIS-040 ("NFref" + infAdProd) — a Nota de
-- Armazenagem consumida, em items de NOTA_DEVOLUCAO_ARMAZENAGEM.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_document_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  fiscal_document_id UUID NOT NULL REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  line_number INT NOT NULL,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  reference_inbound_invoice_id UUID REFERENCES wms.inbound_invoice(id) ON DELETE RESTRICT,
  reference_fiscal_document_id UUID REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT fiscal_document_item_unique UNIQUE (fiscal_document_id, line_number),
  CONSTRAINT fiscal_document_item_qty_check CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_document_item_document ON wms.fiscal_document_item (fiscal_document_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_document_item_product ON wms.fiscal_document_item (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_document_item_ref_invoice ON wms.fiscal_document_item (reference_inbound_invoice_id);

ALTER TABLE wms.fiscal_document_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_document_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_document_item_tenant_isolation ON wms.fiscal_document_item;
CREATE POLICY fiscal_document_item_tenant_isolation ON wms.fiscal_document_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_document_item TO wms_app;
GRANT SELECT ON wms.fiscal_document_item TO wms_worker;

-- =============================================================================
-- 3. wms.fiscal_allocation (RD-FIS-002) — Consumo Fiscal: nota de
-- armazenagem consumida x nota de devolucao que consome, com quantidade e
-- estado. qty_reversed suporta estorno PARCIAL (RN-FIS-041): status vira
-- ESTORNADA somente quando qty_reversed atinge qty; um estorno parcial
-- mantem status CONSUMIDA com qty_reversed > 0.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_allocation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  storage_fiscal_document_id UUID NOT NULL REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  return_fiscal_document_id UUID NOT NULL REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  outbound_order_id UUID REFERENCES wms.outbound_order(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  qty_reversed NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ALOCADA',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT fiscal_allocation_qty_check CHECK (qty > 0),
  CONSTRAINT fiscal_allocation_qty_reversed_check CHECK (qty_reversed >= 0 AND qty_reversed <= qty),
  CONSTRAINT fiscal_allocation_status_check CHECK (status IN ('ALOCADA', 'CONSUMIDA', 'ESTORNADA'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_allocation_storage_doc ON wms.fiscal_allocation (storage_fiscal_document_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_allocation_return_doc ON wms.fiscal_allocation (return_fiscal_document_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_allocation_outbound_order ON wms.fiscal_allocation (outbound_order_id);

ALTER TABLE wms.fiscal_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_allocation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_allocation_tenant_isolation ON wms.fiscal_allocation;
CREATE POLICY fiscal_allocation_tenant_isolation ON wms.fiscal_allocation
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_allocation TO wms_app;

-- =============================================================================
-- 4. wms.fiscal_pending_document (RD-FIS-006, RN-FIS-070) — pendencia
-- documental de baixa fiscal por descarte/ajuste negativo. origin_entity/
-- origin_entity_id apontam para stock_reclassification ou
-- inventory_count_location (sem FK — tabelas de outro schema/modulo,
-- mesmo padrao ja usado por operational_exception.entity/entity_id).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_pending_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL,
  origin_entity TEXT NOT NULL,
  origin_entity_id UUID NOT NULL,
  qty NUMERIC(18,6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  resolved_fiscal_document_id UUID REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT fiscal_pending_document_qty_check CHECK (qty > 0),
  CONSTRAINT fiscal_pending_document_origin_check CHECK (origin IN ('DESCARTE', 'AJUSTE_INVENTARIO_NEG')),
  CONSTRAINT fiscal_pending_document_status_check CHECK (status IN ('PENDING', 'RESOLVED'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_pending_document_product ON wms.fiscal_pending_document (tenant_id, warehouse_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_fiscal_pending_document_origin_entity ON wms.fiscal_pending_document (origin_entity, origin_entity_id);

ALTER TABLE wms.fiscal_pending_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_pending_document FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_pending_document_tenant_isolation ON wms.fiscal_pending_document;
CREATE POLICY fiscal_pending_document_tenant_isolation ON wms.fiscal_pending_document
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_pending_document TO wms_app;

-- =============================================================================
-- 5. ALTER wms.fiscal_stock_balance (RD-FIS-005) — FK real de
-- storage_remittance_invoice_id (agora que fiscal_document existe) +
-- qty_pending_writeoff (RN-FIS-070) + CHECK atualizado.
--
-- Achado batendo esta migration contra o Postgres de desenvolvimento
-- (docker-compose.yml, volume persistente): a tabela tinha linha(s) com
-- storage_remittance_invoice_id "solto" (UUID gerado ad-hoc por sessão
-- anterior — RG-014 nunca teve um ESCRITOR real antes desta sessão, mas o
-- ambiente de dev acumulou dado de teste/exploração manual mesmo assim).
-- Como wms.fiscal_document é CRIADA nesta MESMA migration (bloco 2, acima),
-- nenhuma linha existente pode legitimamente referenciar uma — é sempre
-- artefato de teste, nunca dado de negócio real. DELETE explícito e restrito
-- (não um TRUNCATE cego) antes do ADD CONSTRAINT, idempotente por natureza
-- (uma 2ª execução encontra 0 linhas órfãs).
-- =============================================================================
DELETE FROM wms.fiscal_stock_balance
WHERE storage_remittance_invoice_id NOT IN (SELECT id FROM wms.fiscal_document);

ALTER TABLE wms.fiscal_stock_balance ADD COLUMN IF NOT EXISTS qty_pending_writeoff NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE wms.fiscal_stock_balance ADD CONSTRAINT fiscal_stock_balance_pending_writeoff_check CHECK (qty_pending_writeoff >= 0);
ALTER TABLE wms.fiscal_stock_balance DROP CONSTRAINT IF EXISTS fiscal_stock_balance_consumed_le_credited;
ALTER TABLE wms.fiscal_stock_balance ADD CONSTRAINT fiscal_stock_balance_consumed_plus_pending_le_credited CHECK (qty_consumed + qty_pending_writeoff <= qty_credited);
ALTER TABLE wms.fiscal_stock_balance ADD CONSTRAINT fiscal_stock_balance_storage_invoice_fk FOREIGN KEY (storage_remittance_invoice_id) REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT;

-- =============================================================================
-- 6. ALTER wms.outbound_order — vinculo com a Nota de Devolucao de
-- Armazenagem emitida para o pedido (RN-FIS-040, DispatchService.
-- confirmFiscalDocuments). Nullable: so preenchido para fiscal_mode
-- EMISSAO_PROPRIA/HIBRIDO; INTEGRADO_ERP continua sem documento do sistema.
-- =============================================================================
ALTER TABLE wms.outbound_order ADD COLUMN IF NOT EXISTS fiscal_document_id UUID REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT;

-- =============================================================================
-- 7. document_sequence — novo documentType FISCAL_DOCUMENT (numero INTERNO
-- da Nota de Armazenagem/Nota de Devolucao como documento do sistema — NAO
-- e o numero de NF-e real (nNF sequencial-sem-lacunas), que fica NULL ate a
-- Sessao 8B, ver DocumentNumberingService/document-numbering.service.ts).
-- =============================================================================
ALTER TABLE wms.document_sequence DROP CONSTRAINT IF EXISTS document_sequence_type_check;
ALTER TABLE wms.document_sequence ADD CONSTRAINT document_sequence_type_check CHECK (document_type IN (
  'INBOUND_ORDER', 'OUTBOUND_ORDER', 'TRANSFER', 'INVENTORY', 'LPN',
  'PRE_INVOICE', 'RETURN_ORDER', 'APPOINTMENT', 'FISCAL_DOCUMENT'
));

-- =============================================================================
-- 8. Parametros FIS.* (RD-FIS delta, GLOBAL — fallback de instalacao).
-- FIS.PRAZO_ENTRADA_DIAS: fallback quando client_warehouse_settings.
-- inbound_invoice_deadline_days nao esta configurado (hoje inbound-order.
-- service.ts EXIGE o valor por cliente x armazem antes de aceitar XML com
-- veiculo casado — ver [LACUNA] no relatorio: o fallback GLOBAL fica
-- seedado aqui mas a resolucao de "usa o global quando o especifico e nulo"
-- nao foi religada em inbound-order.service.ts nesta sessao, DOC-04 fora do
-- escopo declarado do prompt 8A).
-- FIS.ORDEM_CONSUMO: DECISAO desta sessao (ver prompt, topo) — parametro por
-- CLIENTE x ARMAZEM vive em app_parameter escopo CLIENT_WAREHOUSE (nao em
-- coluna nova de client_warehouse_settings), porque so e lido na montagem da
-- Nota de Devolucao (nao e caminho quente de liberacao de pedido, ao
-- contrario de inbound_invoice_deadline_days). Seed abaixo e a linha GLOBAL
-- (padrao de instalacao); uma linha CLIENT_WAREHOUSE so existe quando um
-- cliente especifico e reconfigurado.
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'FIS.PRAZO_ENTRADA_DIAS', '10'),
  ('GLOBAL', 'FIS.BLOQUEIO_RECEBIMENTO_PRAZO', 'false'),
  ('GLOBAL', 'FIS.ORDEM_CONSUMO', 'FIFO_EMISSAO'),
  ('GLOBAL', 'FIS.RECOMPOSICAO_MODO', 'ESTORNO')
ON CONFLICT DO NOTHING;

-- Alertas de prazo (RN-FIS-010: "50%, 80% e 100% do prazo") — mesmo padrao
-- de EST.ALERTA_VENCIMENTO_DIAS (JSON array em app_parameter), lido por
-- InboundInvoiceFiscalService.
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'FIS.ALERTA_PRAZO_PERCENTUAIS', '[50, 80, 100]')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 9. Catalogo de permissoes FIS.* (DOC-08 SS3). As sensiveis a emissao real
-- (CANCELAR/INUTILIZAR/CERTIFICADO) so serao exercidas de fato na Sessao 8B,
-- mas o catalogo inteiro entra aqui (RN-SEG-012).
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('FIS.EMITIR',       'CLIENT_WAREHOUSE', 'Emissao/registro de documentos do ciclo fiscal (Nota de Armazenagem, Nota de Devolucao) - DOC-08 SS3', TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('FIS.CANCELAR',     'CLIENT_WAREHOUSE', 'Cancelamento de NF-e (DOC-08 SS3) - exercida na Sessao 8B',                                             TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('FIS.CCE',          'CLIENT_WAREHOUSE', 'Carta de Correcao Eletronica (DOC-08 SS3) - exercida na Sessao 8B',                                     FALSE, '00000000-0000-0000-0000-000000000001'),
  ('FIS.INUTILIZAR',   'WAREHOUSE',        'Inutilizacao de numeracao de NF-e (DOC-08 SS3) - exercida na Sessao 8B',                                TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('FIS.CONFIG',       'GLOBAL',           'Configuracao de modo fiscal, naturezas de operacao e parametros FIS.* (DOC-08 SS3/SS4.1/SS4.6)',        TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('FIS.CERTIFICADO',  'GLOBAL',           'Gestao de certificados digitais A1 (DOC-08 SS3) - exercida na Sessao 8B',                                TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- FISCAL (DOC-08 SS3: "Emissao, cancelamento, CCe, monitoracao de rejeicoes").
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('FIS.EMITIR'), ('FIS.CANCELAR'), ('FIS.CCE'), ('FIS.INUTILIZAR')) AS p(code)
WHERE r.code = 'FISCAL'
ON CONFLICT DO NOTHING;

-- GESTOR_ARMAZEM (DOC-08 SS3: "Configuracao de naturezas, series e certificados").
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('FIS.CONFIG'), ('FIS.CERTIFICADO')) AS p(code)
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 10. Catalogo de excecoes FIS.* (DOC-08 SS3, valores EXATOS da tabela:
-- Passos | Motivo obrigatorio | Expira em). FIS.CANCELAMENTO_NFE fica para
-- a 8B (so faz sentido com nota AUTHORIZED de verdade via SEFAZ).
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('FIS.PRAZO_ENTRADA_EXPIRADO', 'Operacao alem do prazo de regularizacao fiscal (RN-FIS-010 item 4)',       2, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('FIS.CONSUMO_MANUAL',         'Selecao manual de notas de armazenagem no consumo fiscal (RN-FIS-030)',     1, TRUE, 8,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 11. wms.alert.alert_type — novo valor PRAZO_FISCAL_EXPIRADO (RN-FIS-010
-- item 3: "item de painel CRIT e criado"; tambem usado em WARN nos alertas
-- de 50/80% do prazo). Ver apps/backend/src/modules/paineis/alertas/
-- alert.service.ts (ALERT_TYPES) - mesmo catalogo fechado espelhado em TS.
-- =============================================================================
ALTER TABLE wms.alert DROP CONSTRAINT IF EXISTS alert_type_check;
ALTER TABLE wms.alert ADD CONSTRAINT alert_type_check CHECK (alert_type IN (
  'EXCECAO_AGUARDANDO', 'EDGE_AGENT_OFFLINE', 'ESTOQUE_SEGURANCA_VIOLADO',
  'LOTE_A_VENCER', 'LOTE_VENCIDO', 'CROSSDOCK_TEMPO_EXCEDIDO',
  'TRANSBORDO_PENDENTE', 'CARTAO_ATRASADO', 'FALHA_INTEGRACAO',
  'DISPOSITIVO_CAMPO_OFFLINE', 'PRAZO_FISCAL_EXPIRADO'
));

-- =============================================================================
-- 12. Grants adicionais por consumidor real desta sessao (ADR-006).
-- inbound_invoice ganha SELECT para wms_worker: InboundInvoiceFiscalService
-- (worker de alerta de prazo RN-FIS-010) varre cross-tenant via
-- transactionAsWorker, mesmo raciocinio de ExpirationAlertWorkerImpl.
-- =============================================================================
GRANT SELECT ON wms.inbound_invoice TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (69, 'DOC-08/8A: fiscal_document(_item), fiscal_allocation, operation_nature, fiscal_pending_document; ALTER fiscal_stock_balance (qty_pending_writeoff+FK) e outbound_order (fiscal_document_id); parametros/permissoes/excecoes FIS.*', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
