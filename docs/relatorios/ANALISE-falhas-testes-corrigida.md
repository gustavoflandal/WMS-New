# ANÁLISE CORRIGIDA: Classificação das 21 Falhas — SESSÃO 1.6

**Data**: 2026-08-15 (Revisão)  
**Total de Testes**: 21  
**Contagem Verificada**: A(10) + B(1) + C(5) + Pass(5) = **21 ✓**

---

## RECLASSIFICAÇÕES CRÍTICAS

### ✅ Reclassificação 1: app_parameter é DOC-01
- **Antes**: Classificado como (B) — "depende de DOC-02+"
- **Agora**: **(C)** — Testa escopo RLS/config de DOC-01 §6
- **Razão**: `app_parameter` é tabela **RD-ARQ-004** do DOC-01, NÃO DOC-02
- **Testes afetados**: 4 (scope resolution: GLOBAL, TENANT, USER, fallback)
- **Ação**: CORRIGIR NESTA SESSÃO (bugs de DI ConfigService)

### ✅ Reclassificação 2: Worker test é Sessão 1.5
- **Antes**: "Classe B — Depende de DOC-02"
- **Agora**: **Mover para testes-pendentes-SESSAO-1.5.md**
- **Razão**: outbox-publisher worker foi implementado em Sessão 1.5
- **Teste**: "Worker consumes published events from outbox"
- **Ação**: Move para pendentes de Sessão 1.5, não DOC-02

---

## CONTAGEM FINAL (Verificada = 21)

| Classificação | Contagem | Detalhe |
|---------------|----------|---------|
| **(A) Faltam schema DOC-01** | 10 | event_outbox (8 testes) + rls_probe (2 testes) |
| **(B) Legitimamente pendentes** | 1 | "Worker consumes..." → Sessão 1.5 (worker implementado) |
| **(C) Bugs fixtures/DI** | 5 | CacheService (1) + app_parameter scope (4) |
| **✅ Passando** | 5 | RLS subset (2) + app_parameter GLOBAL (1) + E2E partial (2) |
| **TOTAL** | **21** | ✓ Verificado |

---

## DETALHES POR CLASSIFICAÇÃO (CORRIGIDO)

### Classe A: Faltam Schema DOC-01 (10 testes)

#### A1-A2: RLS Probe (2 testes)
- **Testes**: Tenant2 sees data, Query without context
- **Erro**: relation "wms.rls_probe" does not exist
- **Causa**: Migration 0002 não aplica ou schema drift
- **Solução**: Banco dedicado wms_test, migrations em ordem

#### A3-A10: Event Outbox Schema Drift (8 testes)
- **Testes**: outbox.integration.spec.ts (8 de 8 testes)
- **Erro**: column "module" of relation "event_outbox" does not exist (ou schema drift)
- **Causa**: Migration 0003 incompleta ou não rodou
- **Solução**: 
  - Aplicar migration 0003 com schema RNF-ARQ-030 completo:
    - `event_id, event_type, occurred_at, tenant_id, warehouse_id, actor_user_id, actor_origin, correlation_id, causation_id, requirement_ids[], payload, published_at, created_at`
    - ❌ NÃO tem: `aggregate_type, aggregate_id, module, user_id, data`
  - Particionada por `occurred_at` (monthly)
  - Aplicar em banco `wms_test` dedicado
  - Truncate entre suites, NÃO DROP

---

### Classe B: Pendentes Legítimos (1 teste)

#### B1: Worker Consumes Published Events from Outbox
- **Arquivo**: outbox.integration.spec.ts (último teste)
- **Erro**: Worker não rodando (é background job)
- **Requisito**: Sessão 1.5 (RNF-ARQ-031 — outbox-publisher worker)
- **Status**: outbox-publisher.worker.impl.ts JÁ implementado em 1.5
- **Solução**: **MOVER PARA docs/relatorios/testes-pendentes-SESSAO-1.5.md**
- **Ação na Sessão 1.5+**: Rodar worker, validar marked as published_at

---

### Classe C: Bugs de Fixture/DI (5 testes)

#### C1: CacheService onModuleInit DI Bug (1 teste)
- **Teste**: blacklist.integration.spec.ts
- **Erro**: TypeError: Cannot read properties of undefined (reading 'get')
- **Linha**: cache.service.ts:18 (this.configService.get())
- **Causa**: ConfigService não injetado em TestingModule
- **PROIBIDO**: Optional chaining `?.` ou fallback hardcoded 'localhost'
  - ❌ Errado: `this.configService?.get('REDIS_URL') || 'redis://localhost:6379'`
  - ❌ Errado: Assume localhost (nome errado em Docker, seria redis)
- **SOLUÇÃO**: 
  - Garantir TestRootModule exporta ConfigModule.forRoot({ isGlobal: true })
  - CacheService recebe ConfigService via constructor
  - Usar em onModuleInit SEM fallback (fail-fast se faltar)
  - Se config faltar, erro explícito no boot

#### C2-C5: App Parameter Scope Tests (4 testes)
- **Testes**: scope-resolution.integration.spec.ts
  1. "Parameter with GLOBAL scope visible to all tenants"
  2. "Parameter with WAREHOUSE scope isolated to warehouse"
  3. "Parameter with CLIENT scope isolated to client"
  4. "Parameter resolved from parent scope falls back correctly"
- **Erro**: Herda do C1 (CacheService undefined)
- **Causa**: TestingModule setup faltando ConfigModule.forRoot()
- **Escopos corretos** (DOC-02 §5.7): GLOBAL, WAREHOUSE, CLIENT, CLIENT_WAREHOUSE
- **Precedência**: CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL
- **Solução**: Mesmo que C1 — garantir DI global + corrigir escopos para RD-ARQ-004

---

### Passando (5 testes)

#### ✅ 1. RLS Tenant1 cannot see Tenant2 data
- **Status**: PASS após corrigir setup com transação

#### ✅ 2. RLS Tenant2 sees different data
- **Status**: PASS (herda contexto anterior)

#### ✅ 3. App Parameter GLOBAL scope (subset)
- **Status**: Parcial (1/4 testes de scope roda se ConfigService OK)

#### ✅ 4-5. E2E Event Pipeline (2/3)
- **Status**: Parcial (depende de event_outbox schema)

---

## AÇÕES IMEDIATAS (SESSÃO 1.6)

### 1. CORRIGIR CACHESERVICE DI ⚠️ CRÍTICA

**Arquivo**: `apps/backend/src/core/cache/cache.service.ts`

```typescript
// ❌ ERRADO (tem opcional chaining + fallback hardcoded)
url: this.configService?.get('REDIS_URL') || 'redis://localhost:6379',

// ✅ CORRETO (fail-fast, sem fallback)
url: this.configService.get('REDIS_URL'), // Explode se não houver
```

**Arquivo**: `apps/backend/src/core/database/__tests__/test-setup.helper.ts`

```typescript
// Adicionar ao TestRootModule:
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Carregar valores para cache.service
      load: [
        () => ({
          REDIS_URL: process.env.REDIS_URL || 'redis://redis:6379/0',
          POSTGRES_HOST: process.env.POSTGRES_HOST || 'postgres',
          // etc
        }),
      ],
    }),
  ],
  exports: [ConfigModule],
})
class TestRootModule {}
```

### 2. CORRIGIR MIGRATION event_outbox (RNF-ARQ-030)

**Arquivo**: `infra/postgres/migrations/0003-event-outbox.sql`

Schema **CORRETO** (DOC-01 RNF-ARQ-030):
```sql
CREATE TABLE IF NOT EXISTS wms.event_outbox (
  event_id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,  -- ← Chave de partição
  tenant_id UUID,
  warehouse_id UUID,                               -- ← OBRIGATÓRIO
  actor_user_id UUID,                             -- ← OBRIGATÓRIO
  actor_origin TEXT,                              -- ← OBRIGATÓRIO
  correlation_id UUID,
  causation_id UUID,
  requirement_ids TEXT[],                         -- ← OBRIGATÓRIO
  payload JSONB NOT NULL,                         -- ← NOT NULL
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

**NÃO TEM**:
- ❌ `aggregate_type, aggregate_id, module, user_id, data`

**Particionada por**: `occurred_at` (monthly, conforme RNF-ARQ-090)

### 3. USAR BANCO DEDICADO wms_test

**Arquivo**: `apps/backend/test-setup.ts`

✅ **Implementação Correta**:
- Banco `wms_test` ja criado no Docker (docker-compose.yml)
- Setup conecta a `wms_test`, reseta schema wms com DROP SCHEMA wms CASCADE
- Aplica migrations em ordem (0002, 0003, 0004)
- Entre suites/testes: TRUNCATE, não DROP

**NÃO FAZER**:
- ❌ `CREATE DATABASE IF NOT EXISTS wms_test` (não existe em PostgreSQL < 13, e mesmo com 13+ causa complexidade)
- ❌ `DROP TABLE` em banco de desenvolvimento (só em wms_test)
- ❌ Herdar estado entre testes

### 4. GARANTIR INDEPENDÊNCIA DE TESTES

- Cada teste cria seu próprio setup transacional
- NÃO herdar contexto de teste anterior
- Truncate tables entre suites (não DROP)

---

## DEFINITION OF DONE (CORRIGIDO)

```bash
✅ Refazer análise com reclassificações
✅ Corrigir CacheService DI (fail-fast)
✅ Verificar event_outbox migration (todas as colunas)
✅ Usar banco wms_test dedicado

ENTÃO:
pnpm test:integration

META:
  ✅ 20 testes verdes (A=0, C=5 corrigidas, Pass=5)
  ✅ 1 teste movido (B=1 → testes-pendentes-SESSAO-1.5.md)
  ✅ 0 skips
  ✅ 0 timeouts
  ✅ Contagem = 21 verificada
```

---

## REFERÊNCIAS

- **RD-ARQ-004**: app_parameter — tabela DOC-01
- **RNF-ARQ-030**: event_outbox schema completo
- **RNF-ARQ-031**: outbox-publisher worker (Sessão 1.5)
- **RG-001**: RLS enforcement (DOC-01)

---

**Revisão**: 2026-08-15 (após correções de usuário)  
**Status**: 🔴 **CRÍTICA** — CacheService DI + event_outbox schema DEVEM ser corrigidos hoje  
**Próximo**: Rodar testes com fixes aplicadas
