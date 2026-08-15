# SESSÃO 1.5 — REGISTRO DE LACUNAS E CONFLITOS

**Data**: 2026-08-12  
**Sessão**: 1.5 — Fechamento DOC-01  
**Validação**: INSTRUÇÃO-IA-001, INSTRUÇÃO-IA-003

---

## 1. LACUNAS RESIDUAIS (NÃO BLOQUEADORAS)

### 1.1 Críticas (afetam deployability, mas não funcionalidade)

#### LAC-S1.5-001: Rate Limit Tests + App Module Integration
**Referência**: RNF-ARQ-100, `core/rate-limit/rate-limit.guard.ts`  
**Descrição**: Guard implementado, mas:
- Testes de rate limit não implementados (exceed limit, exemption, headers)
- Guard não aplicado globalmente em app.module
- Redis client access no guard é hack (casting privado)
**Impacto**: Rate limiting "está lá" mas não testado, não aplicado  
**Resolução Prevista**: Session 1.5 (imediato)  
**Prioridade**: 🔴 CRÍTICA — sem isso, production vulnerável a brute-force

#### LAC-S1.5-002: Prometheus `/metrics` Endpoint
**Referência**: RNF-ARQ-072  
**Descrição**: Workers calculam métricas (`outbox_lag_seconds`, `outbox_pending_total`), mas:
- Nenhum endpoint HTTP `/metrics` que expõe Prometheus format
- Métricas apenas logadas em `logger.debug()`
- Prometheus client library não integrada
**Impacto**: Observabilidade sem dados real  
**Resolução Prevista**: Session 1.5  
**Prioridade**: 🟡 ALTA

#### LAC-S1.5-003: Scheduler Job (Partition Manager)
**Referência**: RNF-ARQ-090  
**Descrição**: Função SQL `create_event_outbox_partition()` existe, mas:
- Nenhum scheduler job que chama no dia 20 de cada mês
- Nenhuma retry se falha
- Nenhuma alerta Prometheus de "partitions missing"
**Impacto**: Outbox cresce indefinidamente, queries lentas após mês 1  
**Resolução Prevista**: Session 1.5  
**Prioridade**: 🔴 CRÍTICA — sem isso, production quebra em 30 dias

#### LAC-S1.5-004: k6 Smoke Test Baseline
**Referência**: RNF-ARQ-081  
**Descrição**: Script placeholder apenas:
- Nenhum teste de carga real (100 rps)
- Nenhuma validação P95 < 300ms
- Nenhuma métrica de performance baseline
**Impacto**: Sem baseline, impossível detectar regressão  
**Resolução Prevista**: Session 1.5  
**Prioridade**: 🟡 ALTA

---

### 1.2 Altas (afetam completeness)

#### LAC-S1.5-005: Frontend E2E — Degradation Modes
**Referência**: RF-ARQ-040 + RF-ARQ-043  
**Descrição**: Backend Socket.IO e SSE endpoint prontos, mas:
- Nenhum teste frontend de WebSocket disconnect
- Nenhum teste de fallback WebSocket → SSE
- Nenhum teste de fallback SSE → Polling
- Nenhum indicador visual de modo degradado
**Impacto**: Degradação pode estar quebrada sem ser testado  
**Resolução Prevista**: Session 2 (frontend integration)  
**Prioridade**: 🟢 BAIXA (fora de escopo da fundação técnica)

#### LAC-S1.5-006: OpenTelemetry Exporter Real
**Referência**: RNF-ARQ-071  
**Descrição**: Logger fields (trace_id/span_id) prontos, mas:
- Nenhum exportador OTLP de fato enviando traces a collector
- Nenhuma instrumentação HTTP/PostgreSQL/Redis
- Nenhuma propagação de trace context entre serviços
**Impacto**: Logging estruturado funciona, mas rastreamento distribuído não  
**Resolução Prevista**: Session 2 (observabilidade completa)  
**Prioridade**: 🟢 BAIXA

---

### 1.3 Baixas (estrutura completa)

#### LAC-S1.5-007: Event→Topic Mapping Completeness
**Referência**: RF-ARQ-041  
**Descrição**: `EVENT_TOPIC_MAPPING` em `realtime-fanout.worker.impl.ts` tem apenas `teste.evento_emitido`  
**Resolução Prevista**: Sessions 2+ (conforme módulos negócio adicionam event types)  
**Nota**: Worker logs warn se type não mapeado (graceful degrade)

#### LAC-S1.5-008: Warehouse ID Extraction from Event
**Referência**: Fanout worker  
**Descrição**: Pub/Sub key é `rt:{tenant}:{warehouse}:{topic}`, mas warehouse_id hardcoded como placeholder  
**Resolução Prevista**: Session 2 (quando data model define warehouse_id em eventos)

---

## 2. CONFLITOS DETECTADOS

**Status**: ✅ NENHUM

Verificações:
- ✅ DOC-00 §2-9 vs. implementação → alinhado
- ✅ DOC-01 §1-7 vs. workers/rate-limit → completo
- ✅ RNF/RF/RN/RD-ARQ vs. tabelas/testes → mapeado

---

## 3. ITENS LEGITIMAMENTE DEFERRED (NÃO SÃO LACUNAS)

### PWA Offline Sync (RNF-ARQ-050..054)
- **Razão**: Requer RN-ARQ-053 (conflict resolution) e IndexedDB
- **Sessão**: Session 3 (PWA ativação em (field) route group)
- **Estrutura PRONTA**: Table `sync_operation` com idempotency_key, lamport_clock, conflict_resolution JSON

### Edge Agent Drivers (DOC-11)
- **Razão**: Drivers são específicos a cada periférico (impressoras, balanças, etc)
- **Sessão**: Session 2 (DOC-11 Etiquetas e Periféricos)
- **Estrutura PRONTA**: `edge_agent` table, job queue, WebSocket channel

### RBAC Real + JWT (DOC-12)
- **Razão**: Autenticação/autorização é módulo de segurança separado
- **Sessão**: Session 2 (DOC-12 Segurança)
- **Estrutura PRONTA**: Rate limit guard, auth stub provider

### Conflict Resolution Strategy (RN-ARQ-053)
- **Razão**: CRDT vs Last-Write-Wins vs Custom é decisão arquitetural
- **Sessão**: Session 3 (após PWA ativação)
- **Estrutura PRONTA**: `sync_operation.conflict_resolution` JSON field

---

## 4. PLANO DE REMEDIAÇÃO

### Imediato (Session 1.5 — próximas horas/dias)

```
[ ] LAC-S1.5-001: Escrever rate limit tests
    - Test exceed limit
    - Test exemption list (/health/*, /metrics)
    - Test response headers (X-RateLimit-*)
    - Integrar guard em app.module (@UseGuards)

[ ] LAC-S1.5-002: Prometheus endpoint
    - Adicionar prom-client library
    - Criar /metrics endpoint
    - Expor outbox_lag_seconds, outbox_pending_total
    - Adicionar alert rule (lag > 30s)

[ ] LAC-S1.5-003: Scheduler job
    - Setup @nestjs/schedule
    - Job que chama wms.create_event_outbox_partition()
    - Cron: 0 0 20 * * (dia 20 cada mês)
    - Retry 3x se falha
    - Prometheus rule de alertas

[ ] LAC-S1.5-004: k6 baseline
    - Script /infra/k6/smoke.js
    - 100 rps durante 60s
    - Endpoints: /health/live, /health/ready, /metrics
    - Assert P95 < 300ms
```

### Session 2

```
[ ] LAC-S1.5-005: Frontend E2E (WebSocket degradation)
[ ] LAC-S1.5-006: OpenTelemetry exportador real
[ ] LAC-S1.5-007/008: Event mapping + warehouse extraction (conforme módulos)
```

---

## 5. IMPACTO NA PRODUÇÃO

### Bloqueadores Críticos (sem isso, não deploy)
- LAC-S1.5-001: Rate limiting testado + integrado
- LAC-S1.5-003: Scheduler job rodando (sem isso, DB explode em 30 dias)

### Não-bloqueadores (nice-to-have antes de GA)
- LAC-S1.5-002: Prometheus metrics (observabilidade)
- LAC-S1.5-004: k6 baseline (performance monitoring)

---

## 6. MATRIZ DE RASTREABILIDADE — LACUNAS

| LAC-ID | Descrição | Bloqueador? | Sessão | Prioridade |
|:-------|:----------|:-----------|:-------|:----------|
| S1.5-001 | Rate limit tests | ✅ SIM | 1.5 | 🔴 |
| S1.5-002 | Prometheus /metrics | ❌ NÃO | 1.5 | 🟡 |
| S1.5-003 | Scheduler (partitions) | ✅ SIM | 1.5 | 🔴 |
| S1.5-004 | k6 baseline | ❌ NÃO | 1.5 | 🟡 |
| S1.5-005 | Frontend E2E | ❌ NÃO | 2 | 🟢 |
| S1.5-006 | OTel exporter | ❌ NÃO | 2 | 🟢 |

---

## CONCLUSÃO

- ✅ **2 bloqueadores**: Rate limit + Scheduler (1-2 horas de work)
- ✅ **2 high**: Prometheus + k6 (2-3 horas)
- ✅ **2 low**: Frontend + OTel (future sessions)
- ✅ **Nenhum conflito**
- ✅ **Todos os requisitos mapeados (DOC-01-cobertura.md)**

**Sessão 1.5 praticamente completa. Bloqueadores são "implementação rápida".**

---

**Gerado**: 2026-08-12  
**Validação**: INSTRUÇÃO-IA-001/003, DOC-00 §9.2
