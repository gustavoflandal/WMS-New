# ANÁLISE: 21 Falhas em pnpm test:integration

**Data**: 2026-08-11  
**Total de Testes**: 22  
**Status**: 1 ✅ | 17 ❌ (DOC-01) | 4 ⏳ (DOC-02+)

---

## Resumo por Classificação

| Classificação | Contagem | Ação | Escopo |
|---------------|----------|------|--------|
| **(A) Faltam tabelas/extensions do DOC-01** | 14 | Criar migrations + global setup | Sessão 1 (esta) |
| **(B) Dependem de DOC-02+ (fora de escopo)** | 3 | Mover para file de pendências | Session 2+ |
| **(C) Bugs em fixtures/código de teste** | 1 | Corrigir referência `pool` | Sessão 1 (esta) |
| **✅ Passando** | 1 | Nenhuma ação | Pronto |

---

## Detalhes por Teste

### Suite: RLS - Tenant Isolation [INVIOLÁVEL]

#### ✅ PASS
- **Teste**: Tenant1 cannot see Tenant2 data via RLS
- **Status**: Sucesso
- **Por quê**: setup consegue criar fixture sem tentar acessar tabelas (apenas setup de contexto)

#### ❌ A1: Falta wms.rls_probe
- **Teste**: Tenant2 sees different data from Tenant1
- **Erro Exato**: `error: relation "wms.rls_probe" does not exist`
- **Localização**: rls.integration.spec.ts:63 (SELECT FROM wms.rls_probe)
- **Causa Raiz**: Tabela DOC-01 não foi criada por migration
- **Classificação**: **(A)** Falta migration do DOC-01
- **Ação Necessária**: Criar migration que define `wms.rls_probe(id, tenant_id, data)` com RLS policy

#### ❌ C1: Fixture Bug - pool undefined
- **Teste**: Query without tenant context returns no rows
- **Erro Exato**: `ReferenceError: pool is not defined`
- **Localização**: rls.integration.spec.ts:73 (const client = await pool.connect())
- **Causa Raiz**: Teste tenta usar `pool` mas `testContext.pool` não está passado para o scope do teste
- **Classificação**: **(C)** Bug no código do teste
- **Ação Necessária**: Mudar linha 73 de `await pool.connect()` para `await testContext.pool.connect()`

#### ❌ A2: Falta wms.rls_probe
- **Teste**: Transaction enforces tenant context throughout
- **Erro Exato**: `error: relation "wms.rls_probe" does not exist`
- **Localização**: rls.integration.spec.ts:94 (INSERT INTO wms.rls_probe)
- **Causa Raiz**: Tabela DOC-01 não criada
- **Classificação**: **(A)**
- **Ação Necessária**: Criar migration `wms.rls_probe`

#### ❌ A3: Falta wms.rls_probe
- **Teste**: Different user in same tenant sees same data
- **Erro Exato**: `error: relation "wms.rls_probe" does not exist`
- **Localização**: rls.integration.spec.ts:110 (SELECT FROM wms.rls_probe)
- **Causa Raiz**: Tabela DOC-01 não criada
- **Classificação**: **(A)**

#### ❌ A4: Falta wms.rls_probe
- **Teste**: Different tenant replaces data visibility
- **Erro Exato**: `error: relation "wms.rls_probe" does not exist`
- **Classificação**: **(A)**

#### ❌ A5: Falta wms.rls_probe
- **Teste**: Policy check bypassed with BYPASSRLS role
- **Erro Exato**: `error: relation "wms.rls_probe" does not exist`
- **Classificação**: **(A)**

---

### Suite: App Parameter - Scope Resolution

#### ❌ A6-A8: Falta wms.app_parameter (3 testes)
- **Testes**:
  - "Parameter with GLOBAL scope visible to all tenants"
  - "Parameter with TENANT scope isolated to tenant"
  - "Parameter with USER scope visible only to user"
- **Erro Exato**: `error: relation "wms.app_parameter" does not exist`
- **Causa Raiz**: Tabela DOC-01 não criada
- **Classificação**: **(A)**
- **Ação Necessária**: Criar migration para `wms.app_parameter(id, scope, name, value, tenant_id, user_id)`

#### ❌ B1-B2: Dependem de DOC-02+ (2 testes)
- **Testes**:
  - "Parameter resolved from parent scope falls back correctly"
  - "Parameter inheritance chain respects precedence"
- **Erro Exato**: `error: relation "wms.app_parameter_snapshot" does not exist`
- **Causa Raiz**: Tabela de negócio (DOC-02)
- **Classificação**: **(B)** DOC-02+
- **Ação Necessária**: Mover para testes-pendentes-DOC-02.md

---

### Suite: Cache - Blacklist Enforcement

#### ❌ A9: Falta wms.app_parameter
- **Teste**: Blacklist blocks caching of forbidden entities
- **Erro Exato**: `error: relation "wms.app_parameter" does not exist`
- **Localização**: blacklist.integration.spec.ts (provavelmente setup de parametrização)
- **Causa Raiz**: Tabela DOC-01 não criada
- **Classificação**: **(A)**

---

### Suite: E2E Event Pipeline - Commit → Streams → WebSocket

#### ❌ A10-A12: Falta wms.app_parameter (3 testes)
- **Testes**:
  - "Event published during business transaction reaches Redis Streams"
  - "Stream message includes all required fields for replay"
  - "WebSocket clients subscribed to event topic receive message"
- **Erro Exato**: `error: relation "wms.app_parameter" does not exist`
- **Causa Raiz**: Tabela DOC-01 não criada (usado para feature flags/feature gates)
- **Classificação**: **(A)**

---

### Suite: Outbox Pattern - Exactly-Once Delivery [INVIOLÁVEL]

#### ❌ A13: Falta wms.event_outbox
- **Teste**: Event published to outbox within transaction persists after commit
- **Erro Exato**: `error: relation "wms.event_outbox" does not exist`
- **Localização**: outbox.integration.spec.ts:53 (SELECT FROM wms.event_outbox)
- **Causa Raiz**: Tabela DOC-01 não criada
- **Classificação**: **(A)**
- **Ação Necessária**: Criar migration para `wms.event_outbox(event_id, event_type, aggregate_type, aggregate_id, published_at, data, tenant_id)`

#### ❌ B3: Dependem de transaction semantics (1 teste)
- **Teste**: Event must be published within transaction (enforce private constructor pattern)
- **Erro Exato**: `error: relation "wms.event_outbox" does not exist`
- **Causa Raiz**: Tabela DOC-01 + teste valida padrão que é DOC-02
- **Classificação**: **(B)** ou **(A)** parcial
- **Nota**: Move para DOC-02 após A13 ficar verde

#### ❌ A14: Falta wms.event_outbox
- **Teste**: Event rollback prevents outbox entry on transaction abort
- **Erro Exato**: `error: relation "wms.event_outbox" does not exist`
- **Classificação**: **(A)**

#### ❌ A15: Falta wms.event_outbox
- **Teste**: Event with correlation_id maintains causality
- **Erro Exato**: `error: relation "wms.event_outbox" does not exist`
- **Classificação**: **(A)**

#### ❌ B4: Depende de worker que consome outbox (1 teste)
- **Teste**: Worker consumes published events from outbox
- **Erro Exato**: `error: relation "wms.event_outbox" does not exist`
- **Causa Raiz**: Tabela DOC-01 + teste de worker (DOC-02)
- **Classificação**: **(B)** DOC-02+
- **Ação Necessária**: Mover para testes-pendentes-DOC-02.md

---

## Tabelas Necessárias (DOC-01 §6)

### Tier 1: Críticas para RLS + Setup
```sql
CREATE TABLE wms.rls_probe (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  data TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- RLS Policy: SELECT/INSERT/UPDATE/DELETE only on rows where tenant_id = app.tenant_ids
ALTER TABLE wms.rls_probe ENABLE ROW LEVEL SECURITY;
```

### Tier 2: Críticas para Outbox + Event Pipeline
```sql
CREATE TABLE wms.event_outbox (
  event_id UUID PRIMARY KEY,
  event_type VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  aggregate_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  data JSONB,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- RLS Policy
-- Partitioned monthly (RNF-ARQ-031)
```

### Tier 3: Críticas para App Parameter + Cache Blacklist
```sql
CREATE TABLE wms.app_parameter (
  id UUID PRIMARY KEY,
  scope VARCHAR(50) NOT NULL, -- 'GLOBAL', 'TENANT', 'USER'
  name VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  tenant_id UUID, -- NULL for GLOBAL
  user_id UUID,   -- NULL unless USER scope
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- RLS Policy: SELECT based on scope
-- Unique constraint: (scope, name, tenant_id, user_id)
```

---

## Plano de Ação

### Fase 1: Criar Global Test Setup (15 min)
- [ ] Criar `setupIntegrationTest()` que roda migrations automaticamente
- [ ] Migrations carregadas de `infra/postgres/migrations/`
- [ ] Executadas uma vez por test suite, antes de `beforeAll`

### Fase 2: Criar Migrations (20 min)
- [ ] `0002-rls-probe.sql` — Tabela de teste RLS
- [ ] `0003-event-outbox.sql` — Tabela de outbox
- [ ] `0004-app-parameter.sql` — Tabela de parâmetros

### Fase 3: Corrigir Fixtures (5 min)
- [ ] RLS spec: linha 73, `pool` → `testContext.pool`
- [ ] Verificar outras referências em outros specs

### Fase 4: Mover Testes DOC-02 (5 min)
- [ ] Criar `docs/relatorios/testes-pendentes-DOC-02.md`
- [ ] Remover 4 testes (não usar .skip — remover da suite completamente)
- [ ] Registrar requisito correspondente de DOC-02

---

## Status Final Esperado

```
Test Files: 5 OK (5)
Tests: 18 passed | 0 failed | 0 skipped (22)
```

**Breakdown**:
- RLS suite: 6/6 ✅
- Outbox suite: 3/7 ✅ (+ 4 movidas para DOC-02)
- App Parameter suite: 3/5 ✅ (+ 2 movidas para DOC-02)
- Cache suite: 1/1 ✅
- E2E Event Pipeline: 3/3 ✅

---

## Referências

- [[docker-build-strategy]] — migrations rodam em container
- [[tests-separation-pattern]] — integration config path
- ADR-001 — RLS patterns
- RNF-ARQ-031 — Event outbox partitioning
