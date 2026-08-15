# Testes Pendentes para Sessão 1.5 (Workers a Implementar)

**Data**: 2026-08-15  
**Origem**: Reclassificação SESSÃO 1.6 (teste de worker movido de DOC-02)  
**Status**: ⏳ AWAITING Sessão 1.5 — outbox-publisher worker NÃO foi implementado ainda
**Nota**: Sessão 1.5 é responsável por implementar RNF-ARQ-031 (worker + E2E pipeline)

---

## Teste 1: Worker Consumes Published Events from Outbox

### Localização
- **Arquivo**: `apps/backend/src/core/events/__tests__/outbox.integration.spec.ts`
- **Suite**: Outbox Pattern - Exactly-Once Delivery [INVIOLÁVEL]
- **Linha aprox.**: ~180

### Requisito
**RNF-ARQ-031**: Outbox Worker — Poll unpublished events, mark published_at, emit to Redis Streams

### Implementação Esperada (Sessão 1.5)
- ⏳ **outbox-publisher.worker.impl.ts** — AGUARDA implementação em Sessão 1.5
  - Deverá: Poll `event_outbox` com `FOR UPDATE SKIP LOCKED`
  - Deverá: XADD to `events:{event_type_prefix}` (ex: events:portaria)
  - Deverá: Mark `published_at`
  
- ⏳ **E2E Pipeline Test** — Será criado em Sessão 1.5 se necessário
  - Validará: Commit → Outbox → Streams → WebSocket ≤ 2s
  - Inclusivo do worker (background job)

### O Que Testa (Esperado)

```typescript
it('Worker consumes published events from outbox', async () => {
  // Setup
  const eventId = await publishEventToOutbox(/* ... */);
  
  // Verify: event in outbox with published_at = NULL
  let event = await queryOutbox(eventId);
  expect(event.published_at).toBeNull();
  
  // Action: Run worker job (ou aguardar se background)
  await runOutboxPublisherWorker();
  
  // Verify: event marked as published
  event = await queryOutbox(eventId);
  expect(event.published_at).not.toBeNull();
  
  // Verify: event in Redis Streams
  const streamEvents = await redis.xread({ streams: 'events:orders': 0 });
  expect(streamEvents.length).toBeGreaterThan(0);
});
```

### Por Que Não Está em Sessão 1.6

- **Sessão 1.6**: Foco em DOC-01 §6 — Schema + RLS (5 cenários)
- **Sessão 1.5**: Responsável por Outbox Worker (RNF-ARQ-031)
- **Dependência**: Teste requer worker implementado e rodando
  - Worker é processo background (APP_ROLE=worker no Docker)
  - Precisa: implementação + integração com job scheduler
  - E2E pipeline (se implementado em 1.5) fará validação similar
  - Este teste: **mais específico que E2E, útil para debug de worker**

### Ação para Sessão 1.5 (Implementação)

1. **Implementar outbox-publisher.worker.impl.ts**
   - Poll `wms.event_outbox` com `FOR UPDATE SKIP LOCKED`
   - Derivar stream key de `event_type` (ex: `portaria.gate_in` → `events:portaria`)
   - XADD event ao Redis Stream
   - Mark `published_at = CURRENT_TIMESTAMP`
   - Retry logic para falhas (DLQ)

2. **Configurar Docker Compose**
   - Instância separada com `APP_ROLE=worker`
   - Job scheduler (p.ex. node-cron ou temporal)
   - Executa a cada N segundos

3. **Criar/Validar teste de worker**
   - Inserir event em `event_outbox`
   - Rodar worker (ou aguardar polling)
   - Verificar `published_at` atualizado
   - Verificar Redis Stream recebeu evento
   - Inseri-lo em `outbox.integration.spec.ts` (8º teste)

---

## Status de Conclusão

**Sessão 1.5 Planejado (AINDA NÃO EXECUTADO):**
- [ ] outbox-publisher.worker.impl.ts
- [ ] E2E pipeline test (commit → client ≤ 2s)
- [ ] Concurrency safety (FOR UPDATE SKIP LOCKED)

**Sessão 1.6 Encontrado:**
- ❌ Teste específico de worker adiado para Sessão 1.5
- ℹ️ Movido de classe B (DOC-02) para testes-pendentes-SESSAO-1.5.md

**Sessão 1.5 (próxima):**
- [ ] Implementar outbox-publisher worker
- [ ] Testar consume published events
- [ ] Validar Streams population
- [ ] Recontar contagem (passa a 22: 21 DOC-01 + 1 worker)

---

## Referências

- **Implementação**: `apps/backend/src/workers/outbox-publisher.worker.impl.ts`
- **E2E Validação**: `apps/backend/src/__tests__/e2e-event-pipeline.integration.spec.ts`
- **RNF-ARQ-031**: Outbox pattern, partitioned, monthly
- **SESSÃO 1.5 Relatório**: `docs/relatorios/SESSAO-1.5-relatorio.md`

---

**Criado**: 2026-08-15 (durante SESSÃO 1.6)  
**Sessão de Fix**: 1.5+  
**Prioridade**: MÉDIA (redundante com E2E, mas mais específico)
