# DOC-01 — AUDITORIA DE COBERTURA

**Data**: 2026-08-15
**Sessão**: 1.5 — Fechamento (retomada pós-reboot Docker)
**Status**: ver metodologia abaixo — nem tudo neste documento tem evidência
re-verificada nesta sessão, e isso é declarado explicitamente por item.

---

## 0. Por que este documento foi reescrito

A versão anterior (2026-08-12) marcava 42/54 requisitos como "✅ ATENDIDO"
citando arquivos como `infra/postgres/init/01-schema.sql` (que não existe no
repositório — as migrations reais vivem em `infra/postgres/migrations/`) e
arquivos de teste com nomes que nunca existiram (`outbox.spec.ts` em vez de
`outbox.integration.spec.ts`). A auditoria da retomada desta sessão
(`SESSAO-1.5-HANDOFF-EM-ANDAMENTO.md` §0) confirmou que nada daquele documento
havia sido validado contra execução real.

Reescrever as 54 linhas com evidência re-verificada individualmente extrapola
o escopo desta sessão (workers, rate limiting, métricas — ver
`docs/PROMPT-SESSAO-1.5-workers.md`). Este documento portanto:

- **Seção 1**: audita com rigor total (evidência real desta sessão) os itens
  que ESTAVAM no escopo da Sessão 1.5.
- **Seção 2**: preserva o mapeamento herdado para os demais itens do DOC-01,
  mas marcado explicitamente como `NÃO RE-VERIFICADO NESTA SESSÃO` — trata-se
  de contexto herdado, não de uma nova alegação de "testado e passando".

---

## 1. ITENS DO ESCOPO DA SESSÃO 1.5 — RE-VERIFICADOS COM EVIDÊNCIA REAL

### RNF-ARQ-030: Event Envelope
- **Status**: ✅ ATENDIDO (re-verificado)
- **Implementação**: `EventEnvelope` interface (`event_type`, `tenant_id`,
  `warehouse_id`, `payload`, `correlation_id`, `causation_id`) —
  `events.service.ts`
- **Teste real**: `outbox.integration.spec.ts` (4 tests, PASS) — os 2 últimos
  `it()` usavam o contrato antigo (`aggregate_type`/`module`/`data`) e foram
  corrigidos nesta sessão para o contrato real

### RNF-ARQ-031/032: Outbox Pattern + Retry [INVIOLÁVEL]
- **Status**: ✅ ATENDIDO (re-verificado)
- **Implementação**: `outbox-publisher.worker.impl.ts` — `SELECT ... FOR
  UPDATE SKIP LOCKED`, `XADD events:{modulo}`, `UPDATE published_at` na mesma
  transação (ADR-006)
- **Teste real**:
  - `outbox-publisher-concurrency.integration.spec.ts` — 2 réplicas
    concorrentes, 100 eventos, cada `event_id` publicado exatamente 1× (PASS)
  - `e2e-event-pipeline.integration.spec.ts` — pipeline completo via workers
    reais (PASS)

### RNF-ARQ-033: Pub/Sub Fanout + DLQ
- **Status**: ✅ ATENDIDO (re-verificado)
- **Implementação**: `realtime-fanout.worker.impl.ts` — `XGROUP CREATE`,
  `XREADGROUP`, ACK só após publish OK, `XAUTOCLAIM`+`XPENDING` → DLQ após
  `maxRetries`
- **Teste real**: `realtime-fanout-dlq.integration.spec.ts` — mensagem presa
  no PEL movida para `events:dlq` após exceder `maxRetries` entregas, original
  ACKado (PASS)

### RNF-ARQ-042/088: Latência ≤ 2s / P95
- **Status**: ✅ ATENDIDO (re-verificado)
- **Teste real**: `e2e-event-pipeline.integration.spec.ts` — latência medida
  fim-a-fim via workers reais + subscriber Redis real (não mais simulado).
  Saída real: `Pipeline latency: 70ms`, `p95=23ms` (ambiente local; sem carga
  de rede real, mas o mecanismo é o de produção, não um mock)

### RNF-ARQ-072: Prometheus Metrics
- **Status**: ✅ ATENDIDO (re-verificado — a versão anterior deste documento
  marcava isso como "estrutura + keys", com `/metrics` como `[LACUNA:
  endpoint]"; o endpoint já existe e foi validado)
- **Implementação**: `core/metrics/` (`MetricsService`, `MetricsController`),
  `prom-client`, `outbox_lag_seconds`/`outbox_pending_total` lidos do Redis
  (empurrados pelo worker, RNF-ARQ-072)
- **Teste real**: `curl -s localhost:3000/metrics | grep outbox_lag_seconds`
  contra `backend-api` e `backend-worker` reais em Docker — saída colada em
  `SESSAO-1.5-relatorio.md` §4

### RNF-ARQ-090/091: Partition Management
- **Status**: 🟡 PARCIAL (re-verificado — SQL function existe, scheduler não)
- **Implementação**: particionamento mensal via função SQL
- **Lacuna real**: nenhum job agendado chama a função — `APP_ROLE=scheduler`
  sobe e fica `healthy`, mas não executa nada (ver `SESSAO-1.5-lacunas.md`
  LAC-S1.5-003)
- **Futuro**: sessão dedicada ao scheduler

### RNF-ARQ-100: Rate Limiting
- **Status**: ✅ ATENDIDO (re-verificado — a versão anterior citava "Rate
  limit spec" que não existia; o teste foi escrito nesta sessão)
- **Implementação**: `RateLimitGuard` — 60/min `/auth`+não-autenticado,
  1200/min autenticado, 429 + `Retry-After` + `application/problem+json`,
  isenção `/health/*`+`/metrics`, guard global via `APP_GUARD`
  (`RateLimitModule`, importado em `CoreModule`)
- **Bug corrigido nesta sessão**: construtor tinha um parâmetro de opções que
  o Nest tentava injetar via DI (`Cannot resolve dependencies... (CacheService,
  ?)`) — faltava `@Optional()`
- **Teste real**: `rate-limit.guard.integration.spec.ts` (4 tests, PASS) —
  estouro em `/auth`, estouro autenticado, tier não-autenticado usa o limite
  mais restrito (não um terceiro patamar), isenção sem contador criado

### RNF-ARQ-011: Application Role (RLS, sem BYPASSRLS)
- **Status**: ✅ ATENDIDO (bug corrigido nesta sessão, agora re-verificado)
- **Bug encontrado**: `.env` define `POSTGRES_USER=postgres` (necessário para
  o `MigrationRunner` rodar DDL); `DatabaseService` lia essa MESMA variável
  para o pool de request-path — em produção, o pool que serve requisições
  HTTP estaria conectando como `postgres` (superuser, bypassa RLS), violando
  este próprio requisito
- **Correção**: namespace de credenciais separado — `POSTGRES_APP_USER`/
  `POSTGRES_APP_PASSWORD` (default `wms_app`/`wms_app_password`) para o pool
  de aplicação; `POSTGRES_USER`/`PASSWORD` ficam reservados para
  bootstrap/migrations
- **Teste real**: `rls.integration.spec.ts` (5 tests, PASS) contra o pool
  corrigido

### Item 4 do prompt original: eliminação de `fix-esm-imports.js`
- **Status**: ✅ ATENDIDO (herdado da sessão anterior, `pnpm build` e `docker
  compose up -d --build` re-verificados nesta sessão SEM o script)
- **Teste real**: `pnpm build` (nest build, sem erros) + build de imagem
  Docker completo (`docker compose up -d --build`) funcionando sem qualquer
  pós-processamento de imports

---

## 2. DEMAIS ITENS DO DOC-01 — HERDADO, NÃO RE-VERIFICADO NESTA SESSÃO

Os itens abaixo estavam fora do escopo desta sessão. O status é o herdado do
documento anterior — **não foi re-executado nenhum teste ou comando para
confirmar estas linhas nesta sessão**. Tratar como contexto histórico, não
como afirmação nova.

| Requisito | Status herdado | Observação |
|-----------|----------------|------------|
| RNF-ARQ-001 Monorepo Structure | Atendido | estrutura inalterada |
| RNF-ARQ-002 Health Checks | Atendido | `health.controller.ts` existe; não re-executado nesta sessão além do que `/health/ready` real confirmou (ok) |
| RNF-ARQ-003 Multi-Role Bootstrap | Atendido — **corrigido nesta sessão** | `app.init()` estava faltando para worker/scheduler (ver §1 do relatório) |
| RNF-ARQ-004 Next.js App Router | Atendido | não re-verificado; container `frontend` não subiu nesta sessão (conflito de porta local, ver lacunas) |
| RNF-ARQ-010/012/013 RLS/SET LOCAL/Policy Template | Atendido | `rls.integration.spec.ts` re-executado nesta sessão (PASS), mas o texto descritivo não foi re-auditado linha a linha |
| RNF-ARQ-020/021 Cache BLACKLIST / Locks | Atendido | `blacklist.integration.spec.ts` re-executado nesta sessão (PASS) |
| RNF-ARQ-040/041 Socket.IO Gateway / Topics | Atendido (estrutura) | não re-verificado nesta sessão |
| RNF-ARQ-043 Event Recovery | Parcial | não re-verificado |
| RNF-ARQ-050..054 PWA Offline | Não iniciado (legítimo) | Session 3 |
| RNF-ARQ-060/061 Edge Agent | Atendido (estrutura) | Session 2 (DOC-11) |
| RNF-ARQ-070 Structured Logging | Atendido | não re-verificado |
| RNF-ARQ-071 OpenTelemetry | Parcial | Session 2 |
| RNF-ARQ-080 App Parameter Scope | Atendido | `scope-resolution.integration.spec.ts` re-executado nesta sessão (PASS) |
| RNF-ARQ-081 Performance Baseline (k6) | Parcial | fora do escopo desta sessão |
| RNF-ARQ-101/102 CORS / Helmet | Atendido / Parcial | não re-verificado |
| RF-ARQ-040/041/042/043 Realtime | Atendido/Parcial | RF-ARQ-042 (latência) re-verificado via E2E nesta sessão; os demais não |
| RN-ARQ-050/051/053 Sync Operation | Parcial/Não iniciado (legítimo) | Session 3 |
| RD-ARQ-001..006 Schemas | Atendido | schemas re-lidos nesta sessão ao corrigir migrations (0001-0007), estruturalmente consistentes com o que está descrito |

---

## 3. RESUMO EXECUTIVO

| Categoria | Re-verificado nesta sessão (evidência real) | Herdado (não re-verificado) |
|-----------|:---:|:---:|
| Itens no escopo da Sessão 1.5 (workers, rate limit, metrics, RLS pool) | 8 | 0 |
| Demais itens do DOC-01 | 0 | ~46 |

O objetivo desta seção não é reduzir a cobertura declarada do DOC-01, mas
deixar claro **qual fração desta auditoria tem comando real por trás**, depois
que a sessão anterior demonstrou o custo de declarar ✅ sem executar nada.

---

## 4. ITENS LEGITIMAMENTE FUTUROS (inalterado)

### PWA Offline (RNF-ARQ-050..054)
Session 3 — requer IndexedDB + `RN-ARQ-053` (conflict resolution). Estrutura
(`sync_operation`) pronta.

### Edge Agent Drivers (DOC-11)
Session 2 — drivers de periféricos são específicos a cada hardware. Estrutura
(`edge_agent`, `edge_agent_job`) pronta.

### RBAC Real + JWT (DOC-12)
Session 2 — módulo de segurança separado. `RateLimitGuard` já verifica a
presença de `Authorization`, mas a extração real de `user_id` do JWT é
`[LACUNA: DOC-12]`, comentada em `rate-limit.guard.ts`.

### Conflict Resolution Strategy (RN-ARQ-053)
Session 3 — decisão arquitetural (CRDT/LWW/custom), espera ativação do PWA.

---

**Data**: 2026-08-15
**Auditor**: Sessão 1.5 (retomada pós-reboot Docker)
**Próximo**: revisão completa item-a-item do DOC-01 (fora do escopo desta
sessão) antes de assumir ✅ nos itens da seção 2, ou Session 2 (DOC-02)
