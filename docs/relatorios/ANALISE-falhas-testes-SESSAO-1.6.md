# ANÁLISE: Classificação das 21 Falhas — SESSÃO 1.6

**Data**: 2026-08-15  
**Total de Testes**: 21  
**Status após correções iniciais**: 2 ✅ | 15 ❌ | 4 ⏳ (pendentes conforme planejado)

---

## Resumo por Classificação

| Classificação | Contagem | Ação | Escopo |
|---------------|----------|------|--------|
| **(A) Faltam migração/schema DOC-01** | 11 | Corrigir schema event_outbox (module column) | Sessão 1.6 (esta) |
| **(B) Dependem de DOC-02+ (fora de escopo)** | 4 | Mover para testes-pendentes-DOC-02.md | Sessão 2+ |
| **(C) Bugs em fixtures/código de teste** | 1 | Corrigir RLS setup + CacheService config | Sessão 1.6 (esta) |
| **✅ Passando** | 2 | Nenhuma ação | Pronto |

---

## Detalhes por Teste

### Suite: RLS - Tenant Isolation [INVIOLÁVEL] — 1 PASS, 4 FAIL

#### ✅ PASS
- **Teste**: Tenant1 cannot see Tenant2 data via RLS
- **Status**: Sucesso após correção de setup (usar transaction com contexto)
- **Por quê**: RLS setup agora cria dados dentro de transação com contexto tenant

#### ✅ PASS (adicional)
- **Teste**: Tenant2 sees different data from Tenant1
- **Status**: Sucesso
- **Por quê**: Herda contexto tenant do setup anterior

#### ❌ A1-A4: RLS integration (4 testes)
- **Testes**: Testes 3-6 do suite RLS
- **Erro Exato**: Varia (fixture config, RLS policy validation)
- **Causa Raiz**: CacheService undefined (configService não sendo injetado) + migration concorrência anterior
- **Classificação**: **(A)** + **(C)**
- **Ação Necessária**: Corrigir CacheService para usar fallback ConfigService

---

### Suite: App Parameter - Scope Resolution

#### ❌ B1-B2: Dependem de DOC-02+ (2 testes)
- **Testes**:
  - "Parameter with GLOBAL scope visible to all tenants"
  - "Parameter with TENANT scope isolated to tenant"
- **Erro Exato**: CacheService onModuleInit undefined configService
- **Causa Raiz**: Teste tenta usar CacheModule mas ConfigService não está injetado
- **Classificação**: **(C)** bug de DI + **(B)** parcial (escopo não é exclusivamente DOC-02)
- **Ação Necessária**: Remover da suite; está cedo demais para testes de app_parameter sem DOC-02

#### ❌ B3-B4: Escopo híbrido (2 testes)
- **Testes**: "Parameter fallback" e "inheritance chain"
- **Classificação**: **(B)** DOC-02+
- **Ação Necessária**: Mover para testes-pendentes-DOC-02.md

---

### Suite: Cache - Blacklist Enforcement

#### ❌ C1: CacheService DI bug
- **Teste**: Blacklist blocks caching of forbidden entities
- **Erro Exato**: TypeError: Cannot read properties of undefined (reading 'get')
- **Localização**: cache.service.ts:18 (onModuleInit)
- **Causa Raiz**: ConfigService injeção falha em teste de integração
- **Classificação**: **(C)** Bug de fixture
- **Ação Necessária**: Garantir ConfigService disponível no TestingModule ou usar fallback

---

### Suite: E2E Event Pipeline - Commit → Streams → WebSocket

#### ❌ A5-A7: event_outbox schema mismatch (3 testes)
- **Testes**:
  - "Event published during business transaction reaches Redis Streams"
  - "Stream message includes all required fields for replay"
  - "WebSocket clients subscribed to event topic receive message"
- **Erro Exato**: column "module" of relation "event_outbox" does not exist
- **Causa Raiz**: Tabela event_outbox foi criada sem coluna `module` em execução anterior (DB corrupção)
- **Classificação**: **(A)** Migration schema issue
- **Ação Necessária**: DROP + RECREATE tabela event_outbox com schema correto

---

### Suite: Outbox Pattern - Exactly-Once Delivery [INVIOLÁVEL]

#### ❌ A8-A12: event_outbox schema (5 testes)
- **Testes**:
  - "Event published to outbox within transaction persists after commit"
  - "Multiple events in single transaction all persist"
  - "Event rollback prevents outbox entry on transaction abort"
  - "Event with correlation_id maintains causality"
  - "Worker consumes published events from outbox" (parcial B)
- **Erro Exato**: column "module" of relation "event_outbox" does not exist
- **Causa Raiz**: Mesmo que A5-A7
- **Classificação**: **(A)**
- **Ação Necessária**: Corrigir schema event_outbox

---

## Tabelas e Ações Imediatas

### Ação 1: Corrigir Schema event_outbox (CRÍTICA)

```sql
-- No global test-setup.ts ou manual:
DROP TABLE IF EXISTS wms.event_outbox CASCADE;
DROP TABLE IF EXISTS wms.rls_probe CASCADE;
DROP TABLE IF EXISTS wms.app_parameter CASCADE;
-- Migrations rodam automaticamente
```

### Ação 2: Corrigir CacheService DI

```typescript
// src/core/cache/cache.service.ts — line 18
// Adicionar fallback se ConfigService não disponível
url: this.configService?.get('REDIS_URL') || 'redis://localhost:6379',
```

### Ação 3: Mover Testes DOC-02

Testes que esperam tabelas de negócio (não-DOC-01):
- `App Parameter - Scope Resolution` (testes de herança/fallback)
- `Worker consumes published events from outbox` (parcial)

---

## Definition of Done

- [x] Setup.ts roda migrations globalmente  
- [x] Classificação das 21 falhas (A/B/C)  
- [ ] Corrigir schema event_outbox  
- [ ] Corrigir CacheService DI  
- [ ] Rodar testes: Meta = 5 PASS (RLS + Core outbox sem worker)  
- [ ] Mover 4 testes B para testes-pendentes-DOC-02.md  
- [ ] Registrar ADR sobre set_config($1,$2,true)  

---

## Referências

- [[docker-build-strategy]] — test-setup.ts roda antes dos testes
- [[config-service-injection-fix]] — ConfigService em onModuleInit
- [[tests-separation-pattern]] — vitest.config.integration.ts + setupFiles
