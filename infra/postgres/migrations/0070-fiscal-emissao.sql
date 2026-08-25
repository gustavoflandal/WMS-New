-- Migration: 0070
-- DOC-08 (Fiscal) SS4.7, SS4.9, SS5.1 -- Sessao 8B: motor de emissao NF-e
-- real, substituindo o "authorize()" manual/sincrono da 8A pelo ciclo
-- DRAFT->SIGNED->TRANSMITTED->AUTHORIZED/REJECTED/DENIED de verdade
-- (RNF-FIS-060), contingencia SVC (RNF-FIS-061), cancelamento/CCe
-- (RNF-FIS-062), certificados cifrados e guarda de XML (RNF-FIS-063).
--
-- O CHECK de wms.fiscal_document.status JA cobre todos os 8 estados desde a
-- migration 0069 -- nenhuma alteracao ao CHECK e necessaria aqui, so ALTER
-- aditivo de colunas novas.

-- =============================================================================
-- 1. wms.fiscal_issuer (RD-FIS-004) -- emitente (CNPJ x armazem), FIS.SERIE/
-- FIS.AMBIENTE por linha, certificado A1 cifrado (AES-256-GCM, RNF-FIS-063 /
-- RNF-ARQ-100), numeracao sequencial-sem-lacunas (next_nfe_number, reserva
-- atomica via UPDATE...RETURNING) e estado de contingencia (RNF-FIS-061).
--
-- DECISAO DE RLS (documentada tambem no relatorio da sessao): RD-FIS-004
-- marca escopo "GLOBAL", mas o conteudo (CNPJ, certificado cifrado) e por
-- emitente e FIS.SERIE/FIS.AMBIENTE sao descritos em RNF-FIS-060 como "por
-- emitente x armazem" -- interpretado como "nao e parametro de operacao do
-- dia a dia", nao como "sem tenant". RLS por tenant_id, mesmo padrao de toda
-- tabela de tenant do projeto.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_issuer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  cnpj TEXT NOT NULL,
  corporate_name TEXT NOT NULL,
  ambiente TEXT NOT NULL DEFAULT 'HOMOLOGACAO',
  serie INT NOT NULL,
  next_nfe_number BIGINT NOT NULL DEFAULT 1,
  cert_ciphertext BYTEA,
  cert_iv BYTEA,
  cert_auth_tag BYTEA,
  cert_password_ciphertext BYTEA,
  cert_password_iv BYTEA,
  cert_password_auth_tag BYTEA,
  cert_expires_at DATE,
  transmission_mode TEXT NOT NULL DEFAULT 'NORMAL',
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  contingencia_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT fiscal_issuer_cnpj_format CHECK (cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT fiscal_issuer_ambiente_check CHECK (ambiente IN ('HOMOLOGACAO', 'PRODUCAO')),
  CONSTRAINT fiscal_issuer_serie_check CHECK (serie > 0),
  CONSTRAINT fiscal_issuer_next_number_check CHECK (next_nfe_number > 0),
  CONSTRAINT fiscal_issuer_transmission_mode_check CHECK (transmission_mode IN ('NORMAL', 'CONTINGENCIA_SVC')),
  CONSTRAINT fiscal_issuer_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT fiscal_issuer_cert_pair_check CHECK (
    (cert_ciphertext IS NULL) = (cert_iv IS NULL) AND (cert_ciphertext IS NULL) = (cert_auth_tag IS NULL)
  ),
  CONSTRAINT fiscal_issuer_tenant_warehouse_cnpj_unique UNIQUE (tenant_id, warehouse_id, cnpj)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_issuer_tenant_warehouse ON wms.fiscal_issuer (tenant_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_issuer_cert_expires ON wms.fiscal_issuer (cert_expires_at) WHERE cert_expires_at IS NOT NULL;

ALTER TABLE wms.fiscal_issuer ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_issuer FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_issuer_tenant_isolation ON wms.fiscal_issuer;
CREATE POLICY fiscal_issuer_tenant_isolation ON wms.fiscal_issuer
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_issuer TO wms_app;
-- Jobs do scheduler (alerta de expiracao de certificado, monitor de
-- disponibilidade SEFAZ) precisam varrer TODOS os emitentes cross-tenant
-- (mesmo padrao de InboundInvoiceFiscalService.checkDeadlines()). A escrita
-- de volta (transmission_mode, alertas) e feita via db.transaction(ctx,...)
-- com o tenant_id/warehouse_id ja conhecido pela linha lida -- SEM grant de
-- escrita para wms_worker aqui (disciplina de menor privilegio ja usada em
-- todo o projeto).
GRANT SELECT ON wms.fiscal_issuer TO wms_worker;

-- =============================================================================
-- 2. ALTER wms.fiscal_document -- colunas do motor de emissao real. O CHECK
-- de status NAO muda (ja cobre SIGNED/TRANSMITTED/REJECTED/DENIED/CANCELLED
-- desde a 0069).
-- =============================================================================
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS fiscal_issuer_id UUID REFERENCES wms.fiscal_issuer(id) ON DELETE RESTRICT;
-- nNF real (RNF-FIS-060: "sequencial sem lacunas") -- reservado 1x na 1a
-- tentativa de assinatura (DRAFT->SIGNED); reaproveitado em REJECTED->DRAFT
-- (SS5.1: "correcao e reenvio, MESMO numero"). Distinto de internal_number
-- (controle interno, ja existente desde a 0069).
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS nfe_number BIGINT;
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS nfe_serie INT;
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS tpemis TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS cstat INT;
ALTER TABLE wms.fiscal_document ADD COLUMN IF NOT EXISTS protocol_number TEXT;

ALTER TABLE wms.fiscal_document DROP CONSTRAINT IF EXISTS fiscal_document_tpemis_check;
ALTER TABLE wms.fiscal_document ADD CONSTRAINT fiscal_document_tpemis_check CHECK (tpemis IN ('NORMAL', 'SVC'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_document_issuer_number_serie
  ON wms.fiscal_document (fiscal_issuer_id, nfe_serie, nfe_number)
  WHERE nfe_number IS NOT NULL;

-- =============================================================================
-- 3. wms.fiscal_document_event (RNF-FIS-062) -- cancelamento, CCe (ate 20
-- por nota) e inutilizacao de numero pulado, cada um com o XML do evento.
-- Todas as escritas passam por db.transaction(ctx,...) (wms_app), mesmo
-- quando disparadas por um job do scheduler que descobriu o alvo via scan
-- cross-tenant -- por isso NENHUM grant para wms_worker nesta tabela.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_document_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  fiscal_document_id UUID NOT NULL REFERENCES wms.fiscal_document(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  sequence_number INT,
  xml_storage_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  protocol_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT fiscal_document_event_type_check CHECK (event_type IN ('CANCELAMENTO', 'CCE', 'INUTILIZACAO')),
  CONSTRAINT fiscal_document_event_cce_sequence_check CHECK (
    (event_type = 'CCE' AND sequence_number IS NOT NULL AND sequence_number BETWEEN 1 AND 20)
    OR (event_type != 'CCE' AND sequence_number IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fiscal_document_event_document ON wms.fiscal_document_event (fiscal_document_id, event_type);

ALTER TABLE wms.fiscal_document_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_document_event FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_document_event_tenant_isolation ON wms.fiscal_document_event;
CREATE POLICY fiscal_document_event_tenant_isolation ON wms.fiscal_document_event
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_document_event TO wms_app;
-- FiscalNumberInutilizacaoWorkerImpl (scheduler mensal) faz um NOT EXISTS
-- contra esta tabela dentro do SCAN cross-tenant (transactionAsWorker) para
-- decidir quais fiscal_document já têm evento de inutilização -- SELECT
-- exige GRANT mesmo dentro de uma subquery. A ESCRITA continua só via
-- wms_app (db.query com tenant_id conhecido), then wms_worker permanece
-- SELECT-only aqui.
GRANT SELECT ON wms.fiscal_document_event TO wms_worker;

-- =============================================================================
-- 4. Parametros FIS.* novos (GLOBAL, fallback de instalacao -- reconfiguravel
-- por cliente x armazem via app_parameter CLIENT_WAREHOUSE sem migration
-- nova, mesmo padrao ja usado pelos demais parametros FIS.* desde a 8A).
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'FIS.PRAZO_CANCELAMENTO_H', '24')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 4b. wms.alert.alert_type -- novo valor CERTIFICADO_FISCAL_EXPIRANDO
-- (RNF-FIS-063: alerta de expiracao de certificado A1 em 30/15/7 dias).
-- Mesmo catalogo fechado espelhado em TS (alert.service.ts, ALERT_TYPES).
-- =============================================================================
ALTER TABLE wms.alert DROP CONSTRAINT IF EXISTS alert_type_check;
ALTER TABLE wms.alert ADD CONSTRAINT alert_type_check CHECK (alert_type IN (
  'EXCECAO_AGUARDANDO', 'EDGE_AGENT_OFFLINE', 'ESTOQUE_SEGURANCA_VIOLADO',
  'LOTE_A_VENCER', 'LOTE_VENCIDO', 'CROSSDOCK_TEMPO_EXCEDIDO',
  'TRANSBORDO_PENDENTE', 'CARTAO_ATRASADO', 'FALHA_INTEGRACAO',
  'DISPOSITIVO_CAMPO_OFFLINE', 'PRAZO_FISCAL_EXPIRADO', 'CERTIFICADO_FISCAL_EXPIRANDO'
));

-- =============================================================================
-- 5. Catalogo de excecoes -- FIS.CANCELAMENTO_NFE, deixado explicitamente
-- para esta sessao pela 0069 ("so faz sentido com nota AUTHORIZED de
-- verdade"). Valores EXATOS da tabela do DOC-08 SS3: 2 passos, motivo
-- obrigatorio, expira em 4h (distinto do prazo de cancelamento em si,
-- FIS.PRAZO_CANCELAMENTO_H = 24h, que e a janela para SOLICITAR o
-- cancelamento -- a excecao e a janela de APROVACAO da solicitacao).
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('FIS.CANCELAMENTO_NFE', 'Cancelamento de NF-e ja autorizada (RNF-FIS-062)', 2, TRUE, 4, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (70, 'DOC-08/8B: fiscal_issuer, fiscal_document_event; ALTER fiscal_document (nfe_number/serie/tpemis/cstat/protocol); FIS.PRAZO_CANCELAMENTO_H; excecao FIS.CANCELAMENTO_NFE', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
