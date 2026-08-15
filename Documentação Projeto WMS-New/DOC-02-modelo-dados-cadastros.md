# DOC-02 — MODELO DE DADOS E CADASTROS
## Especificação de Requisitos do Sistema WMS Enterprise 3PL

| Metadado | Valor |
|---|---|
| Código do documento | DOC-02 |
| Versão | 1.0.0 |
| Status | APROVADO PARA USO |
| Data | 2026-08-10 |
| Depende de | DOC-00 v1.2.0, DOC-01 v1.0.0 |
| Módulo (prefixo de requisitos) | DAD |

---

## 1. ESCOPO E OBJETIVO

Este documento define o dicionário de dados das entidades fundacionais e as regras de cadastro: organização (operador, clientes, armazéns, armazéns lógicos), estrutura física (zonas, estruturas de armazenagem, endereços, docas, pátio), catálogo de produtos (espécies, embalagens, códigos de barras, parâmetros por armazém), lotes, paletes/LPN, estrutura dos saldos, numeração de documentos e parâmetros de sistema.

**Este documento resolve:** LAC-005 (máscaras de numeração de documentos).
**Regras de MOVIMENTAÇÃO desses dados** ficam nos módulos operacionais (DOC-03 a DOC-09). Tabelas específicas de cada módulo são declaradas como *delta* nos respectivos documentos, obedecendo às convenções daqui.

---

## 2. DEPENDÊNCIAS E TERMOS

Aplicam-se o Glossário (DOC-00 §4) e as regras RG-001 a RG-015. Os identificadores técnicos do glossário são os nomes obrigatórios das tabelas.

---

## 3. ATORES E PERMISSÕES ENVOLVIDAS

| Ator | Interação |
|---|---|
| Administrador do Operador Logístico | CRUD de armazéns, estrutura física, usuários internos, parâmetros globais |
| Gestor de Contas | CRUD de clientes, contratos, configurações cliente × armazém |
| Cliente (portal) | CRUD do próprio catálogo de produtos (quando habilitado), consulta dos demais |
| Sistemas externos | Manutenção de catálogo via API (DOC-13) |

As permissões exatas (códigos RBAC) são definidas no DOC-12.

---

## 4. CONVENÇÕES DO MODELO DE DADOS

**RN-DAD-001 — Nomenclatura [INVIOLÁVEL]:** tabelas e colunas em `snake_case`, inglês, singular para colunas e singular para tabelas de entidade (`product`, não `products`). Nomes de tabela = identificador técnico do glossário. É PROIBIDO criar tabela cujo conceito exista no glossário com outro nome.

**RN-DAD-002 — Colunas obrigatórias em toda tabela:**
`id UUID v7 PK` · `created_at timestamptz NOT NULL` · `created_by uuid NOT NULL` · `updated_at timestamptz` · `updated_by uuid`. Tabelas transacionais adicionam `tenant_id uuid NOT NULL` (RG-001).

**RN-DAD-003 — Exclusão [INVIOLÁVEL]:** É PROIBIDO `DELETE` físico em entidades referenciadas por movimentações. Desativação por coluna `status` (enum por entidade) ou `active boolean`. `DELETE` físico é permitido apenas em: rascunhos nunca efetivados, vínculos N:N de configuração e tabelas técnicas com retenção (DOC-01 §4.10).

**RN-DAD-004 — Classificação das tabelas (fecha RNF-ARQ-012):**
- **GLOBAIS (sem `tenant_id`, sem RLS):** `warehouse`, `zone`, `storage_equipment`, `location`, `dock`, `yard_slot`, `user`, `role` e vínculos RBAC (DOC-12), `document_sequence`, `app_parameter` (escopos global/armazém), `i18n_translation`, `edge_agent`, `product_species`.
- **DE TENANT (com `tenant_id` = `client.id`, RLS obrigatório):** `client` (o próprio, `tenant_id = id`), `client_warehouse_settings`, `logical_warehouse`, `logical_warehouse_location`, `product`, `commercial_category`, `product_barcode`, `product_packaging`, `product_warehouse_parameter`, `batch`, `pallet`, `stock_balance`, `fiscal_stock_balance` e todas as tabelas transacionais dos módulos.
A IA geradora NÃO PODE criar tabela fora desta classificação sem `[LACUNA]`.

**RN-DAD-005 — Tipos padrão:** quantidades `NUMERIC(18,6)`; pesos kg `NUMERIC(12,3)`; dimensões m `NUMERIC(8,3)`; volume m³ `NUMERIC(12,4)`; moeda `NUMERIC(14,4)` (RG-010); enums como `TEXT` + `CHECK`, valores em SCREAMING_SNAKE_CASE (REG-GLO-004).

**RN-DAD-006 — Chaves estrangeiras:** sempre declaradas com `ON DELETE RESTRICT`. É PROIBIDO `CASCADE` em dados de negócio.

---

## 5. DICIONÁRIO DE DADOS

Formato: **Coluna** — tipo — [N]=NOT NULL — descrição. Colunas obrigatórias da RN-DAD-002 são omitidas por brevidade, mas existem em todas as tabelas.

### 5.1 Organização

**`client`** (o registro do Cliente; `tenant_id = id`)
- `code` — text [N] — código curto único do cliente (máx. 10, A-Z0-9), imutável após criação
- `legal_name` — text [N] — razão social
- `trade_name` — text — nome fantasia
- `cnpj` — text [N] — CNPJ (14 dígitos, validado por dígito verificador), único
- `state_registration` — text — inscrição estadual
- `address_*` — colunas de endereço (logradouro, número, complemento, bairro, município, código IBGE, UF, CEP)
- `status` — enum [N] — `ACTIVE` | `SUSPENDED` | `INACTIVE`
- `contact_email`, `contact_phone` — text
- Constraint: `UNIQUE(cnpj)`, `UNIQUE(code)`

**`client_warehouse_settings`** (configuração Cliente × Armazém; UNIQUE(`tenant_id`,`warehouse_id`))
- `warehouse_id` — uuid [N] — FK `warehouse`
- `fiscal_mode` — enum [N] — `EMISSAO_PROPRIA` | `INTEGRADO_ERP` | `HIBRIDO` (AD-002)
- `inbound_invoice_deadline_days` — int — prazo de regularização da NF de entrada (RG-014; padrão herdado de `app_parameter`)
- `logical_warehouse_enabled` — boolean [N] default false — ativa RG-015
- `default_giro_policy` — enum [N] — `FEFO` | `FIFO` | `LIFO` | `JIT` — padrão para produtos sem política própria
- `min_shelf_life_default_pct` — numeric(5,2) — shelf life mínimo padrão (%)
- `blind_checking` — boolean [N] default true — conferência cega no recebimento (DOC-04)
- `status` — enum [N] — `ACTIVE` | `SUSPENDED`

**`logical_warehouse`** (RG-015; UNIQUE(`tenant_id`,`warehouse_id`))
- `warehouse_id` — uuid [N] — FK `warehouse`
- `code` — text [N] — código exibido (máx. 10)
- `name` — text [N]
- `status` — enum [N] — `ACTIVE` | `DEACTIVATING` | `INACTIVE`

**`logical_warehouse_location`** (vínculo de endereços; UNIQUE(`location_id`) global — um endereço pertence a no máx. 1 armazém lógico)
- `logical_warehouse_id` — uuid [N] — FK
- `location_id` — uuid [N] — FK `location`
- `linked_at`, `linked_by` — vínculo com log (RG-015 item 4)

### 5.2 Estrutura física (tabelas GLOBAIS)

**`warehouse`**
- `code` — text [N] — código curto único (máx. 6, A-Z0-9), usado nas máscaras de numeração (§6)
- `name` — text [N]
- `cnpj` — text [N] — CNPJ da filial do operador logístico (emitente fiscal, DOC-08)
- `address_*` — endereço completo + `timezone` (IANA, ex.: `America/Sao_Paulo`) [N]
- `status` — enum [N] — `ACTIVE` | `INACTIVE`

**`zone`**
- `warehouse_id` — uuid [N] — FK
- `code` — text [N] — único por armazém
- `name` — text [N]
- `zone_type` — enum [N] — `RECEIVING` | `QUARANTINE` | `STORAGE` | `PICKING` | `PACKING` | `WEIGHING` | `DISPATCH` | `CROSS_DOCKING` | `RETURNS` | `DAMAGED` | `CLASSIFIED_FLAMMABLE` | `CONTROLLED` | `COLD` | `FROZEN`
- `allowed_species` — text[] [N] — espécies permitidas (RG-005; valores de `product_species`)
- `temperature_min_c`, `temperature_max_c` — numeric(5,2) — faixa controlada, quando aplicável
- `status` — enum [N] — `ACTIVE` | `BLOCKED` | `INACTIVE`

**`storage_equipment`**
- `warehouse_id` — uuid [N] — FK
- `code` — text [N] — único por armazém
- `equipment_type` — enum [N] — `PORTA_PALETES` | `DRIVE_IN` | `DRIVE_THRU` | `CANTILEVER` | `FLOWRACK` | `ESTANTE` | `GAVETEIRO` | `CARROSSEL` | `BLOCADO`
- `access_policy` — enum [N] — política física de acesso derivada do tipo: `RANDOM` (porta-paletes, estante, gaveteiro, cantilever) | `LIFO_PHYSICAL` (drive-in, blocado) | `FIFO_PHYSICAL` (drive-thru, flowrack) | `AUTOMATED` (carrossel)
- `status` — enum [N] — `ACTIVE` | `MAINTENANCE` | `INACTIVE`

**RN-DAD-010 — Coerência física × política de giro [INVIOLÁVEL]:** QUANDO o motor de alocação (DOC-05) considerar endereço em estrutura `LIFO_PHYSICAL`, DEVE tratar que somente o último palete inserido é acessível; produtos com política `FEFO`/`FIFO` só podem ser alocados em `LIFO_PHYSICAL` se todos os paletes do canal forem do mesmo lote. Estruturas `FIFO_PHYSICAL` são preferenciais para `FEFO`/`FIFO`.

**`location`**
- `warehouse_id` — uuid [N] — FK
- `zone_id` — uuid [N] — FK
- `storage_equipment_id` — uuid — FK (NULL para piso/blocado demarcado)
- `code` — text [N] — código legível único por armazém, derivado das coordenadas (ver RN-DAD-011)
- `aisle` — text [N] — Rua (2 chars, ex.: `A1`)
- `module` — text [N] — Módulo (3 dígitos)
- `level` — text [N] — Nível (2 chars; `00` = piso)
- `slot` — text [N] — Vão (2 dígitos)
- `location_type` — enum [N] — `STORAGE` | `PICKING` | `STAGING_IN` | `STAGING_OUT` | `QUARANTINE` | `DAMAGED` | `CROSS_DOCK`
- `max_weight_kg` — numeric(12,3) [N]
- `max_volume_m3` — numeric(12,4) [N]
- `max_pallets` — int [N]
- `max_height_m` — numeric(8,3) [N]
- `abc_class` — enum — `A` | `B` | `C` — classe de conveniência para o motor de putaway
- `status` — enum [N] — `ACTIVE` | `BLOCKED` | `INVENTORY` (bloqueado por contagem) | `INACTIVE`
- Constraint: `UNIQUE(warehouse_id, code)`; `UNIQUE(warehouse_id, aisle, module, level, slot)`

**RN-DAD-011 — Código do endereço [INVIOLÁVEL]:** `code = aisle || '-' || module || '-' || level || '-' || slot` (ex.: `A1-012-03-02`). Este é o texto codificado na etiqueta de endereço (DOC-11) e o único formato aceito em leituras.

**`dock`**
- `warehouse_id` — uuid [N] — FK
- `code` — text [N] — único por armazém (ex.: `D01`)
- `dock_type` — enum [N] — `INBOUND` | `OUTBOUND` | `BOTH`
- `allowed_vehicle_types` — text[] — tipos de veículo suportados
- `has_leveler` — boolean [N] — possui niveladora
- `status` — enum [N] — `FREE` | `RESERVED` | `OCCUPIED` | `BLOCKED` | `INACTIVE` (transições no DOC-04)

**`yard_slot`**
- `warehouse_id` — uuid [N] — FK
- `code` — text [N] — único por armazém (ex.: `V012`)
- `slot_type` — enum [N] — `WAITING` | `PARKING` | `HAZMAT` (vaga para inflamáveis/combustíveis)
- `status` — enum [N] — `FREE` | `OCCUPIED` | `BLOCKED` | `INACTIVE`

### 5.3 Catálogo de produtos

**`product_species`** (GLOBAL — lista fechada, extensível apenas por versão deste documento)
- `code` — text PK — `GERAL` | `MEDICAMENTO` | `ALIMENTO` | `INFLAMAVEL` | `COMBUSTIVEL` | `QUIMICO_CONTROLADO` | `REFRIGERADO` | `CONGELADO` | `FRAGIL` | `VALIOSO`
- `requires_batch` — boolean [N] — exige lote
- `requires_expiration` — boolean [N] — exige validade
- `default_giro_policy` — enum [N] — política de giro sugerida
- `segregation_class` — text [N] — classe para a matriz de compatibilidade (DOC-05/LAC-003)

Valores iniciais obrigatórios: `MEDICAMENTO`, `ALIMENTO`, `REFRIGERADO`, `CONGELADO` ⇒ `requires_batch=true`, `requires_expiration=true`, giro `FEFO`. `INFLAMAVEL`, `COMBUSTIVEL`, `QUIMICO_CONTROLADO` ⇒ `requires_batch=true`.

**`product`** (UNIQUE(`tenant_id`,`sku`))
- `sku` — text [N] — código do produto no cliente (máx. 40), imutável
- `description` — text [N]
- `species_code` — text [N] — FK `product_species`
- `commercial_category_id` — uuid — FK `commercial_category`
- `base_uom` — enum [N] — unidade base: `UN` | `KG` | `L` | `M` | `M2` | `M3` | `CX` | `PC` — todas as quantidades de saldo são na unidade base
- `is_weight_variable` — boolean [N] default false — produto de peso variável (pesagem obrigatória no picking, DOC-06)
- `net_weight_kg`, `gross_weight_kg` — numeric(12,3) — por unidade base
- `length_m`, `width_m`, `height_m` — numeric(8,3) — da unidade base
- `giro_policy` — enum — `FEFO` | `FIFO` | `LIFO` | `JIT` — NULL herda de `client_warehouse_settings.default_giro_policy` (RG-006)
- `min_shelf_life_pct` — numeric(5,2) — NULL herda do padrão do cliente
- `shelf_life_days` — int — vida útil total de fabricação (para validação de lote)
- `ncm` — text — NCM 8 dígitos (obrigatório se cliente com `fiscal_mode` ≠ `INTEGRADO_ERP`; DOC-08)
- `status` — enum [N] — `ACTIVE` | `BLOCKED` | `DISCONTINUED`

**RN-DAD-020 — Validações de espécie [INVIOLÁVEL]:** QUANDO `product_species.requires_batch = true`, toda movimentação do produto DEVE informar lote; QUANDO `requires_expiration = true`, todo lote DEVE ter `expiration_date`. É PROIBIDO alterar `species_code` de produto com saldo > 0 (exige saldo zero + permissão específica).

**`commercial_category`** (UNIQUE(`tenant_id`,`code`))
- `code`, `name` — text [N] — classificação livre do cliente; `parent_id` — uuid — hierarquia opcional

**`product_barcode`** (UNIQUE global em `barcode`)
- `product_id` — uuid [N] — FK
- `barcode` — text [N] — EAN-8/EAN-13/DUN-14/Code128 interno
- `barcode_type` — enum [N] — `EAN13` | `EAN8` | `DUN14` | `INTERNAL`
- `packaging_id` — uuid — FK `product_packaging` — a qual embalagem o código corresponde (NULL = unidade base)

**`product_packaging`** (hierarquia de embalagens; UNIQUE(`product_id`,`code`))
- `product_id` — uuid [N] — FK
- `code` — text [N] — ex.: `CX12`, `PAL`
- `description` — text [N]
- `qty_in_base_uom` — numeric(18,6) [N] — fator de conversão para a unidade base (> 0)
- `is_default_receiving` — boolean [N] — embalagem padrão de recebimento
- `is_default_picking` — boolean [N] — embalagem padrão de picking
- `ballast`, `layers` — int — lastro × camadas quando embalagem de palete

**RN-DAD-021 — Conversão única [INVIOLÁVEL]:** toda quantidade persistida em saldo e movimentação é na `base_uom`. Conversões usam exclusivamente `qty_in_base_uom` da embalagem informada. Exemplo normativo: produto com `base_uom = UN`, embalagem `CX12` com fator 12; recebimento de 10 CX12 credita 120 UN; picking de 30 UN com embalagem padrão CX12 gera tarefa de 2 CX12 + 6 UN.

**`product_warehouse_parameter`** (UNIQUE(`tenant_id`,`product_id`,`warehouse_id`))
- `product_id`, `warehouse_id` — uuid [N]
- `safety_stock_qty` — numeric(18,6) — estoque de segurança (RG do DOC-05); NULL = sem controle
- `kanban_enabled` — boolean [N] default false
- `kanban_trigger_qty`, `kanban_replenish_qty` — numeric(18,6) — gatilho e quantidade de reposição (obrigatórios se `kanban_enabled`)
- `default_picking_location_id` — uuid — FK `location` — endereço fixo de picking (opcional)
- `putaway_zone_preference` — uuid[] — zonas preferenciais em ordem

### 5.4 Lotes e paletes

**`batch`** (UNIQUE(`tenant_id`,`product_id`,`batch_code`))
- `product_id` — uuid [N] — FK
- `batch_code` — text [N] — código do lote do fabricante (máx. 30)
- `manufacture_date` — date
- `expiration_date` — date — obrigatória conforme RN-DAD-020; DEVE ser > `manufacture_date`
- `status` — enum [N] — `RELEASED` | `QUARANTINE` | `BLOCKED` | `RECALLED`

**`pallet`**
- `lpn` — text [N] — UNIQUE global (ver RN-DAD-030)
- `pallet_type` — enum [N] — `PBR` | `EURO` | `DESCARTAVEL` | `METALICO` | `VOLUME` (volume avulso etiquetado)
- `status` — enum [N] — `IN_RECEIVING` | `STORED` | `IN_MOVE` | `IN_PICKING` | `IN_DISPATCH` | `SHIPPED` | `EMPTY` | `CANCELLED`
- `current_location_id` — uuid — FK `location` — posição atual (NULL quando em doca/veículo)
- Conteúdo do palete: tabela `pallet_content` (`pallet_id`, `product_id`, `batch_id`, `qty` NUMERIC(18,6) > 0)

**RN-DAD-030 — Formato do LPN [INVIOLÁVEL]:** LPN numérico de 18 dígitos no padrão GS1 SSCC: dígito de extensão (1) + prefixo (7) + sequencial (9) + dígito verificador Mod-10 GS1 (1). ONDE o armazém possuir prefixo GS1 próprio configurado em `app_parameter`, DEVE usá-lo; caso contrário, usar prefixo interno `2900000` (circulação restrita). Sequencial por armazém via `document_sequence` (§6). Exemplo normativo (validado por cálculo): extensão `1`, prefixo `2900000`, sequencial `000001234` → Mod-10 GS1 sobre `12900000000001234` = dígito `6` → LPN `129000000000012346`. A representação em etiqueta (QR + Code 128 AI 00) é do DOC-11.

### 5.5 Estrutura dos saldos (regras de movimentação no DOC-05/DOC-08)

**`stock_balance`** (UNIQUE(`tenant_id`,`warehouse_id`,`product_id`,`batch_id`,`location_id`,`pallet_id`))
- `warehouse_id`, `product_id` — uuid [N]; `batch_id`, `pallet_id` — uuid (NULL quando não aplicável); `location_id` — uuid [N]
- `logical_warehouse_id` — uuid — FK, denormalizado do endereço (RG-015 item 5)
- `overflow_flag` — boolean [N] default false — saldo em `TRANSBORDO` (RG-015 item 3)
- `qty_available` — numeric(18,6) [N] ≥ 0
- `qty_reserved` — numeric(18,6) [N] ≥ 0
- `qty_blocked` — numeric(18,6) [N] ≥ 0
- `qty_quarantine` — numeric(18,6) [N] ≥ 0
- `qty_damaged` — numeric(18,6) [N] ≥ 0
- `qty_in_transit` — numeric(18,6) [N] ≥ 0
- CHECK: todas as parcelas ≥ 0 (RG-004)
- Índices: (`tenant_id`,`product_id`,`warehouse_id`); (`location_id`); (`pallet_id`); parcial em `overflow_flag = true`

**`fiscal_stock_balance`** (RG-014; UNIQUE(`tenant_id`,`warehouse_id`,`product_id`,`storage_remittance_invoice_id`))
- `warehouse_id`, `product_id`, `storage_remittance_invoice_id` — uuid [N]
- `qty_credited` — numeric(18,6) [N] — total creditado pela Nota de Armazenagem
- `qty_consumed` — numeric(18,6) [N] ≥ 0 — total já baixado por Notas de Devolução
- CHECK: `qty_consumed <= qty_credited` (saldo fiscal nunca negativo)
- Saldo fiscal disponível = `qty_credited - qty_consumed` (nunca persistido, sempre calculado)

**`stock_movement`** (particionada mensal, RNF-ARQ-090 — registro imutável de TODA alteração de saldo)
- `movement_type` — enum [N] — catálogo fechado definido no DOC-05
- origem/destino: `location_id_from/to`, `pallet_id_from/to`, parcela de saldo de/para
- `qty` — numeric(18,6) [N] > 0
- `document_ref` — tipo + id do documento causador; `task_id`; `requirement_id`
- É PROIBIDO UPDATE/DELETE nesta tabela (append-only)

### 5.6 Numeração de documentos (resolve LAC-005)

**`document_sequence`** (GLOBAL; UNIQUE(`document_type`,`warehouse_id`))
- `document_type` — enum [N] — `INBOUND_ORDER` | `OUTBOUND_ORDER` | `TRANSFER` | `INVENTORY` | `LPN` | `PRE_INVOICE` | `RETURN_ORDER` | `APPOINTMENT`
- `warehouse_id` — uuid [N]
- `last_value` — bigint [N] default 0

**RN-DAD-040 — Máscaras de numeração [INVIOLÁVEL]:**
Formato: `<PREFIXO>-<CÓDIGO DO ARMAZÉM>-<SEQUENCIAL 8 dígitos zero-padded>`.

| Documento | Prefixo | Exemplo |
|---|---|---|
| Ordem de Recebimento | `REC` | `REC-SP01-00004321` |
| Pedido | `PED` | `PED-SP01-00123456` |
| Transferência | `TRF` | `TRF-SP01-00000087` |
| Inventário | `INV` | `INV-SP01-00000012` |
| Pré-Fatura | `FAT` | `FAT-SP01-00000901` |
| Ordem de Devolução (reversa) | `DEV` | `DEV-SP01-00000034` |
| Agendamento | `AGD` | `AGD-SP01-00009876` |
| LPN | — | formato próprio RN-DAD-030 |

QUANDO um número for gerado, o sistema DEVE incrementar `last_value` sob lock (RNF-ARQ-021) na mesma transação do documento; números são sequenciais por armazém, sem reuso, inclusive de documentos cancelados (o cancelamento preserva o número). Numeração fiscal (NF-e) NÃO usa esta tabela — segue série/numeração fiscal própria no DOC-08.

### 5.7 Parâmetros e i18n

**`app_parameter`** (RD-ARQ-004; UNIQUE(`scope`,`scope_id`,`key`))
- `scope` — enum [N] — `GLOBAL` | `WAREHOUSE` | `CLIENT` | `CLIENT_WAREHOUSE`
- `scope_id` — uuid — NULL para `GLOBAL`
- `key` — text [N] — catálogo de chaves declarado por cada módulo (a IA geradora NÃO PODE criar chave fora dos catálogos)
- `value` — jsonb [N]; `value_type` — enum [N] — `STRING` | `INT` | `NUMERIC` | `BOOLEAN` | `JSON`
- Resolução: `CLIENT_WAREHOUSE` > `CLIENT` > `WAREHOUSE` > `GLOBAL` (primeiro encontrado vence)

**`i18n_translation`** (RG-012): `key` UNIQUE, `pt_br` [N] — toda string de interface referencia uma chave.

---

## 6. REGRAS DE CADASTRO (CRUD)

**RF-DAD-050 — Imutabilidade de códigos:** `client.code`, `warehouse.code`, `product.sku`, `location.code` e `batch.batch_code` são imutáveis após a criação. Correção = desativar e recriar (com saldo zero quando aplicável).

**RF-DAD-051 — Desativação segura:** QUANDO um usuário desativar `location`, `zone`, `logical_warehouse`, `product` ou `client`, o sistema DEVE validar saldo zero e ausência de documentos abertos vinculados; caso contrário, DEVE rejeitar com a lista de pendências.

**RF-DAD-052 — Bloqueio operacional:** estados `BLOCKED` de `location`, `batch` e `product` impedem novas movimentações de SAÍDA e novas alocações, mas não impedem consultas nem inventário. Bloqueio/desbloqueio exige permissão específica + motivo + log (RG-003).

**RF-DAD-053 — Importação de catálogo:** o sistema DEVE oferecer importação de produtos/embalagens/códigos de barras por planilha (template fixo) e por API (DOC-13), com validação linha a linha e relatório de erros determinístico (linha, coluna, código do erro). Importação é transacional por linha (linhas válidas entram, inválidas são rejeitadas no relatório).

**RF-DAD-054 — Geração em massa de endereços:** o sistema DEVE gerar endereços por intervalo de coordenadas (ex.: ruas A1–A4, módulos 001–050, níveis 00–05, vãos 01–02) com capacidades padrão por nível, evitando duplicidades e reportando total criado.

---

## 7. CRITÉRIOS DE ACEITE (GHERKIN)

```gherkin
Cenário: Unicidade de SKU por cliente
  Dado o cliente A com produto SKU "ABC-1"
  E o cliente B sem produtos
  Quando o cliente B cadastrar o SKU "ABC-1"
  Então o cadastro deve ser aceito
  E quando o cliente A cadastrar novamente o SKU "ABC-1"
  Então o sistema deve rejeitar com erro de duplicidade

Cenário: Espécie exige lote e validade
  Dado um produto da espécie MEDICAMENTO
  Quando um recebimento for informado sem código de lote
  Então o sistema deve rejeitar com erro determinístico "lote obrigatório para a espécie"
  E quando o lote for informado sem data de validade
  Então o sistema deve rejeitar com erro "validade obrigatória para a espécie"

Cenário: Conversão de embalagem (exemplo normativo RN-DAD-021)
  Dado produto base UN com embalagem CX12 (fator 12)
  Quando o recebimento confirmar 10 CX12
  Então o saldo deve ser creditado em 120 UN

Cenário: Geração de LPN com dígito verificador (RN-DAD-030)
  Dado o prefixo interno 2900000 e o sequencial 000001234 do armazém SP01
  Quando um palete for criado
  Então o LPN gerado deve ser "129000000000012346"
  E o LPN deve ser único globalmente

Cenário: Numeração sequencial preservada no cancelamento
  Dado o último pedido do armazém SP01 com número PED-SP01-00000100
  Quando um novo pedido for criado e em seguida cancelado
  Então o número PED-SP01-00000101 permanece atribuído ao pedido cancelado
  E o próximo pedido criado recebe PED-SP01-00000102

Cenário: Endereço de armazém lógico rejeita outro cliente
  Dado o endereço A1-012-03-02 vinculado ao armazém lógico do cliente A
  Quando o putaway sugerir ou o operador informar esse endereço para produto do cliente B
  Então o sistema deve rejeitar com erro determinístico de exclusividade (RG-015)

Cenário: Desativação segura de endereço
  Dado o endereço B2-001-01-01 com saldo de 50 UN
  Quando um administrador tentar desativá-lo
  Então o sistema deve rejeitar informando o saldo existente
```

---

## 8. FORA DE ESCOPO (NÃO IMPLEMENTAR)

- Atributos dinâmicos/custom fields por cliente (catálogo é fixo nesta versão).
- Cadastro de transportadoras e frota própria (entra no DOC-03 apenas o mínimo de veículo/motorista de portaria).
- Versionamento temporal de cadastros (SCD); a trilha é a auditoria do DOC-12.
- Multi-idioma além do pt-BR (RG-012).
- Cadastro de fornecedores do cliente (a NF de entrada carrega o emitente, DOC-08).
- Qualquer tabela de movimentação operacional (docas, tarefas, pedidos, inventário) — pertencem aos módulos.

---

## 9. MATRIZ DE RASTREABILIDADE LOCAL

| Necessidade (DOC-00 §8) | Requisitos deste documento |
|---|---|
| N07 Estruturas de armazenagem | §5.2 `storage_equipment`, RN-DAD-010 |
| N08 Espaços e segregação por espécie | §5.2 `zone.allowed_species`, §5.3 `product_species`, RN-DAD-020 |
| N10 Etiquetas de palete (dado) | RN-DAD-030 (representação no DOC-11) |
| N11 Estoques próprios/terceiros, políticas de giro | §5.3 `giro_policy`, §5.5 saldos |
| N12 Estoque de segurança (parâmetro) | §5.3 `product_warehouse_parameter.safety_stock_qty` |
| N13 Kanban (parâmetro) | §5.3 `kanban_*` |
| N14 Multi-armazéns/multi-empresas | §5.1, §5.2, RN-DAD-004 |
| N27 Estoque fiscal (estrutura) | §5.5 `fiscal_stock_balance` |
| N28 Armazém lógico | §5.1 `logical_warehouse*`, §5.5 campos RG-015 |
| LAC-005 máscaras de numeração | §5.6, RN-DAD-040 |

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0.0 | 2026-08-10 | Versão inicial aprovada |
