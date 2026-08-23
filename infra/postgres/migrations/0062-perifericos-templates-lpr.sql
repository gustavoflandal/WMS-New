-- Migration: 0062
-- DOC-11 RD-PER-004/005 — label_template, lpr_reading (GLOBAL, mesmo
-- raciocínio de classificação da migration 0061).
--
-- label_template.status: DRAFT -> TEST_PRINT_PENDING -> APPROVED -> ACTIVE
-- (-> RETIRED quando uma versão mais nova do MESMO code é ativada).
-- RN-PER-020: "ativação de versão exige impressão de teste aprovada" — essa
-- porta é imposta pelo código (LabelTemplateService), não pelo schema; o
-- schema só registra o estado.
--
-- [DECISÃO] Os 5 templates padrão SEEDADOS abaixo nascem direto em ACTIVE,
-- v1: RN-PER-020 os chama de "obrigatórios" — são a instalação de fábrica
-- definida pelo PRÓPRIO documento normativo (mesmo padrão já usado para
-- wms.product_species, migration 0011: valores definitórios do documento
-- inseridos como dado, não como saída de um fluxo de usuário). A PORTA de
-- teste-aprovado-antes-de-ativar (RN-PER-020) se aplica a toda EDIÇÃO
-- subsequente (nova versão de um code já existente), verificada por teste
-- de integração dedicado — não à carga inicial destes 5 registros.
CREATE TABLE IF NOT EXISTS wms.label_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  version INT NOT NULL,
  format TEXT NOT NULL,
  width_mm NUMERIC(6,2),
  height_mm NUMERIC(6,2),
  content TEXT,
  required_fields TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  test_print_job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  activated_at TIMESTAMPTZ,
  activated_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT label_template_code_version_unique UNIQUE (code, version),
  CONSTRAINT label_template_code_check CHECK (code IN ('LPN_PALETE', 'LPN_VOLUME', 'ENDERECO', 'LOTE_INTERNO', 'CONTEUDO_PALETE')),
  CONSTRAINT label_template_format_check CHECK (format IN ('ZPL', 'PDF')),
  CONSTRAINT label_template_status_check CHECK (status IN ('DRAFT', 'TEST_PRINT_PENDING', 'APPROVED', 'ACTIVE', 'RETIRED')),
  CONSTRAINT label_template_zpl_content_check CHECK (format = 'PDF' OR content IS NOT NULL)
);

-- RN-PER-020: no máximo 1 versão ACTIVE por code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_label_template_active_per_code
  ON wms.label_template(code) WHERE status = 'ACTIVE';

GRANT SELECT, INSERT, UPDATE ON wms.label_template TO wms_app;

INSERT INTO wms.label_template (code, version, format, width_mm, height_mm, content, required_fields, status, created_by, approved_at, approved_by, activated_at, activated_by) VALUES
(
  'LPN_PALETE', 1, 'ZPL', 100, 150,
  '^XA^PW800^LL1200
^FO40,30^BQN,2,6^FDLA,${gs1_element_string}^FS
^FO320,40^BY3^FO320,40^BCN,180,N,N,N^FD${gs1_element_string}^FS
^FO40,260^A0N,40,40^FDLPN: ${lpn}^FS
^FO40,310^A0N,32,32^FDCliente: ${client_code}^FS
^FO40,350^A0N,32,32^FDProduto: ${product_desc_or_misto}^FS
^FO40,390^A0N,32,32^FDLote: ${batch_code}  Val: ${expiration_date}^FS
^FO40,430^A0N,32,32^FDQtd: ${qty}^FS
^FO40,470^A0N,28,28^FD${datetime}  Armazem: ${warehouse_code}^FS
^FO40,510^A0N,28,28^FD${reprint_mark}^FS
^XZ',
  ARRAY['gs1_element_string','lpn','client_code','product_desc_or_misto','batch_code','expiration_date','qty','datetime','warehouse_code'],
  'ACTIVE', '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001'
),
(
  'LPN_VOLUME', 1, 'ZPL', 100, 100,
  '^XA^PW800^LL800
^FO40,30^BQN,2,6^FDLA,${gs1_element_string}^FS
^FO320,40^BY3^FO320,40^BCN,140,N,N,N^FD${gs1_element_string}^FS
^FO40,220^A0N,36,36^FDPedido: ${order_number}^FS
^FO40,260^A0N,32,32^FD${recipient_name}^FS
^FO40,300^A0N,32,32^FD${recipient_city}/${recipient_uf}^FS
^FO40,340^A0N,36,36^FDVolume ${volume_seq}/${volume_total}^FS
^FO40,380^A0N,32,32^FDPeso: ${weight_kg} kg^FS
^FO40,420^A0N,28,28^FD${reprint_mark}^FS
^XZ',
  ARRAY['gs1_element_string','order_number','recipient_name','recipient_city','recipient_uf','volume_seq','volume_total','weight_kg'],
  'ACTIVE', '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001'
),
(
  -- Esqueleto normativo do documento (DOC-11 §4.3), litteris.
  'ENDERECO', 1, 'ZPL', 100, 50,
  '^XA^PW799^LL399
^FO40,30^A0N,60,60^FD${location_code}^FS
^FO40,110^A0N,28,28^FDZona: ${zone_code}^FS
^FO40,170^BY3^BCN,140,N,N,N^FD${location_code}^FS
^XZ',
  ARRAY['location_code','zone_code'],
  'ACTIVE', '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001'
),
(
  'LOTE_INTERNO', 1, 'ZPL', 60, 40,
  '^XA^PW480^LL320
^FO20,20^BY2^BCN,120,N,N,N^FD${gs1_element_string}^FS
^FO20,160^A0N,24,24^FD${sku}^FS
^FO20,190^A0N,20,20^FD${description_30}^FS
^FO20,220^A0N,20,20^FDLote: ${batch_code}  Val: ${expiration_date}^FS
^XZ',
  ARRAY['gs1_element_string','sku','description_30','batch_code','expiration_date'],
  'ACTIVE', '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001', now(), '00000000-0000-0000-0000-000000000001'
),
(
  -- [LACUNA: DOC-11 não define motor de geração de PDF (nenhuma biblioteca
  -- de PDF no projeto) — template opcional (RN-PER-020: "A4 via PDF,
  -- opcional"). Registrado em DRAFT com os campos documentados; a
  -- renderização real (PRINT_PDF) fica para quando um gerador de PDF for
  -- introduzido — RNF-PER-031 já prevê que o CHAMADOR forneça o PDF pronto
  -- (base64/URL), então nenhum código de negócio depende deste registro
  -- para funcionar.]
  'CONTEUDO_PALETE', 1, 'PDF', NULL, NULL, NULL,
  ARRAY['pallet_lpn','items_json'],
  'DRAFT', '00000000-0000-0000-0000-000000000001', NULL, NULL, NULL, NULL
);

-- =============================================================================
-- lpr_reading — RD-PER-005.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.lpr_reading (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  peripheral_device_id UUID NOT NULL REFERENCES wms.peripheral_device(id) ON DELETE RESTRICT,
  plate TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  lane TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  image_ref TEXT,
  vehicle_visit_id UUID REFERENCES wms.vehicle_visit(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lpr_reading_confidence_check CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_lpr_reading_lane ON wms.lpr_reading(warehouse_id, lane, captured_at DESC) WHERE vehicle_visit_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_lpr_reading_visit ON wms.lpr_reading(vehicle_visit_id) WHERE vehicle_visit_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON wms.lpr_reading TO wms_app;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (62, 'DOC-11: label_template (5 padroes seedados ACTIVE v1) + lpr_reading (GLOBAL)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
