# Testes Pendentes — DOC-02+ (Fora de Escopo Sessão 1)

Estes testes foram **removidos das suites** porque dependem de funcionalidades de DOC-02+ (business modules) que não existem ainda. Não usar `.skip()` ou `.only()` — simplesmente não incluem na suite.

**Será adicionado quando**: Requisitos de DOC-02+ forem implementados.

---

## Teste 1: App Parameter - Inheritance Chain

### Requisito de DOC-02
**DOC-02 §N**: Snapshot mechanism para herança de parâmetros entre escopos

### Teste
```typescript
it('Parameter inheritance chain respects precedence', async () => {
  // Setup: Create parameters at multiple scopes
  // GLOBAL: log_level = 'info'
  // TENANT: log_level = 'debug'
  // USER: log_level = 'trace'

  // Test: Resolution should prefer most specific (USER > TENANT > GLOBAL)
  const resolved = await parameterService.resolve('log_level', {
    tenant_id,
    user_id
  });

  expect(resolved).toBe('trace'); // USER scope wins
});
```

### Contexto
RNF-ARQ-020: Parameterized configuration com resolução em cascata. Requer `wms.app_parameter_snapshot` para cache de resolução (DOC-02).

---

## Teste 2: App Parameter - Fallback Correctly

### Requisito de DOC-02
**DOC-02 §N**: Parameter resolution service com fallback logic

### Teste
```typescript
it('Parameter resolved from parent scope falls back correctly', async () => {
  // Setup: Only GLOBAL parameter exists
  // No TENANT or USER overrides

  // Test: USER scope lookup → falls back to TENANT → falls back to GLOBAL
  const resolved = await parameterService.resolve('some_param', {
    tenant_id,
    user_id
  });

  expect(resolved).toBe(globalValue);
});
```

### Contexto
Implementação de fallback logic em service (não é apenas query RLS — requer application code).

---

## Teste 3: Outbox - Must Be Published Within Transaction

### Requisito de DOC-02
**DOC-02 §N**: EventsService private constructor pattern + transaction enforcement

### Teste
```typescript
it('Event must be published within transaction (enforce private constructor pattern)', async () => {
  const event = { /* ... */ };

  // Attempt to publish outside transaction should fail
  let errorThrown = false;
  try {
    await (eventsService.publishInTransaction as any)(null, event);
  } catch (error) {
    errorThrown = true;
    expect(error.message).toContain('transaction');
  }

  expect(errorThrown).toBe(true);
});
```

### Contexto
Pattern enforcement que é DOC-02 concern. Existe em spec mas depende de implementação de validation em EventsService.

---

## Teste 4: Outbox - Worker Consumes Published Events

### Requisito de DOC-02
**DOC-02 §N**: OutboxWorker consumer que lê eventos do PostgreSQL e publica em Redis Streams

### Teste
```typescript
it('Worker consumes published events from outbox', async () => {
  // Setup: Event in outbox
  // Run worker
  // Verify: event marked as published_at
  // Verify: event in Redis Streams
});
```

### Contexto
Requer implementação de `OutboxWorker` (DOC-02 module: @wms/backend-worker). RNF-ARQ-031.

---

## Referências

- [[ANALISE-falhas-testes.md]] — Classificação B1-B4 neste documento
- DOC-02 — Business Modules (Portaria, Recebimento, etc.)
- RNF-ARQ-020 — Parameterized Configuration
- RNF-ARQ-031 — Outbox Pattern Implementation
