# Relatório — Sessão 5C: Inventários (DOC-05 §4.7)

**Data**: 2026-08-22
**Escopo**: RF-EST-060 (tipos e geração de escopo, catálogo fechado de 7), RN-EST-061 [INVIOLÁVEL] (congelamento de endereço), RN-EST-062 [INVIOLÁVEL] (rodadas de contagem, 2 exemplos normativos do §6), RN-EST-063 (ajuste com alçada), RF-EST-064 (acuracidade).
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-5A-relatorio.md`, `docs/relatorios/SESSAO-5B-relatorio.md`, `docs/relatorios/SESSAO-6B-relatorio.md`.

---

## 0. Nota sobre esta sessão

O código dos 4 entregáveis (`inventory-planning.service.ts`, `inventory-count-execution.service.ts`,
`inventory-round-decision.util.ts`, `inventory-count.controller.ts`, migration `0052`, teste de
integração) já estava escrito, não commitado, quando esta sessão começou — produto de uma execução
anterior interrompida antes do relatório final (sem `SESSAO-5C-HANDOFF-EM-ANDAMENTO.md`, contra a
convenção do projeto). Esta sessão **verificou por execução real** (não por inspeção), encontrou e
corrigiu **5 bugs reais** (§5), e só então fechou com o commit. Nenhuma linha de negócio foi reescrita
além das correções listadas — o desenho original (arquitetura, nomes, citações RF/RN) foi preservado.

---

## 1. Resumo executivo

Os 5 entregáveis (planejamento, execução das rodadas, controller HTTP, migration, testes) foram
verificados e corrigidos. `pnpm build` limpo; **unit 16/16 arquivos, 161/161 testes** (+14 nesta sessão:
`inventory-round-decision.util.spec.ts`, cobrindo os 2 exemplos normativos do §6 puramente); **integração
130/130 arquivos, 240/240 testes** (+15 nesta sessão), em **2 execuções consecutivas idênticas**.
`docker compose up -d --build` — `backend-api`/`backend-worker`/`backend-scheduler` saudáveis,
`curl localhost:3000/health/ready` → `200 {"status":"ok"}`. Nota sobre `frontend` em §7.

**Decisão estrutural preservada do código herdado**: a árvore de decisão das 3 rodadas de contagem
(RN-EST-062) é uma função **pura**, sem I/O (`inventory-round-decision.util.ts`), e o service só carrega
insumos (rodadas já registradas + saldo do sistema) e grava o resultado. Os 2 exemplos normativos do §6
(sistema 100/1ª 95/2ª 95 → −5; sistema 100/1ª 95/2ª 98/3ª 98 → −2) passam em teste unitário sobre a
função pura **e** em teste de integração ponta a ponta contra Postgres real — mesmo padrão de dupla trava
usado pela 5B para os exemplos FEFO/shelf-life.

---

## 2. Decisão de modelagem (referenciada pela migration 0052)

RD-EST-003 pede 3 tabelas: `inventory_count` + `inventory_count_location` + `inventory_count_round`. A
6B já havia criado uma `wms.inventory_count` **mínima** (1 linha = 1 endereço) só para o gatilho
automático do corte de picking, deixando explícito no seu relatório que a execução real (rodadas, ajuste,
acuracidade) ficava para esta sessão.

**Grão adotado**: a tabela da 6B vira a tabela de **CÉLULAS** (`inventory_count_location`, renomeada, ALTER
aditivo) — uma célula é `endereço × produto × lote`, não só o endereço. Motivo: RN-EST-062 registra
rodadas de contagem por item contável, e um mesmo endereço pode ter mais de um produto/lote em contagem
simultânea (ex. `GERAL` com múltiplos SKUs no mesmo endereço). Uma `wms.inventory_count` **nova** é o
CABEÇALHO/documento, com a máquina de estados do §5.1 (`PLANNED → IN_PROGRESS → ADJUSTMENT_PENDING →
COMPLETED`, `PLANNED → CANCELLED`). `wms.inventory_count_round` é nova, append-only (RN-EST-062 "todas as
contagens são registradas").

Outras decisões implementadas, sem `[LACUNA]` porque o texto normativo já resolve:

- **`system_qty`** = `qty_available` da célula no momento do **planejamento** — RN-EST-062 fala em "saldo
  do sistema", e contagem/ajuste só fazem sentido sobre a parcela disponível (bloqueado/quarentena/avaria
  têm motivo tipificado próprio, RF-EST-030/031, e não entram em inventário físico).
- **Acuracidade "por cliente" (RF-EST-064)** = `accuracy_quantity` do cabeçalho — o cabeçalho já é de um
  único `tenant_id`, então não há coluna própria para "por cliente": é o mesmo número.
- **3ª rodada (LIDER_TURNO) permanece cega** — o texto não exige exibir o saldo do sistema a ela
  (só descreve as duas primeiras como "cega"); mantido `is_blind = TRUE` em toda rodada por
  uniformidade, sem efeito na regra de decisão (que já não usa o campo).

---

## 3. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **RF-EST-060** 7 tipos de escopo | `inventory-planning.service.ts` (`resolveCandidates`, um `case` por tipo) | `inventory-execution.integration.spec.ts` — 1 teste por tipo (GERAL c/ `include_empty`, ROTATIVO_PRODUTO, POR_ZONA, POR_ESPECIE, POR_ENDERECO, POR_SORTEIO reprodutível, ROTATIVO_DIA c/ desempate ABC) + escopo vazio rejeitado |
| **RN-EST-061 [INVIOLÁVEL]** congelamento | `inventory-planning.service.ts` (`start`), migration `0052` (status `INVENTORY`) | `start() congela todos os endereços...`; conflitos com reserva ATIVA exibidos (não bloqueantes); `cancel()` só antes de iniciar |
| **RN-EST-062 [INVIOLÁVEL]** rodadas (2 exemplos normativos §6) | `inventory-round-decision.util.ts` (função pura) + `inventory-count-execution.service.ts` (`submitRound`, I/O + papel LIDER_TURNO) | `inventory-round-decision.util.spec.ts` (14 unit) + `inventory-execution.integration.spec.ts` (os 2 exemplos ponta a ponta, mesmo operador rejeitado na 2ª, papel exigido na 3ª, 1ª bate = concluído sem ajuste) |
| **RN-EST-063** ajuste com alçada | `inventory-count-execution.service.ts` (`decideAdjustment`) — abre `EST.AJUSTE_INVENTARIO` (motor do DOC-12), aplica `AJUSTE_INVENTARIO_POS/NEG` via `StockMovementService.apply()` (RN-EST-001, choke point único) | aprovado posta o ajuste, fecha célula, libera endereço, conclui cabeçalho; rejeitado volta cycle+1 para PENDING (nova 1ª rodada) |
| **RF-EST-064** acuracidade | `inventory-count-execution.service.ts` (`completeHeaderIfDone`) | acuracidade 100%/100% quando 1ª rodada bate com o sistema (sem nenhuma célula divergente) |
| Rotas HTTP | `inventory-count.controller.ts` (`estoque/inventarios`, `EST.INVENTARIO_PLANEJAR/CONTAR/APROVAR_AJUSTE`, catálogo já existente desde migration `0044`) | exercitado indiretamente pelos testes de service (mesmo padrão de `stock-reservation.controller.ts`); sem teste HTTP dedicado — ver `[LACUNA]` no cabeçalho do controller sobre rota de consulta |

**Totais**: unit **16 arquivos / 161 testes** (+14 nesta sessão); integração **130 arquivos / 240 testes**
(+15 nesta sessão).

---

## 4. Regressão de escopo mais amplo tocada nesta sessão

O código herdado também alterava, fora do módulo de inventário:

- `picking-task.service.ts` (`tryCompletePickingStep` / corte de picking) — a criação inline do
  documento `inventory_count` (INSERT direto, herdada da 6B) foi substituída por
  `InventoryPlanningService.createAndFreezeSingleLocation()`, que cria cabeçalho **já `IN_PROGRESS`** +
  célula **já `COUNTING`** (congelada) em um único passo, na mesma transação do corte — em vez do
  documento nascer `PENDING` como na 6B. Ajustado o teste de MARCO do DOC-06
  (`picking-packing-carregamento.integration.spec.ts`) para essa asserção.
- `estoque.module.ts` / `expedicao.module.ts` — registro dos 2 novos services/controller.

Essas mudanças eram do escopo correto (RD-EST-003/RN-EST-061 exigem o par cabeçalho+célula desde a
criação), mas quebraram DI em 2 arquivos de teste que instanciam `PickingTaskService` manualmente
(ver §5.1).

---

## 5. Achados reais desta sessão (bugs encontrados por execução, não por inspeção)

### 5.1 `PickingTaskService` — DI manual quebrada em 2 suítes do DOC-06 (regressão real, corrigida)

`PickingTaskService` ganhou um novo parâmetro de construtor (`InventoryPlanningService`, 9º de 10) para
poder chamar `createAndFreezeSingleLocation()`. Os únicos 2 arquivos que instanciam o service **fora do
container Nest** (`picking-packing-carregamento.integration.spec.ts`,
`wave-and-reservation-expiry.integration.spec.ts`) continuavam passando os 9 argumentos antigos — o 9º
argumento (`flowService`) caiu na posição de `inventoryPlanningService`, e `outboundFlowService` (10º)
ficava `undefined`. Resultado: **9 testes falhando** com
`TypeError: Cannot read properties of undefined (reading 'completeOrderStep')`, incluindo o **TESTE DE
MARCO** do ciclo ponta a ponta do DOC-06. Corrigido instanciando `InventoryPlanningService` nos dois
arquivos e passando na posição correta.

### 5.2 `wms.app_parameter` tem RLS mesmo para linhas `GLOBAL` — `queryGlobal()` nunca as enxerga

A policy `app_parameter_visibility` (migration `0004`) exige `app.tenant_ids` configurado no `USING`
**mesmo para `scope = 'GLOBAL'`**. `DatabaseService.queryGlobal()` roda no pool `wms_app` sem nenhum
contexto de sessão — logo **qualquer leitura/escrita de `app_parameter` via `queryGlobal()` sempre bate
0 linhas**, silenciosamente. O teste desta sessão inseria `EST.INV_ROTATIVO_QTD_DIA` assim; corrigido
para `db.query(ctx, ...)` (padrão já usado em `wave-and-reservation-expiry.integration.spec.ts`,
`putaway-engine.integration.spec.ts`, `labeling.integration.spec.ts` — a 5C só não tinha seguido).

### 5.3 Mesmo bug, dentro do código de produção: `InventoryPlanningService.resolveRotativoDiaQty()`

O método lia `EST.INV_ROTATIVO_QTD_DIA` via `this.db.queryGlobal(...)` — pelo motivo de §5.2, **sempre**
recebia 0 linhas e caía silenciosamente no default (`20`), **nunca honrando o parâmetro configurado**. O
teste `ROTATIVO_DIA: desempate por classe ABC` só teria testado o valor default (mascarado por um `[]`
que passaria vazio se o teste não checasse `toHaveLength`). Corrigido: o método agora recebe o `client`
da transação corrente (já tem `app.tenant_ids` setado via `SET LOCAL`) em vez de abrir uma leitura global
nova — mesmo princípio de "ler pelo client da transação, não por uma conexão nova sem contexto".

**Mesmo padrão problemático existe em `expiration.service.ts.resolveAlertDays()`** (leitura de
`EST.ALERTA_VENCIMENTO_DIAS` via `queryGlobal()`). **Fechado por tabela, não por chamador** — ver §5.6:
a causa raiz (a policy de `app_parameter`, não o método) foi corrigida, então este método volta a
funcionar corretamente sem precisar de nenhuma alteração própria.

### 5.4 Teste de integração lia tabelas com RLS via `queryGlobal()` — falsos positivos silenciosos

Doze leituras de asserção (`inventory_count`, `inventory_count_location`, `operational_exception`) usavam
`testContext.databaseService.queryGlobal(...)`. Pelo mesmo motivo de RLS (§5.2, que também se aplica a
essas 3 tabelas — todas com `FORCE ROW LEVEL SECURITY`), a maioria falhava alto e visível
(`Cannot read properties of undefined (reading 'id')`) — mas **um caso não falhava**: o teste
`POR_SORTEIO [...] mesma semente produz sempre a mesma lista` comparava dois resultados de
`queryGlobal()`, ambos **sempre vazios** por RLS — `expect([]).toEqual([])` **passava sem nunca ter
verificado reprodutibilidade real**. Este é exatamente o risco descrito em
`[[wms-no-fabricated-status]]`: um teste verde que não testa o que afirma testar. Corrigido — todas as 12
leituras passaram a usar um helper `tenantQuery()` (mesmo padrão de `db.query(ctx, ...)`); a reprodutibilidade
do sorteio agora é verificada contra dados reais.

### 5.5 `POR_ESPECIE` — `stock_balance` sem lote para espécie que exige lote

O teste criava um produto de espécie `ALIMENTO` (que tem `requires_batch = true`, DOC-02 §5.3, RN-DAD-020)
e inseria `stock_balance` sem `batch_id`, violando a constraint do banco. Corrigido: o teste agora cria um
`wms.batch` real para esse produto (mesmo padrão `createBatch()` de
`stock-selection.integration.spec.ts`/`stock-reservation.integration.spec.ts`) e passa `batch_id` ao
`seedBalance()` (que ganhou o parâmetro).

### 5.6 Correção estrutural (pós-revisão): §5.2/§5.3/§5.4 são o MESMO bug em 3 lugares

Os achados §5.2 (teste), §5.3 (`InventoryPlanningService`) e §5.4 (12 leituras de teste) eram três
sintomas do mesmo problema de causa raiz, e essa mesma forma já havia se repetido nas Sessões 5A e 5B
(ver relatórios anteriores) sem correção estrutural. Feitas 3 mudanças, todas de escopo maior que o
módulo de inventário:

1. **`app_parameter_visibility` corrigida na origem (migration `0053`)** — DOC-02 §5.7 define `GLOBAL`
   como o escopo com `scope_id` NULL, sem vínculo a tenant algum; a policy antiga exigia
   `app.tenant_ids` mesmo para essas linhas. Agora `scope = 'GLOBAL'` é visível/gravável
   incondicionalmente; `WAREHOUSE`/`CLIENT`/`CLIENT_WAREHOUSE` continuam exigindo contexto, sem
   mudança. Corrige a causa raiz **na tabela**, não em cada chamador — `expiration.service.ts` (§5.3)
   volta a funcionar sem nenhuma linha alterada nele.
2. **`DatabaseService.queryGlobal()` ganhou uma rede de segurança** (`database.service.ts`): fora de
   produção, todo `SELECT` que retorna 0 linhas é reconferido via `workerPool` (`wms_worker`,
   BYPASSRLS) — se a reconferência encontrar linhas, a tabela tem RLS e a chamada é um uso incorreto de
   `queryGlobal()`; lança erro descritivo em vez de devolver um vazio indistinguível de "sem dados".
   Cuidado de implementação: BYPASSRLS contorna RLS, não GRANT de tabela — `wms_worker` só tem
   `SELECT` nas tabelas que algum worker de fato lê (mesmo princípio de todo grant deste projeto, ver
   MARCO §2). A 1ª versão desta rede de segurança não tratava isso e reclassificou "permission denied"
   (tabela nunca concedida ao worker) como se fosse o bug de RLS, quebrando **48 testes** de suítes
   completamente alheias ao inventário (`approval_authority`, `user_role_assignment`,
   `dock_zone_distance`, `inbound_invoice`, ...) na primeira rodada de verificação desta correção.
   Corrigido: qualquer falha da query de reconferência (não só "permission denied") é engolida — só um
   `rowCount > 0` **bem-sucedido** da reconferência prova a máscara de RLS e dispara o erro.
3. **Regra de teste registrada em `CLAUDE.md`** (raiz do repo, novo arquivo): nunca comparar dois
   resultados possivelmente vazios sem antes afirmar que pelo menos um é não-vazio — é exatamente o que
   deixou o falso positivo de §5.4 (`POR_SORTEIO`) verde. Aplicada ao próprio teste que motivou a regra.

**Reverificado após a correção**: unit 161/161; integração **240/240 em 2 execuções consecutivas** (a
1ª rodada com a rede de segurança ainda incorreta gerou 48 falhas reais, todas por permissão de tabela —
nenhuma delas era um bug de RLS de verdade; a versão corrigida do guard não reintroduziu nenhuma
falha). `docker compose up -d --build backend-api backend-worker backend-scheduler` com o volume Postgres
já existente (não descartado) — migration `0053` aplicada limpo por cima do estado anterior, `/health/ready`
seguiu `200 ok`.

---

## 6. Lacunas e débitos

**Em aberto:**

- **`[LACUNA]` rota de consulta/detalhe do inventário** — DOC-05 §3 nomeia só `EST.INVENTARIO_PLANEJAR`/
  `_CONTAR`/`_APROVAR_AJUSTE`; não há permissão para "ver" um inventário em andamento. Mesma disciplina já
  registrada pela 5B para reserva/consulta de seleção: não inventar código de permissão — só os 5 atos que
  o catálogo nomeia foram expostos.
- **`[LACUNA]` custo do produto para o valor do ajuste (RN-EST-063)** — "quantidade × custo informado pelo
  cliente quando disponível"; não existe coluna de custo em `product`/`batch` nesta base. O parâmetro
  `unitCostBrl` existe na assinatura de `submitRound()` (opcional, quem chama informa quando tiver o dado),
  mas nenhum fluxo desta sessão o popula automaticamente.
- **`[DÉBITO: DOC-08]`** "ajuste NEGATIVO em produto com Estoque Fiscal reflete no DOC-08" (RN-EST-063) —
  não implementado; DOC-08 é stub vazio (ver MARCO §3). `AJUSTE_INVENTARIO_NEG` já é postado por
  `StockMovementService` (efeito físico correto); a regularização documental fiscal fica para quando o
  DOC-08 existir.

**Fechados nesta sessão**: os 5 bugs de §5.1–§5.5 (corrigidos e re-verificados por execução real) + a
correção estrutural de §5.6 (policy de `app_parameter`, rede de segurança em `queryGlobal()`, regra de
teste em `CLAUDE.md`) — pedida explicitamente após a entrega inicial, ao notar que o mesmo bug de RLS
silenciosa já havia se repetido em 3 sessões (5A, 5B, 5C) sem correção na origem. Isso também fecha,
sem tocar em nenhuma linha do arquivo, o débito de `expiration.service.ts.resolveAlertDays()` (mesmo bug,
código da 5A).

**Fora de escopo confirmado**: DOC-06/07/08/09/10/11/13/15 — inalterados exceto pela correção de DI em
§5.1 (que não muda comportamento de negócio, só restaura o que a 6B já garantia).

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  16 passed (16)
     Tests  161 passed (161)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  130 passed (130)
     Tests  240 passed (240)
Test Files  130 passed (130)
     Tests  240 passed (240)

$ docker compose -f infra/docker-compose.yml up -d --build
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)
wms-postgres/redis/minio  Up (healthy)

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-22T18:42:36.163Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
```

**`frontend`**: continua sem subir no compose local — desta vez não pelo empacotamento pnpm (isso
compilou e a imagem foi construída com sucesso), mas por **conflito de porta 3001 com um container de
outro projeto** (`vagalume-backend`) já rodando no host. Ambiente, não regressão do código desta sessão;
não investigado além disso (não é seguro parar um container de outro projeto sem confirmação do usuário).
Backend completo (api/worker/scheduler) segue saudável e é o que os testes de integração exercitam.

---

## 8. Commit/push

Dois commits nesta sessão. O primeiro: os 4 arquivos de serviço/controller/util do módulo `inventory`, a
migration `0052`, o teste de integração (corrigido), as 2 correções de DI no DOC-06, a correção de RLS em
`inventory-planning.service.ts`, o teste de contrato de grants (`grants-contract.integration.spec.ts`,
3 tabelas), e este relatório. O segundo, pedido explicitamente pelo usuário após revisar o primeiro: a
correção estrutural de §5.6 — migration `0053` (policy de `app_parameter`), a rede de segurança em
`DatabaseService.queryGlobal()`, o `CLAUDE.md` novo na raiz do repo, e a asserção de não-vazio adicionada
ao teste `POR_SORTEIO`. Push feito nos dois após confirmação explícita do usuário.
