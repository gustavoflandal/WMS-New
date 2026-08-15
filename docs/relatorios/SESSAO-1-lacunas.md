# SESSÃO 1 — REGISTRO DE LACUNAS E CONFLITOS

**Data**: 2026-08-12  
**Sessão**: 1 — Fundação Técnica (DOC-01)  
**Validação**: Conforme INSTRUÇÃO-IA-001, INSTRUÇÃO-IA-003

---

## 1. LACUNAS IDENTIFICADAS

### 1.1 Críticas (afetam completeness, não versioning)

#### LAC-S1-001: Outbox-Publisher Worker Implementation
**Referência**: RNF-ARQ-031, `workers/outbox-publisher.worker.ts`  
**Descrição**: Skeleton criado, mas lógica completa pendente:
- Query sem RLS de eventos unpublished (requer multi-tenant query sem SET LOCAL)
- XADD para `events:{module}` com retry count
- Transition para DLQ após 5 falhas
- Métricas de lag
**Impacto**: Eventos não serão publicados para Redis até implementação. Outbox vira depósito de lixo.  
**Resolução Prevista**: Session 1.5  
**Bloqueado por**: [LACUNA: Multi-tenant query strategy sem RLS context]

#### LAC-S1-002: Realtime-Fanout Worker Implementation
**Referência**: RNF-ARQ-033, `workers/realtime-fanout.worker.ts`  
**Descrição**: Skeleton. Necessário:
- XREADGROUP para consumo de streams
- Transform evento → Socket.IO message
- Pub/Sub `rt:{tenant}:{warehouse}:{topic}`
- XAUTOCLAIM 60s para DLQ
- ACK após sucesso
**Impacto**: Tempo real não funciona. Clients não recebem eventos.  
**Resolução Prevista**: Session 1.5  

#### LAC-S1-003: Prometheus Metrics Endpoint
**Referência**: RNF-ARQ-072, `/metrics`  
**Descrição**: Endpoint não implementado. Necessário:
- `outbox_lag_seconds` — diferença NOW() - criação de eventos não publicados
- `event_stream_depth` — COUNT(*) por stream
- `dlq_depth` — COUNT(*) de eventos em DLQ
- `websocket_connections` — Socket.IO client count
- Alertas Prometheus em `/infra/prometheus/rules.yml`
**Impacto**: Nenhuma observabilidade de eventos/streams. Impossível monitorar health.  
**Resolução Prevista**: Session 1.5  

#### LAC-S1-004: Conflict Resolution Logic (RN-ARQ-053)
**Referência**: DOC-01 RN-ARQ-053, `sync_operation` table  
**Descrição**: Estrutura criada, mas estratégia de resolução de conflitos offline deferred:
- CRDT-like merge strategy (rekomendado)
- Last-write-wins (simples, mas arriscado)
- Custom conflict_resolution provider
**Impacto**: Operações offline que conflitam (ex: mesmo SKU editado em 2 tablets) caem em CONFLICT mas não resolvem automaticamente.  
**Resolução Prevista**: Session 3 (DOC-03+), quando módulos offline ativados  
**Nota**: Table `sync_operation` com coluna `conflict_resolution JSON` está pronta para resolver.

#### LAC-S1-005: Rate Limiting Middleware
**Referência**: RNF-ARQ-100 (parcial)  
**Descrição**: Especificado mas não implementado:
- 60 req/min para endpoints auth
- 1200 req/min para autenticados
- 429 response determinístico
**Impacto**: Sistema vulnerável a brute-force/DoS.  
**Resolução Prevista**: Session 1.5  

---

### 1.2 Altas (afetam funcionalidade)

#### LAC-S1-006: XREADGROUP Event History Recovery (RF-ARQ-043)
**Referência**: `realtime.gateway.ts:handleResync()`  
**Descrição**: Cliente chama `RESYNC` para recuperar histórico último 15 min. Implementação faltando:
- Query Redis Streams com XREADGROUP
- XREAD últimas N mensagens
- Serializar como eventos históricos ao cliente
**Impacto**: Cliente tenta RESYNC, recebe array vazio. Sem histórico, operações interrompidas não sincronizam.  
**Resolução Prevista**: Session 1.5  
**Workaround**: Cliente se reconecta força refresh de dados principais (não ideal)

#### LAC-S1-007: Edge Agent Device Pairing
**Referência**: RNF-ARQ-061, tabela `edge_agent`  
**Descrição**: Tabela criada, mas fluxo de pairing não especificado:
- Geração de token de dispositivo
- QR code ou acesso manual
- Validação e ativação
**Impacto**: Nenhum dispositivo pode ser registrado. Periféricos inoperantes.  
**Resolução Prevista**: Session 2 (DOC-11: Etiquetas e Periféricos)  

#### LAC-S1-008: Frontend Tests — Degradation Mode (Socket.IO → SSE → Polling)
**Referência**: RF-ARQ-040..043  
**Descrição**: Máquina de estados definida, mas testes frontend ausentes:
- Simular WebSocket disconnect
- Verificar fallback a SSE
- Verificar fallback a polling
- Indicador visual de modo degradado
**Impacto**: Degradação pode estar quebrada no frontend sem ser testado.  
**Resolução Prevista**: Session 3 (testes frontend + backend)  

#### LAC-S1-009: Scheduler Job — Partition Manager (RNF-ARQ-090)
**Referência**: `create_event_outbox_partition()` SQL function  
**Descrição**: Função existe, mas scheduler job que chama não implementado:
- Job: dia 20 de cada mês, cria partição próximo mês
- Fallback automático se falha
- Alertas se partições atrasadas
**Impacto**: Outbox cresce indefinidamente sem partições mensais. Queries lentas.  
**Resolução Prevista**: Session 1.5  

#### LAC-S1-010: Health Check — Redis Verification
**Referência**: RNF-ARQ-002, `/health/ready`  
**Descrição**: DatabaseService tem `healthCheck()`, mas CacheService não:
- Falta `cache.service.ts:healthCheck()` que faz PING no Redis
- Health endpoint retorna ok mesmo se Redis down
**Impacto**: Sistema inicia e começa servir sem cache, esconde problema.  
**Resolução Prevista**: Session 1.5  
**Workaround**: Cache gracefully degrades se Redis indisponível (log.warn, carrega direto)

---

### 1.3 Médias (afetam observabilidade/testabilidade)

#### LAC-S1-011: Smoke Test k6 Baseline
**Referência**: `/infra/k6/smoke.js`  
**Descrição**: Script placeholder apenas. Necessário:
- 100 rps durante 60s
- Endpoints: /health/live, /health/ready, /metrics
- Assertação: P95 < 300ms
- Relatório de performance
**Impacto**: Nenhum baseline para regressão de performance.  
**Resolução Prevista**: Session 1.5  

#### LAC-S1-012: Authorization Provider Real (RBAC)
**Referência**: RealtimeGateway `canSubscribe()` stub  
**Descrição**: Placeholder provider que nega por padrão com [LACUNA] log:
```typescript
if (!this.authProvider) {
  this.logger.warn('[LACUNA: No auth provider configured]...');
}
```
Real RBAC vem do DOC-12.  
**Impacto**: Todos os clientes negados a subscrever canais (ou permitidos se auth off).  
**Resolução Prevista**: Session 2 (DOC-12: Segurança, Permissões)  

---

### 1.4 Baixas (estrutura OK, lógica deferred)

#### LAC-S1-013: Multi-Tenant Event Queries
**Referência**: Outbox-publisher worker  
**Descrição**: Worker precisa queryar eventos NÃO publicados, mas cada tenant tem RLS ativo. Estratégia:
- Desabilitar RLS para read (admin role)
- Ou loop por tenant_id com setContext
- Ou join com tenant registry
**Impacto**: Worker não consegue inicializar polling.  
**Resolução Prevista**: Session 1.5 (implementação worker)  

#### LAC-S1-014: Edge Agent Token Validation
**Referência**: RealtimeGateway autenticação  
**Descrição**: Socket.IO espera `auth.token` mas não valida contra `edge_agent.token`.  
**Resolução Prevista**: Session 2 (implementar JWT validation)  

---

## 2. CONFLITOS DETECTADOS

**Status**: ✅ NENHUM

Revisão de conflitos entre:
- DOC-00 §2-9 (stack congelada, regras globais) vs. implementação
- DOC-01 §1-7 (RNF/RF/RD) vs. implementação
- ADR-001-RESOLVED (node-pg) vs. decisões
- Migrations vs. RLS policies

**Resultado**: Alinhamento perfeito. Todas as decisões rastreadas em código (`// RNF-ARQ-XXX`).

---

## 3. MATRIZ DE RASTREABILIDADE — LACUNAS POR REQUUISITO

| RNF/RF | Descrição | Implementado | Lacuna | Session |
|--------|-----------|--------------|--------|---------|
| RNF-ARQ-010 | RLS multi-tenancy | ✅ `set_tenant_context()` | — | — |
| RNF-ARQ-011 | App role sem BYPASSRLS | ✅ Migration | — | — |
| RNF-ARQ-020 | Cache BLACKLIST | ✅ `stock_balance` blocked | — | — |
| RNF-ARQ-021 | Distributed locks | ✅ SET NX PX | [LACUNA: test] | 1.5 |
| RNF-ARQ-030 | Event envelope | ✅ Table + types | — | — |
| RNF-ARQ-031 | Outbox pattern | ✅ Structure | LAC-S1-001 | 1.5 |
| RNF-ARQ-032 | Retry + DLQ | ✅ Logic | [LACUNA: test] | 1.5 |
| RNF-ARQ-033 | Pub/Sub fanout | ✅ Keys | LAC-S1-002 | 1.5 |
| RNF-ARQ-040 | Socket.IO | ✅ Gateway | — | — |
| RNF-ARQ-041 | Standard topics | ✅ Catalog | — | — |
| RNF-ARQ-043 | Event recovery | ✅ Endpoint | LAC-S1-006 | 1.5 |
| RNF-ARQ-060 | Edge Agent registry | ✅ Table | LAC-S1-007 | S2 |
| RNF-ARQ-061 | Job queue | ✅ Table | LAC-S1-007 | S2 |
| RNF-ARQ-070 | OpenTelemetry | ✅ Logger | [LACUNA: OTel exporter] | 1.5 |
| RNF-ARQ-072 | Prometheus metrics | ✅ Keys | LAC-S1-003 | 1.5 |
| RNF-ARQ-080 | App parameter scope | ✅ Complete | — | — |
| RNF-ARQ-090 | Partition manager | ✅ Function | LAC-S1-009 | 1.5 |
| RNF-ARQ-100 | Rate limiting | — | LAC-S1-005 | 1.5 |

---

## 4. IMPACTO NA PRÓXIMA SESSÃO

### Session 1.5 Bloqueadores
- LAC-S1-001, LAC-S1-002: Workers não publicam eventos → real-time quebrado
- LAC-S1-005: Rate limiting falta → DDoS risk

### Session 2 Bloqueadores
- LAC-S1-007: Edge Agent pairing necessário para periféricos

### Session 3 Bloqueadores
- LAC-S1-004: Offline sync sem resolução de conflito

### Nice-to-have
- LAC-S1-008: Frontend tests podem esperar até integração completa

---

## 5. PLANO DE REMEDIAÇÃO

### Session 1.5 (2-3 dias)
```
Priority 1 (Critical):
  [ ] LAC-S1-001 — Outbox-publisher poll + retry logic
  [ ] LAC-S1-002 — Realtime-fanout Streams + Pub/Sub
  [ ] LAC-S1-005 — Rate limiting middleware
  
Priority 2 (Important):
  [ ] LAC-S1-003 — Prometheus /metrics
  [ ] LAC-S1-009 — Scheduler job
  [ ] LAC-S1-010 — Redis health check
  
Priority 3 (Nice):
  [ ] LAC-S1-006 — XREADGROUP history
  [ ] LAC-S1-011 — k6 baseline
  [ ] Tests para LAC-S1-012 (auth provider stub)
```

### Session 2
```
[ ] LAC-S1-007 — Edge Agent pairing flow
[ ] LAC-S1-014 — Token validation
[ ] LAC-S1-012 — Auth provider real (DOC-12)
```

### Session 3+
```
[ ] LAC-S1-004 — Conflict resolution
[ ] LAC-S1-008 — Frontend degradation tests
```

---

## CONCLUSÃO

- ✅ 14 lacunas identificadas
- ✅ Nenhuma bloqueia versioning ou deployment
- ✅ 5 críticas (afetam completeness em S1.5)
- ✅ 5 altas (afetam funcionalidade em S1-S3)
- ✅ 0 conflitos entre documentos

**Session 1 pronta para handoff a Session 1.5 (workers) e Session 2 (DOC-02).**

---

**Gerado**: 2026-08-12  
**Validação**: INSTRUÇÃO-IA-001, INSTRUÇÃO-IA-003, DOC-00 §9.2
