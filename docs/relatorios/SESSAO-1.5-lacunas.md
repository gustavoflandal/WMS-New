# SESSÃO 1.5 — REGISTRO DE LACUNAS E CONFLITOS

**Data**: 2026-08-15
**Sessão**: 1.5 — Fechamento DOC-01 (retomada pós-reboot Docker)
**Substitui**: versão de 2026-08-12, que listava "bloqueadores críticos" (rate
limit tests, scheduler) sem nunca ter rodado um teste real — ver
`SESSAO-1.5-relatorio.md` §0.

---

## 1. LACUNAS RESOLVIDAS NESTA SESSÃO

Estes itens apareciam como "bloqueador crítico" no documento anterior e foram
efetivamente resolvidos e validados com saída real nesta sessão:

| ID anterior | Descrição | Status agora |
|:---|:-------|:-----------|
| LAC-S1.5-001 | Rate limit tests + integração em app.module | ✅ RESOLVIDO — `rate-limit.guard.integration.spec.ts` (4 tests PASS); guard já estava registrado globalmente via `RateLimitModule`/`APP_GUARD` (`core.module.ts`), só faltava o teste e um bug de DI (`@Optional()`) corrigido nesta sessão |
| LAC-S1.5-002 | Prometheus `/metrics` endpoint | ✅ RESOLVIDO — `core/metrics/` já implementado; validado com `curl localhost:3000/metrics` real contra worker publicando de verdade |

---

## 2. LACUNAS RESIDUAIS (NÃO BLOQUEADORAS do escopo desta sessão)

### LAC-S1.5-003: Scheduler Job (Partition Manager)
**Referência**: RNF-ARQ-090
**Descrição**: `APP_ROLE=scheduler` sobe, fica `healthy` (o container não morre
mais — efeito colateral de uma correção desta sessão em `main.ts`), mas não
executa nenhuma tarefa agendada. Não existe scheduler job real chamando
`create_event_outbox_partition()`.
**Por que não é bloqueador desta sessão**: o `ENTREGÁVEIS` do prompt original
desta sessão (`docs/PROMPT-SESSAO-1.5-workers.md`) cobre apenas
outbox-publisher, realtime-fanout, rate limiting e eliminação do
`fix-esm-imports.js` — scheduler job não está na lista, e o próprio `main.ts`
já documentava isso como fora de escopo antes desta sessão começar.
**Impacto real**: `wms.event_outbox` (particionada mensalmente, RNF-ARQ-091)
não terá partições novas criadas automaticamente — precisa de intervenção
manual ou da sessão que implementar o scheduler antes de ir para produção.
**Prioridade**: 🟡 ALTA, mas não bloqueia o fechamento desta sessão.

### LAC-S1.5-004: k6 Smoke Test Baseline
**Referência**: RNF-ARQ-081
**Descrição**: Não existe script de carga (`infra/k6/smoke.js`).
**Por que não é bloqueador**: idem — não está no ENTREGÁVEIS do prompt desta
sessão.

### LAC-S1.5-005: Container `frontend` não validado nesta sessão
**Descrição**: A porta `3001` já estava em uso por um container de outro
projeto (`vagalume-backend`) no mesmo Docker Desktop. A imagem buildou com
sucesso; o container ficou em `Created`. Não é um bug do código deste
repositório — é um conflito de ambiente local.
**Ação**: rodar `docker compose -f infra/docker-compose.yml up -d frontend`
isoladamente em uma máquina/ambiente sem esse conflito de porta (ou parar o
container do outro projeto, fora do escopo desta sessão decidir por conta
própria).

### LAC-S1.5-006 (antigo): Frontend E2E — Degradation Modes
**Referência**: RF-ARQ-040 + RF-ARQ-043
**Status**: inalterado — Session 2 (frontend integration), fora de escopo.

### LAC-S1.5-007 (antigo): OpenTelemetry Exporter Real
**Referência**: RNF-ARQ-071
**Status**: inalterado — Session 2 (observabilidade completa), fora de escopo.

### LAC-S1.5-008: Event→Topic Mapping Completeness
**Referência**: RF-ARQ-041
**Descrição**: `EVENT_TOPIC_MAPPING` (`packages/contracts/src/realtime-topics.ts`)
tem apenas `teste.evento_emitido`. Worker loga warn e ACKa sem derrubar
(comportamento correto, testado em `pollStreams()`).
**Resolução Prevista**: Sessions 2+, conforme módulos de negócio adicionam
`event_type`s reais.

---

## 3. CONFLITOS DETECTADOS

**Status**: 9 bugs reais de infraestrutura/wiring encontrados e corrigidos
nesta sessão (schema_migration ausente, credenciais de pool conflitadas,
migrations re-rodando, testes em paralelo destrutivos, Dockerfile.backend
quebrando o symlink de `@wms/contracts`, DI do RateLimitGuard, `app.init()`
ausente para worker/scheduler, healthcheck com `curl` ausente na imagem,
healthcheck não drenando a resposta HTTP). Detalhados com causa raiz em
`SESSAO-1.5-relatorio.md` §2. Nenhum permanece aberto.

---

## 4. ITENS LEGITIMAMENTE DEFERRED (NÃO SÃO LACUNAS)

Inalterado em relação ao documento anterior — continuam corretos:

### PWA Offline Sync (RNF-ARQ-050..054)
Session 3. Estrutura pronta: `sync_operation` (idempotency_key, lamport_clock,
conflict_resolution).

### Edge Agent Drivers (DOC-11)
Session 2 (DOC-11). Estrutura pronta: `edge_agent`, `edge_agent_job`.

### RBAC Real + JWT (DOC-12)
Session 2 (DOC-12). Estrutura pronta: rate limit guard, `Authorization` header
check (sem extração real de `user_id` do JWT ainda — `[LACUNA: DOC-12]`
comentada em `rate-limit.guard.ts`).

### Conflict Resolution Strategy (RN-ARQ-053)
Session 3. Estrutura pronta: `sync_operation.conflict_resolution` JSON.

---

## 5. MATRIZ DE RASTREABILIDADE — LACUNAS

| LAC-ID | Descrição | Bloqueador desta sessão? | Sessão-alvo | Prioridade |
|:-------|:----------|:-----------|:-------|:----------|
| S1.5-003 | Scheduler job (partitions) | ❌ NÃO (fora do escopo original) | 1.5+ | 🟡 ALTA |
| S1.5-004 | k6 baseline | ❌ NÃO (fora do escopo original) | 1.5+ | 🟢 MÉDIA |
| S1.5-005 | Container frontend não validado (conflito de porta local) | ❌ NÃO | — (ambiente) | 🟢 BAIXA |
| S1.5-006 | Frontend E2E degradation | ❌ NÃO | 2 | 🟢 BAIXA |
| S1.5-007 | OTel exporter real | ❌ NÃO | 2 | 🟢 BAIXA |
| S1.5-008 | Event mapping completeness | ❌ NÃO | 2+ | 🟢 BAIXA |

---

## CONCLUSÃO

- **0 bloqueadores** para o Definition of Done desta sessão (build, testes
  unitários e de integração, Docker completo com `backend-api` saudável,
  `/health/ready` e `/metrics` respondendo — tudo validado com saída real).
- **2 lacunas de prioridade alta** seguem abertas mas eram explicitamente fora
  do escopo do prompt original (`docs/PROMPT-SESSAO-1.5-workers.md`):
  scheduler job real e k6 baseline.
- **9 bugs de infraestrutura** descobertos e corrigidos ao rodar contra
  Postgres/Redis/Docker reais pela primeira vez — nenhum estava documentado
  como lacuna antes, porque nada havia sido executado de verdade.

---

**Gerado**: 2026-08-15
**Validação**: com saída de comando real em cada afirmação (ver
`SESSAO-1.5-relatorio.md`)
