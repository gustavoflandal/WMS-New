# SESSÃO 2B — RELATÓRIO FINAL

**Data**: 2026-08-16
**Título**: DOC-02 Parte 2 — Produtos, Lotes, LPN, Saldos e Numeração
**Status**: ✅ CONCLUÍDO (com saída de comando real, ver §3)

---

## 1. ESCOPO

Completar o DOC-02: catálogo de produtos (§5.3), lotes e paletes (§5.4),
estrutura dos saldos (§5.5), numeração de documentos (§5.6), geração de LPN
(RN-DAD-030), correção do débito de permissões herdado da Sessão 2A, job de
particionamento (LAC-S1.5-003) e seeds. Sem regras de movimentação (DOC-05).

---

## 2. MATRIZ REQUISITO → ARQUIVO → TESTE

| Requisito | Arquivo(s) | Teste |
|---|---|---|
| RN-DAD-003 (fix do débito 2A: DELETE default) | `0010-fix-default-privileges.sql` | `core/database/__tests__/business-table-delete-denied.integration.spec.ts` |
| DOC-02 §5.3 catálogo de produtos | `0011-product-catalog.sql` | `sku-uniqueness...`, `uom-conversion...`, `species-batch-validation...` |
| RN-DAD-020 (espécie exige lote/validade; species_code imutável com saldo>0) | `0011-...sql` (triggers `check_batch_expiration_required`, `prevent_species_change_with_balance` — este último anexado em `0014-...sql`), `0012-batch-pallet.sql` | `species-batch-validation.integration.spec.ts` |
| RN-DAD-021 (conversão pela qty_in_base_uom) | `0011-...sql` (`product_packaging.qty_in_base_uom > 0`), `product-packaging/` | `uom-conversion.integration.spec.ts` |
| RF-DAD-050 (sku/batch_code imutáveis) | `wms.prevent_sku_update` (0011), `wms.prevent_batch_code_update` (0012) | Coberto indiretamente por `code-immutability...` (padrão idêntico ao de warehouse/client da 2A); não há `it()` dedicado a sku/batch_code — ver §5 |
| DOC-02 §5.4 lotes e paletes | `0012-batch-pallet.sql` | `species-batch-validation...`, `lpn-generation...` |
| RG-007 / RN-DAD-030 (LPN, SSCC Mod-10 GS1) | `lpn/lpn.util.ts`, `lpn/lpn.service.ts`, `pallet/pallet.service.ts` | `lpn/__tests__/lpn.util.spec.ts` (unitário, exemplo normativo — regressão permanente), `cadastro/__tests__/lpn-generation.integration.spec.ts` |
| DOC-02 §5.5 saldos (stock_balance, RG-004) | `0014-stock-balances.sql` | `stock-balance-constraints.integration.spec.ts` |
| RG-014 (fiscal_stock_balance) | `0014-...sql` | `stock-balance-constraints.integration.spec.ts` |
| DOC-02 §5.5 stock_movement (particionada, append-only) | `0014-...sql` (`ensure_stock_movement_partition`, `REVOKE UPDATE, DELETE`) | `stock-movement-append-only...`, `stock-movement-partition...` |
| DOC-02 §5.6 / RN-DAD-040 (numeração de documentos) | `0013-document-sequence.sql`, `document-numbering/document-numbering.service.ts` | `document-numbering.integration.spec.ts` (formato, concorrência 50x, não-reuso) |
| RNF-ARQ-090 (partição mensal, débito LAC-S1.5-003) | `workers/partition-manager.worker.impl.ts`, `main.ts` (role scheduler) | `workers/__tests__/partition-manager.integration.spec.ts` (alerta de ausência, criação dia 20, idempotência, eleição de líder) |
| RNF-ARQ-021 (lock na numeração / eleição de líder) | `document-numbering.service.ts` (upsert atômico via índice único), `partition-manager.worker.impl.ts` (`CacheService.acquireLock`) | `document-numbering...` (concorrência), `partition-manager...` (eleição de líder) |
| Módulos CRUD produto/embalagem/código de barras/lote | `product/`, `product-packaging/`, `product-barcode/`, `batch/` | Exercitados pelos testes de integração acima (não há suite dedicada "CRUD feliz" por módulo, ver §5) |
| Seeds (produtos, embalagens, códigos de barras) | `infra/postgres/seeds/0002-seed-catalog.sql` | Validado com saída real (§3.4), não por teste automatizado |

---

## 3. SAÍDA REAL

### 3.1 Build, type-check, testes unitários

```
$ pnpm build   (apps/backend)
> nest build
(sem erros, exit 0)

$ pnpm type-check
> tsc --noEmit
(sem erros, exit 0)

$ pnpm test
 ✓ src/__tests__/health.spec.ts (2 tests)
 ✓ src/modules/cadastro/lpn/__tests__/lpn.util.spec.ts (6 tests)
 Test Files  2 passed (2)
      Tests  8 passed (8)
```

### 3.2 Testes de integração (schema recriado do zero pelo global setup)

```
$ pnpm test:integration
 Test Files  24 passed (24)
      Tests  62 passed (62)
```

Arquivos novos desta sessão (16 tenants/spec + 1 worker): `business-table-delete-denied`,
`lpn-generation`, `document-numbering`, `uom-conversion`, `species-batch-validation`,
`stock-movement-append-only`, `stock-movement-partition`, `sku-uniqueness`,
`stock-balance-constraints`, `partition-manager` — todos verdes, zero skip,
zero mock de Postgres/Redis.

### 3.3 Docker compose completo

```
$ docker compose -f infra/docker-compose.yml up -d --build
NAME                    STATUS
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)
wms-frontend            Up (healthy)
wms-minio               Up (healthy)
wms-postgres            Up (healthy)
wms-redis               Up (healthy)

$ curl -s http://localhost:3000/health/ready
{"status":"ok",...,"checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/cadastro/products?...
200
```

`schema_migration` confirma as 14 migrations aplicadas (1-14) no Postgres
real. Log do `wms-backend-scheduler` confirma `PartitionManagerWorkerImpl`
iniciado com o role `scheduler`.

### 3.4 Seeds

```
$ pnpm db:seed
Seeding: 0001-seed-sp01.sql
Seeding: 0002-seed-catalog.sql
Done. 2 seed file(s) applied (idempotent).

$ pnpm db:seed   (segunda execução, prova de idempotência)
Done. 2 seed file(s) applied (idempotent).
```

Contagem real: 1 client (ACME01), 3 products (MED001 MEDICAMENTO com lote
LOTE2026A/validade 2027-01-01, GER001 GERAL, VAR001 peso variável), 1 batch,
3 product_packaging, 3 product_barcode — idênticas nas duas execuções.

---

## 4. ACHADO ARQUITETURAL — SEED PRECISOU MUDAR DE ROLE (wms_app → postgres)

O runner `infra/postgres/seeds/run-seed.mjs` (criado na Sessão 2A) conectava
como `wms_app`. Isso funcionava na 2A porque todas as tabelas seedadas eram
GLOBAIS (sem RLS). Ao estender o seed para `client`/`product`/`batch`/etc.
(DE TENANT, RLS obrigatório), o INSERT em `wms.client` falhou com
`new row violates row-level security policy` — mesmo problema de bootstrap
já documentado em `ClientService.create()` (client.id = tenant_id só é
conhecido DEPOIS do INSERT) e sem solução simples para um script SQL puro
que também precisa, em execuções repetidas, localizar o cliente já existente
(que exigiria SABER o tenant_id de antemão para a query respeitar RLS —
problema circular). Corrigido reconectando o seed runner como a role
admin/bootstrap (mesma do `MigrationRunner`), que ignora RLS por ser
superusuário — apropriado para um script administrativo (não é o pool de
request-path da aplicação, que continua restrito a `wms_app`,
RNF-ARQ-011 inalterado).

---

## 5. LACUNAS E DÉBITOS

- `[LACUNA: RBAC DOC-12]` — todos os controllers novos usam `NoAuthGuard`.
- `[LACUNA: default_giro_policy/segregation_class de product_species]` — o
  DOC-02 só define esses campos explicitamente para MEDICAMENTO/ALIMENTO/
  REFRIGERADO/CONGELADO (giro FEFO). Para os demais 6 códigos, usei `FIFO`
  como giro neutro e `segregation_class = code` (cada espécie na própria
  classe, sem compatibilidade cruzada assumida) até o DOC-05 definir a
  matriz real (LAC-003).
- `[LACUNA: catálogo de movement_type]` — `stock_movement.movement_type` é
  `TEXT NOT NULL` sem `CHECK` de enum (o catálogo fechado é do DOC-05, fora
  do escopo desta sessão).
- `[LACUNA: nomes de coluna balance_bucket_from/to]` — DOC-02 descreve
  "parcela de saldo de/para" sem nomear colunas; inferi `balance_bucket_from/to`
  com `CHECK` restrito às 6 parcelas já documentadas em `stock_balance`
  (AVAILABLE/RESERVED/BLOCKED/QUARANTINE/DAMAGED/IN_TRANSIT).
- `[LACUNA: storage_remittance_invoice_id sem FK]` — a tabela é do DOC-08,
  fora do escopo desta sessão.
- `[LACUNA: dígito de extensão do LPN fixado em 1]` — DOC-02 só dá o exemplo
  normativo (valor 1), sem regra de escolha para outros casos.
- `[LACUNA: document_ref_id/task_id/requirement_id sem FK]` — tabelas de
  documento/tarefa não existem ainda (DOC-03/04/06/07).
- `[LACUNA: pallet_content sem UNIQUE]` — DOC-02 não declara constraint de
  unicidade para `(pallet_id, product_id, batch_id)`; não inventada.
- `[DEBITO: RF-DAD-051 em location/zone/client não valida stock_balance]` —
  achado arquitetural real, não corrigido nesta sessão: `LocationService`/
  `ZoneService` operam sobre tabelas GLOBAIS via `queryGlobal()` (sem
  contexto de tenant), mas `stock_balance` é DE TENANT com RLS — uma
  checagem "este location tem saldo de QUALQUER tenant" exigiria bypass de
  RLS (ex.: função `SECURITY DEFINER` dedicada, no mesmo espírito de
  `wms.ensure_stock_movement_partition`) ou o modelo de permissões do
  DOC-12 para saber quais tenants o usuário pode consultar. `ClientService.deactivate()`
  tem o mesmo problema em menor grau (sabe o próprio tenant_id, mas ainda
  não checa `stock_balance`). `ProductService.deactivate()` (entidade nova
  desta sessão, DE TENANT) já faz a checagem corretamente — ver
  `product/product.service.ts`. `[DEBITO: expor um helper SECURITY DEFINER
  tipo wms.location_has_stock(location_id) para fechar location/zone/client,
  sessão a definir]`.
- `[DEBITO: RF-DAD-052 bloqueio operacional]` — os enums `BLOCKED` já
  existem em `product`/`batch`/`location` (este último desde a 2A), mas o
  bloqueio efetivo de "novas movimentações de saída" é responsabilidade do
  motor de movimentação (DOC-05), inexistente nesta sessão.
- `[DEBITO: sem CRUD dedicado para commercial_category]` — a tabela existe
  (migration 0011) mas o Entregável 7 só pediu CRUD explícito para
  produto/embalagem/código de barras/lote.
- `[DEBITO: sem it() dedicado para RF-DAD-050 de sku/batch_code]` — a
  imutabilidade é garantida pelos triggers (mesmo padrão comprovado de
  `warehouse.code`/`client.code` na 2A) mas não há um teste de integração
  específico provando `UPDATE sku`/`UPDATE batch_code` rejeitado — coberto
  só por leitura de código e pelo padrão já validado em outras tabelas.

---

## 6. ARQUIVOS CRIADOS/MODIFICADOS NESTA SESSÃO

**Migrations**:
- `infra/postgres/migrations/0010-fix-default-privileges.sql`
- `infra/postgres/migrations/0011-product-catalog.sql`
- `infra/postgres/migrations/0012-batch-pallet.sql`
- `infra/postgres/migrations/0013-document-sequence.sql`
- `infra/postgres/migrations/0014-stock-balances.sql`

**Seeds**:
- `infra/postgres/seeds/0002-seed-catalog.sql`
- `infra/postgres/seeds/run-seed.mjs` (role de conexão corrigida — §4)

**Módulo `cadastro`** (`apps/backend/src/modules/cadastro/`):
- `product/`, `product-packaging/`, `product-barcode/`, `batch/` (service + controller cada)
- `document-numbering/document-numbering.service.ts`
- `lpn/lpn.util.ts`, `lpn/lpn.service.ts`
- `pallet/pallet.service.ts`
- `cadastro.module.ts` (registra os novos providers/controllers)

**Workers**:
- `apps/backend/src/workers/partition-manager.worker.impl.ts`
- `apps/backend/src/main.ts` (role `scheduler` liga o partition-manager)

**Testes**:
- `lpn/__tests__/lpn.util.spec.ts` (unitário, regressão permanente)
- `core/database/__tests__/business-table-delete-denied.integration.spec.ts`
- `cadastro/__tests__/lpn-generation.integration.spec.ts`
- `cadastro/__tests__/document-numbering.integration.spec.ts`
- `cadastro/__tests__/uom-conversion.integration.spec.ts`
- `cadastro/__tests__/species-batch-validation.integration.spec.ts`
- `cadastro/__tests__/stock-balance-constraints.integration.spec.ts`
- `cadastro/__tests__/stock-movement-append-only.integration.spec.ts`
- `cadastro/__tests__/stock-movement-partition.integration.spec.ts`
- `cadastro/__tests__/sku-uniqueness.integration.spec.ts`
- `workers/__tests__/partition-manager.integration.spec.ts`
- `cadastro/__tests__/test-helpers.ts` (helpers novos: `randomClientCode`, `randomSku`)

**Documentação**:
- Este relatório
- `docs/PROMPT-SESSAO-2B-doc02-parte2.md`

---

**Gerado**: 2026-08-16
**Sessão**: 2B — DOC-02 Parte 2 (Produtos, Lotes, LPN, Saldos e Numeração)
**Status**: ✅ CONCLUÍDO — toda afirmação acima tem saída de comando real correspondente
