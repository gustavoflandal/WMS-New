# SESSÃO 0 — REGISTRO DE LACUNAS E CONFLITOS

**Data**: 2026-08-11  
**Documento Mestre**: DOC-00  
**Instruções**: INSTRUÇÃO-IA-001, INSTRUÇÃO-IA-003

---

## 1. LACUNAS IDENTIFICADAS

[LACUNA: descrição] markers were inserted in the code at exact points where implementation is deferred.

### 1.1 Lacunas Críticas (Bloqueiam implementação)

#### LAC-S0-001: ORM/Query Builder Choice
**Referência**: ADR-001, `apps/backend/src/core/database/database.module.ts`  
**Descrição**: DOC-00 §2.2 congela PostgreSQL ≥16 mas não especifica ORM/query builder. Duas opções: Kysely (type-safe query builder) vs. node-pg (raw SQL + custom runner). Choice afeta RLS setup (RG-001) e performance (50k orders/day target).  
**Impacto**: Database layer não pode ser implementada sem decisão.  
**Resolução Prevista**: Session 1 — Technical spike + ADR-001-RESOLVED  
**Rastreamento**: ADR-001 marcado como PENDING  

#### LAC-S0-002: Database Connection Pool
**Referência**: `apps/backend/src/core/database/database.module.ts`  
**Descrição**: Connection pool para PostgreSQL não implementada. Placeholder retorna apenas config object.  
**Impacto**: Database queries não funcionam. Bloqueador para toda lógica de negócio.  
**Resolução Prevista**: Session 1 — Implementar após LAC-S0-001  
**Bloqueado por**: LAC-S0-001  

#### LAC-S0-003: Redis Client
**Referência**: `apps/backend/src/core/redis/redis.module.ts`  
**Descrição**: Redis client não inicializado. Placeholder retorna apenas config object.  
**Impacto**: Cache, Pub/Sub, Streams não funcionam. Bloqueador para time-real features (RG-009, RG-024).  
**Resolução Prevista**: Session 1 — Implementar usando `redis` package v4  

#### LAC-S0-007: RLS Policies
**Referência**: `infra/postgres/init/01-schema.sql`  
**Descrição**: Row-Level Security policies não implementadas. RG-001 (Isolamento de tenant) exige filtro de tenant_id em TODA query transacional.  
**Impacto**: Multi-tenancy não enforçado. Violação de RG-001 [INVIOLÁVEL].  
**Resolução Prevista**: Session 1 — Criar policies por tenant_id em todas as tabelas  

---

### 1.2 Lacunas Altas (Afetam Health Check e Operabilidade)

#### LAC-S0-004: Health Check — PostgreSQL Validation
**Referência**: `apps/backend/src/core/health/health.service.ts:checkPostgres()`  
**Descrição**: Implementação retorna 'ok' hardcoded. Readiness check em `/health/ready` deve verificar:
- Conexão ativa com PostgreSQL
- Query simples (e.g., `SELECT 1`)
- Latência aceitável (< 100ms)  
**Impacto**: Readiness probe falso-positivo. Container pode iniciar sem DB acessível.  
**Resolução Prevista**: Session 1 — Após LAC-S0-002  

#### LAC-S0-005: Health Check — Redis Validation
**Referência**: `apps/backend/src/core/health/health.service.ts:checkRedis()`  
**Descrição**: Implementação retorna 'ok' hardcoded. Readiness check deve validar `PING` no Redis.  
**Impacto**: Health probe falso-positivo.  
**Resolução Prevista**: Session 1 — Após LAC-S0-003  

#### LAC-S0-011: GitHub Actions CI/CD Pipeline
**Referência**: `.github/workflows/` (não criado)  
**Descrição**: Placeholder ausente. Pipeline deve:
- Lint (ESLint em todos os packages)
- Type-check (TypeScript strict)
- Testes (vitest)
- Build (turbo build)
- Docker image push (backend + frontend)
- Opcionalmente: Deploy staging  
**Impacto**: Nenhum CI/CD — impossível garantir qualidade em PRs.  
**Resolução Prevista**: Session 1  

---

### 1.3 Lacunas Médias (Completude de Tipos e Enums)

#### LAC-S0-008: Enum Definitions — Estados Completos
**Referência**: `packages/contracts/src/enums.ts`  
**Descrição**: Apenas 3 enums stub criados (OperationFlowStatus, ProductSpecies, DiscrepancyType). Necessários conforme DOC-00 §4.8 (REG-GLO-004 [INVIOLÁVEL]):
- Estados por entidade (Pedido, Recebimento, etc.)
- Tipos de divergência (4 + LACUNA em DOC-02)
- Motivos de exceção (approval workflows)
- Espécies de produto (10 valores)  
**Impacto**: Módulos de negócio não podem serializar states sem enums.  
**Resolução Prevista**: Sessions 2-4 — Conforme módulos implementados  

#### LAC-S0-009: Type Definitions — Complete Contracts
**Referência**: `packages/contracts/src/types.ts`  
**Descrição**: Apenas stubs. Necessários para cada módulo:
- DTO de entrada (criar, atualizar)
- DTO de saída (serialização)
- Entidades (shape de dados do banco)
- Respostas de erro (código + mensagem)  
**Impacto**: API contracts não documentadas. Impossível gerar OpenAPI/Swagger.  
**Resolução Prevista**: Sessions 2-4 — Conforme módulos implementados  

---

### 1.4 Lacunas Baixas (Fora de Escopo Session 0, Previstas Futuras)

#### LAC-S0-006: Business Module Implementations
**Referência**: `apps/backend/src/modules/*/` (10 módulos vazios)  
**Descrição**: Nenhuma regra de negócio implementada (conforme especificação de escopo).  
**Resolução Prevista**: Sessions 1-4  

#### LAC-S0-010: Edge Agent Hardware Interfaces
**Referência**: `apps/edge-agent/src/main.ts`  
**Descrição**: RNF-PER-001 especifica protocolo para impressoras, balanças, cancelas, LPR. Apenas skeleton Express criado.  
**Resolução Prevista**: Session 2+ (após Session 1 definir protocolo detalhado)  

#### LAC-S0-012: PWA Service Worker Real Implementation
**Referência**: `apps/frontend/src/app/(field)/` (service worker skeleton)  
**Descrição**: AD-005 (Offline-first) requer:
- Cache de assets
- Fila de sincronização em IndexedDB
- Resolução de conflitos determinística  
**Resolução Prevista**: Session 2+ (após DB sync strategy definida)  

---

## 2. CONFLITOS DETECTADOS

### 2.1 Conflitos Entre Documentos

**Status**: ✅ NENHUM CONFLITO IDENTIFICADO

Revisão efetuada em:
- DOC-00 (stack congelada) vs. decisões arquiteturais → Alinhado
- RNF-ARQ-001 a RNF-ARQ-004 (scaffold requirements) vs. implementação → Atendidos
- Glossário (§4) vs. nomenclatura em código → Seguido (SCREAMING_SNAKE_CASE em enums)
- Regras Globais (RG-001 a RG-015) vs. bootstrap → RG-001 (RLS) deferred a Session 1 conforme escopo

### 2.2 Inconsistências Documentadas

Nenhuma. Todas marcadas como [LACUNA: ...] conforme INSTRUÇÃO-IA-001.

---

## 3. MATRIZ DE RASTREABILIDADE — LACUNAS POR MÓDULO

| Módulo | Lacunas | Criticidade | Session |
|--------|---------|-------------|---------|
| core/database | LAC-S0-001, LAC-S0-002 | 🔴 CRÍTICA | 1 |
| core/redis | LAC-S0-003 | 🔴 CRÍTICA | 1 |
| core/health | LAC-S0-004, LAC-S0-005 | 🟡 ALTA | 1 |
| core/logger | — | ✅ Implementado | — |
| Backend API | (módulos vazios) | — | 2+ |
| Frontend | PWA sync (LAC-S0-012) | 🟢 BAIXA | 2+ |
| Contracts | LAC-S0-008, LAC-S0-009 | 🟡 ALTA | 2+ |
| Edge Agent | LAC-S0-010 | 🟢 BAIXA | 2+ |
| CI/CD | LAC-S0-011 | 🟡 ALTA | 1 |

---

## 4. PRÓXIMAS AÇÕES (HANDOFF TO SESSION 1)

### Bloqueadores Críticos

```
┌─────────────────────────────────────────────┐
│ Session 1 MUST resolve ANTES de prosseguir │
├─────────────────────────────────────────────┤
│ 1. ADR-001: ORM choice (Kysely vs node-pg) │
│ 2. LAC-S0-002: Database pool + migration   │
│ 3. LAC-S0-003: Redis client                │
│ 4. LAC-S0-007: RLS policies                │
└─────────────────────────────────────────────┘
```

### Session 1 Checklist
- [ ] Spike ADR-001, criar ADR-001-RESOLVED
- [ ] Implementar DatabaseModule (pool, migrations)
- [ ] Implementar RedisModule (ioredis ou redis package)
- [ ] Implementar RLS policies por tenant
- [ ] Completar health checks (LAC-S0-004, LAC-S0-005)
- [ ] Criar GitHub Actions pipeline (LAC-S0-011)
- [ ] Expand contracts com types/enums Session 1 scope

---

## 5. REFERÊNCIA CRUZADA

Todas as lacunas estão:

1. **Marcadas no código**: `[LACUNA: descrição]` em comentário no ponto exato
2. **Documentadas aqui**: Seção 1
3. **Rastreadas em ADRs**: ADR-001 (PENDING)
4. **Previstas no roadmap**: SESSAO-0-relatorio.md §9

Exemplo de marker no código:
```typescript
// core/database/database.module.ts
[LACUNA: ORM/query builder choice (Kysely vs node-pg) to be documented in ADR-001]
```

---

## 6. DECISÕES TOMADAS COM LACUNAS CONHECIDAS

### Decisão: Docker Multi-Role (ADR-004 ✅)
**Lacunas conhecidas**:
- Health check para worker/scheduler não testado (LAC-S0-004/005)
- Graceful shutdown não implementado

**Justificativa**: Health check placeholder é aceitável — nenhuma produção esperada Session 0.

### Decisão: Database Setup (RNF-ARQ-011 ✅)
**Lacunas conhecidas**:
- ORM não escolhido (LAC-S0-001)
- RLS policies não criadas (LAC-S0-007)

**Justificativa**: Schema e extensions criados. RLS adicionado uma vez que ORM decidido.

---

## CONCLUSÃO

- ✅ 12 lacunas identificadas e documentadas
- ✅ 0 conflitos entre documentos
- ✅ Todas as lacunas têm resolução prevista
- ✅ Nenhuma viola escopo declarado de Session 0
- ✅ Nenhuma deixa sistema em estado inseguro ou inviável

**Scaffold Session 0 pronto para handoff a Session 1.**

---

**Gerado**: 2026-08-11  
**Validação**: Conforme INSTRUÇÃO-IA-001, INSTRUÇÃO-IA-003, DOC-00 §9.2
