# SESSÃO 1.5 — RELATÓRIO FINAL

**Data**: 2026-08-15
**Título**: Fechamento do DOC-01 — Workers, Rate Limiting, Métricas, Docker completo
**Status**: ✅ CONCLUÍDO (com saída de comando real, ver §3 e §4)

---

## 0. Nota sobre o relatório anterior com a mesma data/título

Existia uma versão anterior deste arquivo (datada de 2026-08-12, "✅ CONCLUÍDO") que
declarava sucesso — incluindo `pnpm test` "20+ testes PASS" e `docker compose up`
funcionando — **sem nunca ter rodado nenhum desses comandos contra Postgres/Redis
reais**. A auditoria que motivou esta sessão (documentada em
`docs/relatorios/SESSAO-1.5-HANDOFF-EM-ANDAMENTO.md` §0) encontrou o worker
`outbox-publisher` consultando colunas inexistentes no schema real, o worker
`realtime-fanout` com o laço de consumo inteiramente comentado, e o teste "E2E"
simulando o pipeline em vez de chamar os workers. Este relatório substitui aquele,
com saída de comando real colada abaixo de cada afirmação.

---

## 1. ESCOPO DESTA SESSÃO (retomada pós-reboot do Docker)

Trabalho herdado do handoff: workers `outbox-publisher`/`realtime-fanout`
reescritos, rate limiting e `/metrics` implementados, `fix-esm-imports.js`
eliminado — mas **nada validado contra containers reais** (Docker indisponível).
Esta sessão:

1. Terminou os testes de integração pendentes (outbox rollback/correlation_id).
2. Reescreveu o teste E2E para chamar os workers reais (não mais simulado).
3. Escreveu os 3 testes exigidos pelo prompt original que faltavam: concorrência
   do outbox (2 réplicas, 100 eventos), DLQ do fanout, rate-limit guard.
4. Rodou a suíte de integração contra Postgres/Redis reais pela primeira vez —
   e corrigiu **9 bugs reais** que só se manifestam com infraestrutura real de
   pé (nunca antes exercitada), listados em §2.
5. Subiu `docker compose up -d --build` completo e validou `/health/ready` e
   `/metrics` com saída real.

---

## 2. BUGS REAIS ENCONTRADOS E CORRIGIDOS NESTA SESSÃO

Nenhum destes era visível sem rodar contra infraestrutura real — é exatamente a
categoria de erro que a sessão anterior "confirmou" sem testar.

| # | Bug | Onde | Causa raiz |
|---|-----|------|-----------|
| 1 | `wms.schema_migration` nunca era criada em nenhuma migration | `infra/postgres/migrations/0001-setup-roles.sql` | Migrations 0005-0007 (escritas na Sessão 1.5) inserem nela, mas nenhuma migration a cria — bootstrap antigo (deletado) fazia isso fora do diretório canônico |
| 2 | Pool de aplicação (RLS) conectava como `postgres` (superuser) em produção, não como `wms_app` | `database.service.ts`, `.env` | `.env` define `POSTGRES_USER=postgres` (necessário para o MigrationRunner rodar DDL); `DatabaseService` lia a MESMA variável para o pool de request — violava RNF-ARQ-011 (bypass de RLS) |
| 3 | `MigrationRunner` (`DatabaseModule`) tentava re-rodar migrations 1-4 em todo teste de integração | `test-setup.ts` | Setup global aplicava as migrations via SQL cru sem gravar em `schema_migration`; `DatabaseModule` via isso como "não aplicado" e tentava rodar `CREATE POLICY` sem `DROP POLICY IF EXISTS` correspondente |
| 4 | Arquivos de teste de integração corriam em paralelo e se corrompiam mutuamente | `vitest.config.integration.ts` | `blacklist.integration.spec.ts` roda `redisClient.flushDb()` a cada teste — em paralelo, isso apagava streams/grupos que outro arquivo acabara de criar |
| 5 | Container `backend-api`/`worker`/`scheduler` morria com `ERR_MODULE_NOT_FOUND: @wms/contracts` | `infra/Dockerfile.backend` | Build rodava só `nest build` (não builda `packages/contracts`) e depois **apagava `packages/`** no cleanup — quebra o symlink pnpm do workspace |
| 6 | Nest não conseguia instanciar `RateLimitGuard` (`APP_GUARD`) | `rate-limit.guard.ts` | Construtor tinha um 2º parâmetro `options` que o Nest tentava resolver via DI; faltava `@Optional()` |
| 7 | Worker de outbox lançava `TypeError: Cannot read properties of undefined (reading 'connect')` a cada poll | `main.ts` | `APP_ROLE=worker`/`scheduler` nunca chamavam `app.init()`/`app.listen()`, então `DatabaseService.onModuleInit()` nunca rodava e os pools ficavam `undefined` |
| 8 | `backend-api` sempre "unhealthy" mesmo respondendo 200 | `docker-compose.yml` | Healthcheck usava `curl`, ausente na imagem `node:20-slim` |
| 9 | Mesmo após corrigir #8, healthcheck ainda expirava (timeout 5s) | `infra/Dockerfile.backend` | O one-liner Node não drenava a resposta HTTP nem chamava `process.exit()` — o processo ficava pendurado até o timeout |

Além disso, a assertion do teste de rollback do outbox foi fortalecida (era
`expect(result.rows).toBeDefined()`, que passaria mesmo se o rollback não
funcionasse) para `expect(count).toBe(0)`.

---

## 3. SAÍDA REAL — TESTES

```
$ pnpm run build   (apps/backend)
> nest build
(sem erros)

$ pnpm run type-check   (apps/backend)
> tsc --noEmit
(sem erros)

$ pnpm test   (unitários)
 ✓ src/__tests__/health.spec.ts (2 tests) 5ms
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ pnpm test:integration
 ✓ src/core/app-parameter/__tests__/scope-resolution.integration.spec.ts (6 tests)
 ✓ src/__tests__/e2e-event-pipeline.integration.spec.ts (2 tests) 333ms
     Pipeline latency: 70ms
     Latencies: min=19ms, p95=23ms, max=23ms
 ✓ src/core/rate-limit/__tests__/rate-limit.guard.integration.spec.ts (4 tests)
 ✓ src/core/events/__tests__/outbox.integration.spec.ts (4 tests)
 ✓ src/workers/__tests__/outbox-publisher-concurrency.integration.spec.ts (1 test) 1088ms
 ✓ src/workers/__tests__/realtime-fanout-dlq.integration.spec.ts (1 test)
 ✓ src/core/database/__tests__/rls.integration.spec.ts (5 tests)
 ✓ src/core/cache/__tests__/blacklist.integration.spec.ts (4 tests)

 Test Files  8 passed (8)
      Tests  27 passed (27)
```

Suíte de integração rodada 3× de forma independente (após cada bug corrigido) —
27/27 estável nas 3 execuções, zero skip, zero mock de Postgres/Redis.

---

## 4. SAÍDA REAL — DOCKER COMPOSE COMPLETO

```
$ docker compose -f infra/docker-compose.yml up -d --build
...
NAME                    STATUS
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)
wms-minio               Up (healthy)
wms-postgres            Up (healthy)
wms-redis               Up (healthy)

$ curl localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-15T23:28:19.570Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ curl -s localhost:3000/metrics | grep outbox_lag_seconds
# HELP outbox_lag_seconds Age in seconds of the oldest unpublished wms.event_outbox row (RNF-ARQ-031/072)
# TYPE outbox_lag_seconds gauge
outbox_lag_seconds 0
```

**Nota sobre `frontend`**: o container `wms-frontend` não foi validado nesta
sessão — a porta 3001 já estava em uso por um container de OUTRO projeto no
mesmo Docker Desktop (`vagalume-backend`, não relacionado a este repositório).
A imagem do frontend foi buildada com sucesso (`✓ Compiled successfully`), mas
o container ficou em `Created` sem subir, por não ser meu container e por
`frontend` estar fora do escopo desta sessão (é `backend-api` que o DoD exige).
Não foi tomada nenhuma ação sobre o container do outro projeto.

**Nota sobre `backend-scheduler`**: sobe e fica `healthy` (efeito colateral da
correção do bug #7 — `app.init()` agora mantém conexões ativas mesmo sem HTTP
listener), mas **não executa nenhum job real ainda** — o partition-manager
(RNF-ARQ-090) continua fora de escopo desta sessão, como já documentado em
`main.ts`. Ver `SESSAO-1.5-lacunas.md`.

---

## 5. CENÁRIOS GHERKIN DO DOC-01 §6 — STATUS REAL

✅ **RLS bloqueia acesso entre tenants** — `rls.integration.spec.ts` (5 tests, PASS)
✅ **Outbox garante evento após commit / rollback impede persistência** —
`outbox.integration.spec.ts` (4 tests, PASS) — os 2 últimos `it()` (rollback,
correlation_id) estavam com o contrato antigo (`aggregate_type`/`data`) e foram
corrigidos para `payload`/`warehouse_id` nesta sessão.
✅ **E2E Pipeline ≤ 2s, via workers reais** —
`e2e-event-pipeline.integration.spec.ts` (2 tests, PASS) — reescrito nesta
sessão para chamar `OutboxPublisherWorkerImpl.pollBatch()` e
`RealtimeFanoutWorkerImpl.pollStreams()` de verdade, com um subscriber Redis
real inscrito ANTES da publicação (a versão anterior fazia `xAdd`/`xRange`
diretamente no teste, sem tocar nos workers).
✅ **Resolução de escopo app_parameter** — `scope-resolution.integration.spec.ts`
(6 tests, PASS)
✅ **Cache BLACKLIST enforcement** — `blacklist.integration.spec.ts` (4 tests, PASS)

Adicionalmente (exigidos pelo prompt original, não cobertos pelos 5 cenários
DOC-01 §6, mas obrigatórios pelo Definition of Done da Sessão 1.5):

✅ **Concorrência do outbox** (2 réplicas, 100 eventos, exactly-once no stream)
— `outbox-publisher-concurrency.integration.spec.ts` (1 test, PASS)
✅ **Caminho de DLQ do fanout** (XAUTOCLAIM/XPENDING, `maxRetries` excedido →
`events:dlq`) — `realtime-fanout-dlq.integration.spec.ts` (1 test, PASS)
✅ **Rate limit** (estouro em `/auth`, estouro autenticado, tier não-autenticado
usa o limite mais restrito, isenção de `/health`/`/metrics`) —
`rate-limit.guard.integration.spec.ts` (4 tests, PASS)

---

## 6. O QUE NÃO FOI FEITO NESTA SESSÃO (ver lacunas)

- Scheduler job real (partition manager, RNF-ARQ-090) — container sobe e fica
  `healthy`, mas não executa nenhuma tarefa agendada.
- Validação do container `frontend` (bloqueado por porta ocupada por outro
  projeto, fora do escopo do DoD desta sessão).
- k6 smoke baseline (RNF-ARQ-081) — não fazia parte do ENTREGÁVEIS do prompt
  original desta sessão.
- Reescrita de `DOC-01-cobertura.md` mantendo apenas os itens
  re-verificados nesta sessão com evidência real — ver esse arquivo.

---

## 7. ARQUIVOS CRIADOS/MODIFICADOS NESTA SESSÃO

**Testes novos**:
- `apps/backend/src/workers/__tests__/outbox-publisher-concurrency.integration.spec.ts`
- `apps/backend/src/workers/__tests__/realtime-fanout-dlq.integration.spec.ts`
- `apps/backend/src/core/rate-limit/__tests__/rate-limit.guard.integration.spec.ts`

**Testes corrigidos**:
- `apps/backend/src/core/events/__tests__/outbox.integration.spec.ts`
- `apps/backend/src/__tests__/e2e-event-pipeline.integration.spec.ts` (reescrito)

**Bugs corrigidos** (código de produção, não só teste):
- `infra/postgres/migrations/0001-setup-roles.sql` (tabela `schema_migration`)
- `apps/backend/src/core/database/database.service.ts` (credenciais separadas)
- `apps/backend/src/core/database/__tests__/test-setup.helper.ts`
- `apps/backend/test-setup.ts` (grava migrations aplicadas)
- `apps/backend/vitest.config.integration.ts` (`fileParallelism: false`)
- `infra/Dockerfile.backend` (build via turbo, não apaga `packages/`, healthcheck)
- `infra/docker-compose.yml` (`POSTGRES_APP_USER`/`PASSWORD`, remove healthcheck curl)
- `apps/backend/src/core/rate-limit/rate-limit.guard.ts` (`@Optional()`)
- `apps/backend/src/main.ts` (`app.init()` explícito)
- `.env`, `.env.example` (`POSTGRES_APP_USER`/`PASSWORD`)

**Documentação**:
- Este relatório
- `docs/relatorios/SESSAO-1.5-lacunas.md` (reescrito)
- `docs/relatorios/testes-pendentes-SESSAO-1.5.md` (substituído — teste já implementado)

---

**Gerado**: 2026-08-15
**Sessão**: 1.5 — Fechamento DOC-01 (retomada pós-reboot Docker)
**Status**: ✅ CONCLUÍDO — toda afirmação acima tem saída de comando real correspondente
