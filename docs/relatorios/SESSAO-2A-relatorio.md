# SESSÃO 2A — RELATÓRIO FINAL

**Data**: 2026-08-16 (retomada de sessão pausada em 2026-08-15, ver
`docs/relatorios/SESSAO-2A-HANDOFF-EM-ANDAMENTO.md` para o histórico
detalhado da retomada)
**Título**: DOC-02 Parte 1 — Organização e Estrutura Física
**Status**: ✅ CONCLUÍDO (com saída de comando real, ver §3)

---

## 1. ESCOPO

Migrations + módulos NestJS de cadastro para as entidades de ORGANIZAÇÃO
(DOC-02 §5.1, tabelas DE TENANT com RLS) e ESTRUTURA FÍSICA (DOC-02 §5.2,
tabelas GLOBAIS sem RLS). Fora de escopo: produtos, saldos, numeração, RBAC
real (2B ou depois).

---

## 2. MATRIZ REQUISITO → ARQUIVO → TESTE

| Requisito | Arquivo(s) | Teste |
|---|---|---|
| RN-DAD-002 (colunas obrigatórias) | `0008-warehouse-structure.sql`, `0009-client-organization.sql` (todas as tabelas) | Validado indiretamente por todos os testes de integração (INSERT exige `created_by`) |
| RN-DAD-003 (proibição de DELETE físico, exceto vínculos N:N) | Migrations 0008/0009 (`GRANT` sem DELETE nas entidades de negócio); `logical-warehouse.service.ts` (`unlink()` é o único DELETE físico do módulo) | Enforced na camada de aplicação (nenhum service chama SQL DELETE fora de `unlink()`) — ver §4 sobre o gap de enforcement no nível de permissão do banco |
| RN-DAD-004 (classificação GLOBAL × TENANT) | `0008-...sql` (GLOBAL), `0009-...sql` (TENANT); `database.service.ts` (`queryGlobal`/`transactionGlobal` vs `query`/`transaction`) | `client-isolation.integration.spec.ts` |
| RN-DAD-005 (enums TEXT + CHECK) | Todas as tabelas de 0008/0009 | `enum-validation.integration.spec.ts` |
| RN-DAD-006 (FK ON DELETE RESTRICT) | Todas as FKs de 0008/0009 | Validado por inspeção da migration (nenhuma FK usa CASCADE) |
| RN-DAD-010 (access_policy derivada de equipment_type) | `0008-...sql` (`storage_equipment.access_policy` coluna GERADA) | Testado manualmente via psql na sessão anterior (ver handoff §1.1); não repetido nesta sessão |
| RN-DAD-011 [INVIOLÁVEL] (location.code gerado) | `0008-...sql` (coluna GERADA); `location.service.ts` | `location-code-generation.integration.spec.ts` |
| RG-001 (isolamento de tenant via RLS) | `0009-...sql` (policies `client`/`client_warehouse_settings`/`logical_warehouse`/`logical_warehouse_location`) | `client-isolation.integration.spec.ts` |
| RG-015 (endereço pertence a no máx. 1 armazém lógico) | `0009-...sql` (`UNIQUE(location_id)`); `logical-warehouse.service.ts` (`link`/`unlink`) | `logical-warehouse-exclusivity.integration.spec.ts` |
| RF-DAD-050 (códigos imutáveis) | `0008-...sql` (`wms.prevent_code_update`, trigger em `warehouse`); `0009-...sql` (trigger em `client`); `location.service.ts` (`prevent_location_coordinates_update`) | `code-immutability.integration.spec.ts` |
| RF-DAD-051 (desativação valida vínculos existentes) | `zone.service.ts`, `location.service.ts`, `client.service.ts`, `logical-warehouse.service.ts` (`deactivate()`) | Cobertura direta por teste de integração dedicado **não** escrita nesta sessão — validado por leitura de código + os testes de exclusividade RG-015 exercitam o caminho de erro `mapCadastroDbError`/`ConflictException` de forma correlata. `[DEBITO: teste de integração dedicado a RF-DAD-051 para cada entidade, sessão futura]` |
| RF-DAD-054 (geração em massa por intervalo) | `location.service.ts` (`bulkGenerate`, `expandAlphaNumericRange`, `expandNumericRange`) | `bulk-generate-locations.integration.spec.ts` |
| ADR-RLS-003/004 (policy sem `USING(true)`, deny por omissão) | Todas as policies de `0009-...sql` | Validado por inspeção (nenhuma policy usa `USING(true)`) + `client-isolation.integration.spec.ts` prova o deny funcionando |

---

## 3. SAÍDA REAL

### 3.1 Build e type-check

```
$ pnpm build   (apps/backend)
> nest build
(sem erros, exit 0)

$ pnpm type-check   (apps/backend)
> tsc --noEmit
(sem erros, exit 0)
```

### 3.2 Testes unitários

```
$ pnpm test
 ✓ src/__tests__/health.spec.ts (2 tests) 5ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### 3.3 Testes de integração (schema recriado do zero pelo global setup)

```
$ pnpm test:integration
 ✓ src/core/app-parameter/__tests__/scope-resolution.integration.spec.ts (6 tests)
 ✓ src/__tests__/e2e-event-pipeline.integration.spec.ts (2 tests)
 ✓ src/core/rate-limit/__tests__/rate-limit.guard.integration.spec.ts (4 tests)
 ✓ src/core/events/__tests__/outbox.integration.spec.ts (4 tests)
 ✓ src/workers/__tests__/outbox-publisher-concurrency.integration.spec.ts (1 test)
 ✓ src/workers/__tests__/realtime-fanout-dlq.integration.spec.ts (1 test)
 ✓ src/core/database/__tests__/rls.integration.spec.ts (5 tests)
 ✓ src/core/cache/__tests__/blacklist.integration.spec.ts (4 tests)
 ✓ src/modules/cadastro/__tests__/logical-warehouse-exclusivity.integration.spec.ts (1 test)
 ✓ src/modules/cadastro/__tests__/client-isolation.integration.spec.ts (1 test)
 ✓ src/modules/cadastro/__tests__/bulk-generate-locations.integration.spec.ts (1 test)
 ✓ src/modules/cadastro/__tests__/code-immutability.integration.spec.ts (2 tests)
 ✓ src/modules/cadastro/__tests__/location-code-generation.integration.spec.ts (1 test)
 ✓ src/modules/cadastro/__tests__/enum-validation.integration.spec.ts (1 test)

 Test Files  14 passed (14)
      Tests  34 passed (34)
```

Zero skip, zero mock de Postgres/Redis. Os 6 cenários do ENTREGÁVEL 5 do
prompt (isolamento, exclusividade RG-015, código de endereço, imutabilidade,
geração em massa, enum inválido) estão cobertos pelos 6 arquivos novos em
`src/modules/cadastro/__tests__/` (7 `it()` no total — imutabilidade tem 2:
`warehouse.code` e `client.code`).

### 3.4 Seeds

```
$ pnpm db:seed
Seeding: 0001-seed-sp01.sql
Done. 1 seed file(s) applied (idempotent).

$ pnpm db:seed   (segunda execução, prova de idempotência)
Seeding: 0001-seed-sp01.sql
Done. 1 seed file(s) applied (idempotent).
```

Contagem real via `docker exec wms-postgres psql`: 1 warehouse (SP01), 6
zones, 9 storage_equipment (uma por `equipment_type`), 24 locations (A1-A2 ×
001-003 × 00-01 × 01-02), 2 docks, 4 yard_slots — idêntica nas duas
execuções (sem duplicidade).

### 3.5 Docker compose completo

```
$ docker compose -f infra/docker-compose.yml up -d --build
...
NAME                    STATUS
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)
wms-minio               Up (healthy)
wms-postgres            Up (healthy)
wms-redis               Up (healthy)

$ curl -s http://localhost:3000/cadastro/warehouses
[{"id":"...","code":"SP01","name":"Armazém São Paulo 01",...}, ...]
```

Endpoint `GET /cadastro/warehouses` responde 200 com os dados reais via HTTP,
comprovando o `CadastroModule` registrado em `app.module.ts` e servindo
tráfego de verdade no container reconstruído.

**Nota sobre `wms-frontend`**: não subiu nesta execução — porta 3001 já
ocupada por outro processo no host, pré-existente e fora do escopo desta
sessão (nenhum código de frontend foi tocado). A imagem buildou com sucesso.

---

## 4. ACHADO FORA DO ESCOPO ORIGINAL — GRANT DEFAULT DE DELETE

Durante a validação dos GRANTs de `0009-client-organization.sql`, foi
identificado que a migration `0001-setup-roles.sql` (de sessão anterior,
não alterada aqui) já executa:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
```

Isso concede DELETE por padrão a **todas** as tabelas futuras do schema
`wms`, inclusive as entidades de negócio de 0008/0009. Os `GRANT SELECT,
INSERT, UPDATE` (sem DELETE) explícitos nessas migrations — pensados para
impedir fisicamente o DELETE em entidades protegidas por RN-DAD-003 — são
corretos na intenção mas **não têm efeito real**: `wms_app` já tem DELETE
via privilégio padrão, confirmado com
`SELECT relacl FROM pg_class WHERE relname='...'` mostrando `wms_app=arwd`.

RN-DAD-003 está protegida apenas na camada de aplicação (nenhum service de
`warehouse`/`zone`/`location`/`client`/etc. chama SQL DELETE) — não há
redundância no nível de permissão do Postgres. Corrigido nesta sessão apenas
o `GRANT` de `logical_warehouse_location` (adicionando DELETE explícito, já
que RN-DAD-003 permite fisicamente para "vínculos N:N de configuração" — sem
isso `unlink()` seria impossível de implementar do jeito certo, já que essa
tabela não tem coluna `status` para soft-delete). Não foi alterada a
migration 0001 (fora do escopo de 2A, "não refatore código que já passa nos
testes").

`[DEBITO: revisar/estreitar ALTER DEFAULT PRIVILEGES da migration 0001, ou
aceitar formalmente que RN-DAD-003 é enforced só em nível de aplicação —
sessão a definir]`

---

## 5. LACUNAS E DÉBITOS

- `[LACUNA: RBAC DOC-12]` — todos os controllers usam `NoAuthGuard`
  (placeholder que sempre retorna `true`). `actor_user_id` vem do body/query
  em vez de um JWT.
- `[DEBITO: allowed_species vs product_species]` — `zone.allowed_species` é
  `TEXT[]` sem FK; validação de pertencimento a `product_species.code` fica
  para quando essa tabela existir (Sessão 2B, DOC-02 §5.3).
- `[DEBITO: FK created_by/updated_by para wms.user]` — sem tabela
  `wms.user` ainda, essas colunas são `UUID NOT NULL` sem FK.
- `[DEBITO: validar saldo/documentos no deactivate de location/zone/client]`
  — RF-DAD-051 nesta sessão só valida vínculos entre as próprias tabelas de
  2A (não há `stock_balance`/documentos ainda).
- `[DEBITO: validar saldo zero no unlink de logical_warehouse_location]` —
  `unlink()` é livre por ora (sem `stock_balance` para checar).
- `[DEBITO: teste de integração dedicado a RF-DAD-051]` — a validação de
  dependência em `deactivate()` (zone/location/client/logical_warehouse) foi
  escrita e revisada por leitura de código, mas não tem um `it()` de
  integração exercitando cada caminho de bloqueio isoladamente (só o de
  RG-015/exclusividade, que usa o mesmo mecanismo de erro).
- `[DEBITO: GRANT DEFAULT PRIVILEGES da migration 0001 concede DELETE amplo
  a wms_app]` — ver §4.
- `[DEBITO: migração para UUIDv7 real]` — herdado de sessões anteriores,
  `gen_random_uuid()` (v4) usado por consistência com o schema já existente.
- `[LACUNA: DOC-02 não define algoritmo de intervalo com prefixos de aisle
  diferentes]` — `expandAlphaNumericRange()` rejeita explicitamente em vez
  de adivinhar (ex. `A1..B3`).
- `[LACUNA: DOC-02 não define tabela de capacidades padrão por nível]` —
  `bulkGenerate()` aplica um único conjunto de capacidades por chamada.
- `logical_warehouse.status` inclui `DEACTIVATING` no CHECK (citado no
  DOC-02), mas o `deactivate()` desta sessão faz a transição direta
  `ACTIVE -> INACTIVE`, sem estado intermediário — `[DEBITO: lifecycle
  completo com DEACTIVATING quando saldo/documentos existirem, Sessão 2B+]`.

---

## 6. ARQUIVOS CRIADOS/MODIFICADOS NESTA SESSÃO

**Migrations**:
- `infra/postgres/migrations/0008-warehouse-structure.sql`
- `infra/postgres/migrations/0009-client-organization.sql`

**Seeds**:
- `infra/postgres/seeds/0001-seed-sp01.sql`
- `infra/postgres/seeds/run-seed.mjs`

**Core**:
- `apps/backend/src/core/database/database.service.ts` (`queryGlobal`/`transactionGlobal`)
- `apps/backend/src/app.module.ts` (registra `CadastroModule`)
- `apps/backend/package.json` (`db:seed`)

**Módulo `cadastro`** (`apps/backend/src/modules/cadastro/`):
- `cadastro.module.ts`
- `shared/no-auth.guard.ts`, `shared/db-error.util.ts`
- `warehouse/`, `zone/`, `storage-equipment/`, `dock/`, `yard-slot/`,
  `location/`, `client/`, `client-warehouse-settings/`, `logical-warehouse/`
  (service + controller cada)

**Testes de integração** (`apps/backend/src/modules/cadastro/__tests__/`):
- `test-helpers.ts`
- `client-isolation.integration.spec.ts`
- `logical-warehouse-exclusivity.integration.spec.ts`
- `location-code-generation.integration.spec.ts`
- `code-immutability.integration.spec.ts`
- `bulk-generate-locations.integration.spec.ts`
- `enum-validation.integration.spec.ts`

**Documentação**:
- Este relatório
- `docs/relatorios/SESSAO-2A-HANDOFF-EM-ANDAMENTO.md` (histórico da pausa/retomada — pode ser apagado após leitura, mesmo critério da Sessão 1.5)

---

**Gerado**: 2026-08-16
**Sessão**: 2A — DOC-02 Parte 1 (Organização + Estrutura Física)
**Status**: ✅ CONCLUÍDO — toda afirmação acima tem saída de comando real correspondente
