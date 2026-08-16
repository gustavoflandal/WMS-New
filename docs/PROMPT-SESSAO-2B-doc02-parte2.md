# SESSÃO 2B: DOC-02 PARTE 2 — PRODUTOS, LOTES, LPN, SALDOS E NUMERAÇÃO
> Modelo recomendado: MÉDIO (Sonnet). Contém Mod-10 GS1, CHECKs de saldo e RLS por tabela.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-02-modelo-dados-cadastros.md`, `docs/relatorios/SESSAO-2A-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Completar o DOC-02: catálogo de produtos (§5.3), lotes e paletes (§5.4),
estrutura dos saldos (§5.5), numeração de documentos (§5.6) e parâmetros
(§5.7), com RLS conforme RN-DAD-004. Sem regras de movimentação — isso é DOC-05.

## REGRAS
- Cite o §/ID do DOC-02 ao definir CADA tabela, coluna e enum. Não invente
  coluna, tipo ou valor: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]` para dificuldade técnica; débito que
  bloqueia o Definition of Done não pode ser adiado.
- É PROIBIDO: `USING(true)` em policy; optional chaining para esconder DI;
  `.skip`; mock de Postgres/Redis em teste de integração; declarar ✅ sem
  saída de comando real.
- É PROIBIDO remover, mover ou renomear qualquer arquivo fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.
- Não refatore código que já passa nos testes (exceto item 1).

## ENTREGÁVEIS

### 1. Corrigir o débito de permissões da migration 0001 [PRIMEIRO]
`ALTER DEFAULT PRIVILEGES ... GRANT DELETE` concede DELETE a `wms_app` em
todo o schema, neutralizando os GRANTs restritivos das migrations de negócio
e enfraquecendo a RN-DAD-003. Corrija: default privileges SEM DELETE; DELETE
concedido explicitamente apenas onde a RN-DAD-003 permite (vínculos N:N de
configuração, rascunhos, tabelas técnicas). Nova migration (não edite a 0001
já aplicada) + teste provando que `wms_app` NÃO consegue deletar de uma
tabela de negócio.

### 2. Migrations — catálogo de produtos (DOC-02 §5.3)
`product_species` (GLOBAL, lista fechada com os 10 valores e seus
`requires_batch`/`requires_expiration`/`default_giro_policy`/
`segregation_class` — inclusive os valores iniciais obrigatórios do
documento), `commercial_category`, `product`, `product_barcode`,
`product_packaging`, `product_warehouse_parameter`. Todas as de tenant com
ENABLE + FORCE RLS e policy no padrão ADR-RLS-003/004. Constraints:
`UNIQUE(tenant_id, sku)`; barcode UNIQUE global; `qty_in_base_uom > 0`;
enums como CHECK com os valores exatos.

### 3. Migrations — lotes e paletes (DOC-02 §5.4)
`batch` (`UNIQUE(tenant_id, product_id, batch_code)`; CHECK
`expiration_date > manufacture_date`), `pallet` (`lpn` UNIQUE global),
`pallet_content` (`qty > 0`).

### 4. Migrations — saldos (DOC-02 §5.5)
`stock_balance` com as 6 parcelas e CHECK `>= 0` em TODAS (RG-004), UNIQUE
composta do documento, colunas `logical_warehouse_id` e `overflow_flag`,
índices do §5.5, fillfactor 85 (RNF-ARQ-091). `fiscal_stock_balance` com
CHECK `qty_consumed <= qty_credited` (RG-014); disponível é SEMPRE
calculado, nunca coluna. `stock_movement` particionada mensal (RNF-ARQ-090)
e append-only: revogue UPDATE/DELETE de `wms_app` nesta tabela e prove por
teste.

### 5. Geração de LPN — RN-DAD-030 [núcleo lógico desta sessão]
Serviço que gera SSCC de 18 dígitos: extensão(1) + prefixo(7) +
sequencial(9) + dígito verificador Mod-10 GS1(1). Prefixo do
`app_parameter` (padrão interno 2900000). Sequencial por armazém via
`document_sequence`. Teste obrigatório (exemplo normativo do documento):
extensão 1, prefixo 2900000, sequencial 000001234 → LPN
`129000000000012346`. Este teste é regressão permanente — não altere o
valor esperado.

### 6. Numeração de documentos — §5.6 / RN-DAD-040
`document_sequence` (GLOBAL) e serviço de numeração: máscara
`PREFIXO-CODARMAZEM-SEQ8`, incremento sob lock (RNF-ARQ-021) na MESMA
transação do documento, sem reuso mesmo em cancelamento. Testes: formato
`PED-SP01-00000101`; concorrência (50 gerações paralelas → 50 números
distintos e contíguos); número de documento cancelado não é reusado.

### 7. Regras de cadastro aplicáveis
RN-DAD-020 (espécie exige lote/validade; `species_code` imutável com
saldo>0), RN-DAD-021 (conversão pela `qty_in_base_uom`), RF-DAD-050/051/052.
Módulos NestJS de CRUD para produto, embalagem, código de barras, lote.
`[LACUNA: RBAC DOC-12]` nos guards.

### 8. Testes de integração adicionais (contra containers reais)
- Conversão RN-DAD-021: 10 CX12 (fator 12) → 120 UN.
- Espécie MEDICAMENTO sem lote → rejeitado; lote sem validade → rejeitado.
- `stock_balance` com qualquer parcela negativa → rejeitado pelo CHECK.
- `fiscal_stock_balance` com `consumed > credited` → rejeitado pelo CHECK.
- UPDATE/DELETE em `stock_movement` por `wms_app` → negado pelo banco.
- SKU duplicado no mesmo cliente → rejeitado; mesmo SKU em cliente diferente
  → aceito.
- Partição do mês corrente existe em `stock_movement` (ver item 9).

### 9. Débito bloqueante herdado (LAC-S1.5-003)
O scheduler não executa nada. Como `stock_movement` é particionada,
implemente o job de criação de partições (RNF-ARQ-090: partição do mês
seguinte, dia 20, com eleição de líder por lock Redis) e o alerta de
partição ausente. Sem isso, o primeiro INSERT do próximo mês falha.

### 10. Seeds
Estender o seed do SP01: 1 cliente, espécies (todas), 3 produtos (um
MEDICAMENTO com lote/validade, um GERAL, um de peso variável), embalagens,
códigos de barras. Idempotente.

## DEFINITION OF DONE
```bash
docker compose up -d
pnpm build && pnpm test && pnpm test:integration   # verdes, zero skip
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-2B-relatorio.md` com
matriz requisito → arquivo → teste, lacunas e débitos.

## FORA DE ESCOPO
Regras de movimentação e políticas de giro (DOC-05), RBAC real (DOC-12),
importação por planilha (RF-DAD-053), etiquetas ZPL (DOC-11), qualquer
endpoint operacional (recebimento, expedição).
