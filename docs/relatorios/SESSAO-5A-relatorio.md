# Relatório — Sessão 5A: DOC-05 Parte 1 (Movimentação, Bloqueios, Reclassificação/Descarte, Vencimento, Estoque de Segurança/Kanban, Transferências)

**Data**: 2026-08-18
**Escopo**: DOC-05 EXCETO Seleção de Saldo (RN-EST-010/011/012/013 — Sessão 5B, PREMIUM) e Inventários §4.7 (Sessão 5C).
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-4B-relatorio.md`.
**Sessão em duas partes**: iniciada e pausada a pedido do usuário no meio da regressão completa (entregáveis 1-2 prontos); retomada e concluída nesta data (entregáveis 3-7).

---

## 1. Resumo executivo

Todos os 7 entregáveis da missão foram implementados e testados. `pnpm build` limpo; **unit 11/11 arquivos, 107/107 testes**; **integração 55/55 arquivos, 171/171 testes**, ambos em **2 execuções consecutivas**. `docker compose up -d --build` sobe os 3 papéis, `curl localhost:3000/health/ready` responde `200`.

**Decisão estrutural da sessão**: `StockMovementService` (entregável 2) é o ÚNICO caminho para alterar `wms.stock_balance` — "proibido por construção" via trigger condicionado a session var (não `REVOKE`, porque o próprio serviço PRECISA escrever). Todos os módulos novos desta sessão (bloqueio, reclassificação, vencimento, estoque de segurança, kanban, reposição, transferências) passam por ele, nunca escrevem saldo diretamente. Essa disciplina foi o que revelou o bug real descrito no §3.1.

**Achado real mais importante**: `wms.stock_balance_unique` não usava `NULLS NOT DISTINCT` — por padrão do Postgres (pré-PG15), NULL nunca é igual a NULL para fins de `UNIQUE`/`ON CONFLICT`. Como `batch_id`/`pallet_id` são NULLable (produto sem lote/palete é o caso normal), todo crédito repetido no mesmo produto×endereço sem lote/palete criava uma linha NOVA em vez de somar na existente — quebrando RG-004 silenciosamente. Corrigido recriando a constraint com `NULLS NOT DISTINCT` (migration 0046). Ver §3.1.

---

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **Entregável 1 — Catálogo** (8 permissões, 4 exception_type, 13 eventos) | migration `0044` (permissões/exceções), `packages/contracts/src/realtime-topics.ts` (13 eventos `estoque.*`) | Sem teste dedicado (catálogo estático); consumido pelos testes dos entregáveis 3-6 |
| **RN-EST-001 [INVIOLÁVEL]** (18 `movement_type`, serviço único de saldo) | `modules/estoque/movement/stock-movement-effects.util.ts` (regra pura), `stock-movement.service.ts` (I/O), migration `0045` (CHECK + trigger de guarda) | `stock-movement-effects.util.spec.ts` (17 unit) + `stock-movement.service.integration.spec.ts` (17 integração: os 18 tipos contra Postgres real + RG-004 + o trigger de guarda rejeitando escrita direta) |
| **RF-EST-030** (bloqueio/desbloqueio, motivo tipificado) | `modules/estoque/blocking/stock-block.service.ts` + controller, migration `0046` | `stock-block-reclassification.integration.spec.ts` (2 testes: bloqueio/desbloqueio, motivo OUTRO+texto/motivo desconhecido) |
| **RF-EST-031** (reclassificação avaria + descarte, exceção EST.DESCARTE_SALDO 2 passos) | `modules/estoque/blocking/stock-reclassification.service.ts` + controller, migration `0046` (`stock_reclassification`) | `stock-block-reclassification.integration.spec.ts` (4 testes: fotos obrigatórias + CHECK do banco, descarte 2 passos com aprovadores distintos, descarte rejeitado não efetiva) |
| **RN-EST-014** (alerta de vencimento 90/60/30/15/0 + bloqueio automático) | `modules/estoque/expiration/expiration.service.ts`, `workers/expiration-alert.worker.impl.ts` | `expiration.integration.spec.ts` (1 teste: alerta no lote a 0 dias, bloqueio automático do lote vencido, saldo saudável intocado, idempotência na 2ª execução) |
| **RF-EST-040** (estoque de segurança, 1 notificação por cruzamento de limiar) | `modules/estoque/replenishment/safety-stock.service.ts` | `replenishment.integration.spec.ts` (cruzamento abaixo→acima→abaixo de novo, sem repetir enquanto permanece abaixo) |
| **RF-EST-041/042** (kanban + reposição dirigida, dupla leitura, idempotência) | `modules/estoque/replenishment/kanban.service.ts`, `replenishment-task.service.ts` + controller, `workers/replenishment-alert.worker.impl.ts`, migration `0047` (`replenishment_task`/`replenishment_operation`) | `replenishment.integration.spec.ts` (geração por kanban, dedup de tarefa aberta, dupla leitura com rejeição/reatribuição, execução move saldo, replay idempotente) |
| **RF-EST-050** (transferência interna, Fase 1 no destino) | `modules/estoque/transfer/stock-transfer.service.ts` + controller, migration `0048` | `stock-transfer.integration.spec.ts` (transferência imediata move saldo; destino BLOCKED reprovado sem override possível) |
| **RF-EST-051/RN-EST-052** (transferência entre armazéns §5.2 completo, RG-015 no destino) | idem + `PutawayEngineService.evaluateSingleLocationForProduct()` (extraído nesta sessão) | `stock-transfer.integration.spec.ts` (ciclo CREATED→PICKING→IN_TRANSIT→RECEIVING→COMPLETED, cancelamento antes do picking) |
| **Entregável 7** (regressão completa) | — | 2 execuções consecutivas de `pnpm test` e `pnpm test:integration` — ver §5 |

**Totais**: unit **11 arquivos / 107 testes**; integração **55 arquivos / 171 testes** (30 testes novos nesta retomada, em 5 arquivos novos).

---

## 3. Achados reais desta sessão

### 3.1 Bug real: `stock_balance_unique` sem `NULLS NOT DISTINCT`

Descoberto testando RF-EST-030 (bloqueio seguido de desbloqueio no mesmo produto×endereço, ambos sem lote/palete). `StockMovementService.credit()` faz `INSERT ... ON CONFLICT (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id) DO UPDATE`. Por padrão do Postgres (antes de `NULLS NOT DISTINCT`, PG15+), duas linhas com `batch_id`/`pallet_id` NULL **nunca** são consideradas conflitantes entre si — cada crédito repetido criava uma linha NOVA em vez de somar na existente. O saldo real ficava fragmentado em múltiplas linhas silenciosamente, e qualquer leitura que assumisse "uma linha por combinação" (a maioria) lia um valor errado. Corrigido recriando a constraint com `UNIQUE NULLS NOT DISTINCT (...)` na migration 0046 (Postgres 16, já suportado). Sem esse achado, RF-EST-030/RF-EST-041/RF-EST-050 (todos fazem crédito repetido no mesmo endereço) teriam saldo inconsistente em produção.

**Consolidação de dados pré-existentes (adicionado após revisão)**: aplicar `UNIQUE NULLS NOT DISTINCT` direto falharia com `duplicate key` em qualquer banco que já tivesse acumulado linhas duplicadas por causa do PRÓPRIO bug (exatamente o estado que um ambiente de dev/staging já rodando teria). A migration 0046 agora consolida ANTES do `ALTER TABLE`: agrupa `stock_balance` por chave com comparação NULL-safe (`IS NOT DISTINCT FROM`), soma as 6 parcelas (`qty_available/reserved/blocked/quarantine/damaged/in_transit`) na linha mais antiga do grupo e apaga as demais — um `DO $$ ... $$` idempotente (sem duplicata, é no-op; `HAVING COUNT(*) > 1` não retorna linhas). **Testado de ponta a ponta** contra um banco descartável: aplicadas as migrations 0001-0045 do zero, inseridas 2 linhas duplicadas cruas para a mesma chave (`qty_available` 30 e 20, `qty_reserved` 5 e 0, `qty_blocked` 0 e 8), migration 0046 aplicada dentro de uma única transação (replicando `MigrationRunner.runMigration()`, que envolve o arquivo inteiro em `BEGIN`/`COMMIT`) — resultado: 1 linha só, com `qty_available=50`, `qty_reserved=5`, `qty_blocked=8` (soma exata), `NOTICE` confirmando "1 linha(s) duplicada(s) consolidada(s)"; um `ON CONFLICT` real subsequente (mesmo padrão de `credit()`) somou corretamente na linha existente (150 = 50+100), provando o bug fechado; reexecução da migration inteira no banco já limpo foi um no-op silencioso (idempotência confirmada, sem `NOTICE` de consolidação na 2ª rodada).

### 3.2 Grants `wms_worker` (ADR-006) precisavam ser expandidos por tabela E por partição

Os novos jobs cross-tenant (RN-EST-014, RF-EST-040/041) tocam tabelas que `wms_worker` nunca havia lido/escrito antes: `wms.batch`, `wms.product`, `wms.product_species` (lidas por um trigger não-`SECURITY DEFINER` disparado por `StockMovementService`), `wms.location`, `wms.product_warehouse_parameter`. Faltando o GRANT, o erro só aparece em teste de integração real (`permission denied for table X`), não no `tsc`. Adicionalmente, `wms.stock_movement` e `wms.replenishment_task` são **particionadas** — GRANT no pai não propaga para as partições já existentes nem é herdado automaticamente por elas (mesmo comportamento já documentado na migration 0014 para o REVOKE de UPDATE/DELETE); foi necessário um `GRANT` retroativo nas partições existentes + atualizar as funções `ensure_*_partition()` para conceder também a `wms_worker` nas partições futuras.

### 3.3 `PutawayEngineService` precisou de uma variante sem palete formal

RF-EST-050 exige reusar os filtros Fase 1 do motor de putaway (RN-REC-040) "no destino" de uma transferência — mas o motor original (`evaluateSingleLocation`) é construído em torno de `wms.pallet_content`, que uma transferência avulsa (produto/lote/qty sem palete formal) não tem. Extraído `loadWarehouseLocationsCore()` (a lista de endereços candidatos, que **não depende de palete** — só de armazém) do método pré-existente `loadCandidateLocations()`, e adicionado `evaluateSingleLocationForProduct()` + `loadProductContext()`, que constroem o mesmo `PalletToStoreInput` a partir de um produto único em vez de conteúdo de palete. Reuso real da MESMA função pura `evaluatePutawayFilters()` — não uma reimplementação paralela dos 6 filtros. Refactor não-destrutivo: os 20 testes de putaway pré-existentes (12 + 8) continuam passando sem alteração.

### 3.4 RN-EST-052 (RG-015 no destino da transferência) veio "de graça"

Por construção do achado 3.3: como `evaluateSingleLocationForProduct()` reusa a Fase 1 completa (que já inclui a checagem de dono do Armazém Lógico, filtro 2), `StockTransferService.completeReceiving()` não precisou de nenhuma lógica adicional para RN-EST-052 — bastou chamar o mesmo método no armazém de destino.

### 3.5 Verificação — RN-EST-001 "fechado por construção" (varredura completa)

Pedido explícito de revisão antes do commit: varredura por `INSERT INTO wms.stock_balance`, `UPDATE wms.stock_balance` e `DELETE FROM wms.stock_balance`/`wms.stock_balance SET` em todo `apps/backend/src`. **Resultado: nenhuma escrita crua sobrevive fora do único caminho permitido.** Achados, por categoria:

- **Produção**: só `modules/estoque/movement/stock-movement.service.ts` (`debit()`/`credit()`) escreve em `stock_balance` — nenhum outro service, controller ou worker toca a tabela diretamente.
- **Testes (10 arquivos)**: todas as escritas cruas são fixtures pré-existentes (Sessão 2B/4A, ver handoff original) ou novas desta retomada, e em TODOS os casos a escrita está protegida por `rawAuthorizedQuery()` (helper de `cadastro/__tests__/test-helpers.ts`) ou por `SELECT set_config('app.stock_movement_authorized', 'true', true)` explícito dentro da mesma transação — nenhuma delas contorna o trigger de guarda.
- **Única exceção deliberada**: `stock-movement.service.integration.spec.ts` (o teste de RN-EST-001 desta sessão, §2 da tabela acima) tem 1 caso **propositalmente sem autorização**, para provar que o trigger de fato rejeita (`ERRCODE 42501`) — é o teste negativo, não uma violação.

Nada precisou ser corrigido nesta verificação — RN-EST-001 está fechado por construção como projetado.

---

## 4. Lacunas e débitos

**Documentados no código, resumidos aqui:**

- **`[DÉBITO]` RF-EST-051 "recebimento no destino como Ordem de Recebimento vinculada (conferência obrigatória)"** — não implementado. `completeReceiving()` credita saldo real via `StockMovementService` e valida a Fase 1 do motor, mas não abre uma Ordem de Recebimento nem uma sessão de Conferência (DOC-04) — reconstruir esse fluxo inteiro para um TRF era escopo grande demais para esta sessão (avaliado com calma na retomada, decisão registrada no cabeçalho de `stock-transfer.service.ts`).
- **`[DÉBITO]` RF-EST-031 "termo de descarte em PDF e notificação ao cliente; reflexo fiscal no DOC-08"** — nenhum pipeline de PDF, notificação formal ou módulo Fiscal (`modules/fiscal` é um stub vazio) existe nesta base ainda. O evento `estoque.descarte_efetivado` é o único sinal de notificação existente, mesmo precedente já usado por `CheckingService` (DOC-04) para a carta de divergência.
- **`[DÉBITO]` RF-EST-040/041 "todo evento de baixa"** — RF-EST-040/041 pedem avaliação tanto no scheduler (horário) quanto em "todo evento de baixa". Implementado só o job horário: acoplar a checagem a cada débito exigiria que `StockMovementService.apply()` (um primitivo genérico, sem conhecimento de regras de módulos específicos) chamasse serviços de domínio a cada movimentação, ou que RESERVA/PICKING (DOC-06, inexistente nesta base) o fizessem. Quando o motor de picking existir, deve chamar `SafetyStockService`/`KanbanService` diretamente no mesmo ponto de extensão.
- **`[DÉBITO]` RF-EST-041 seleção de origem por política de giro (RN-EST-011)** — explicitamente fora de escopo desta sessão (5B). `KanbanService` usa uma heurística provisória (maior saldo `qty_available` num endereço STORAGE que cubra a quantidade inteira), documentada como substituível quando a Seleção de Saldo real existir.
- **`[LACUNA]` RF-EST-041 arredondamento para embalagem de picking** — `kanban_replenish_qty` é usado literalmente, sem arredondar para múltiplos de embalagem de picking (exigiria resolver `product_packaging`, fora do escopo desta passada).
- **`[LACUNA]` RF-EST-041 "endereço(s) de picking do produto" (plural)** — modelado usando `product_warehouse_parameter.default_picking_location_id` (único endereço monitorado); kanban sem esse campo definido não gera tarefa (sem endereço de destino determinístico).
- **`[LACUNA]` RF-EST-050 "tarefa dirigida (dupla leitura)"** — só o caminho "imediata em tela" foi implementado; o caminho alternativo de tarefa dirigida para transferência interna (que reusaria a máquina de `ReplenishmentTaskService` com outro `movement_type`) não foi construído nesta sessão.
- **`[LACUNA]` RF-EST-042 "prioridade sobre putaway... pedido liberado dependente"** — depende de informação do DOC-06 (Picking/Expedição), inexistente nesta base; a fila de reposição hoje ordena só por `created_at`.
- Itens já fechados/herdados da sessão original (catálogo, RN-EST-001 núcleo): ver `docs/relatorios/SESSAO-5A-HANDOFF-EM-ANDAMENTO.md` §3 para o histórico completo de decisões da primeira metade da sessão (recontagem de 18 `movement_type`, mecanismo do trigger de guarda, atribuição de permissão por papel).
- **Fora de escopo confirmado da missão**: Seleção de Saldo (RN-EST-010/011/012/013 — Sessão 5B, PREMIUM), Inventários §4.7 (Sessão 5C).

---

## 5. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  11 passed (11)
     Tests  107 passed (107)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  55 passed (55)
     Tests  171 passed (171)
Test Files  55 passed (55)
     Tests  171 passed (171)
```

```
$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-api | grep RN-SEG-012
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-18T10:44:05.073Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version FROM wms.schema_migration WHERE version >= 44 ORDER BY version"
 44
 45
 46
 47
 48
```

**Nota sobre o `docker compose up`**: o volume Postgres de desenvolvimento (persistente, "2 dias" de idade, distinto do banco de teste que é recriado do zero a cada rodada) tinha 1 linha residual de manuseio manual anterior com `movement_type = 'RECEIVING_CREDIT'` (o mesmo placeholder pré-catálogo-fechado já corrigido nos fixtures de teste desta sessão) — a migration 0045 (CHECK fechado) rejeitou corretamente essa linha ao tentar aplicar a constraint, travando o boot do `backend-api`/`worker`/`scheduler`. Corrigido com um `UPDATE` pontual da linha para `ENTRADA_RECEBIMENTO` (mesmo valor real do catálogo já usado na correção de fixture equivalente, §5 do handoff original) — não é um problema do código desta sessão, é dado manual antigo do volume de dev local. `wms-frontend` não subiu nesta verificação por conflito de porta 3001 com um container de outro projeto não relacionado (`vagalume-backend`, `E:\VagaLume`) já rodando na máquina — fora do escopo desta sessão; os 3 papéis do backend (api/worker/scheduler), que são o que a missão pede verificar, estão saudáveis.

---

## 6. Commit/push

Nenhum commit foi feito. Aguardando confirmação explícita do usuário, conforme padrão de todas as sessões anteriores.
