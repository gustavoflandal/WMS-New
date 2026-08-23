# Sessão COL-1 — Plataforma PWA de Coletor (DOC-15, online)

Prompt executado: `docs/PROMPT-SESSAO-COL1-pwa-coletor.md` (versão corrigida
nesta sessão — ver §0 abaixo).

## 0. Correção de escopo antes da implementação

O prompt originalmente recebido (`PROMPT-SESSAO-COL1-plataforma-coletor.md`)
propunha React Native/Expo como stack do coletor, o que viola DOC-00 §2.2
(stack `[INVIOLÁVEL]`) e o próprio DOC-15 (RNF-COL-001: PWA obrigatório, app
nativo **fora de escopo**). Antes de escrever qualquer código, essa
divergência foi levantada com o usuário, que optou por **pausar e revisar o
prompt antes de implementar**.

O usuário então apresentou uma primeira revisão
(`PROMPT-SESSAO-COL1-pwa-coletor.md`) já corrigindo a stack para Next.js/PWA
dentro de `apps/frontend`, mas essa revisão ainda tinha três imprecisões em
relação ao DOC-15:

1. Catálogo de telas inventado (uma tela "T8=LPN" que não existe no catálogo
   fechado do DOC-15 §4.5 — lá T8 é Sincronização);
2. Divisão de escopo errada (incluía a execução da T5 Contagem em COL-1,
   quando o DOC-15 §10 atribui todas as telas de execução T2–T6 a COL-2);
3. Ausência do requisito de PIN (RF-SEG-004), obrigatório desde COL-1.

Essas imprecisões foram apontadas e o arquivo foi reescrito para ficar fiel
ao DOC-15 (catálogo de 8 telas, divisão T1/T7/T8+plataforma em COL-1 vs.
T2-T6+offline em COL-2, PIN incluído). É essa versão reescrita que foi
efetivamente executada.

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RD-COL-001 `field_device` (GLOBAL, sem RLS) | `infra/postgres/migrations/0066-campo-catalogo-dispositivo-pin.sql` | `campo.integration.spec.ts` |
| RNF-COL-003 registro de dispositivo | `field-device/field-device.service.ts` + `.controller.ts` | `campo.integration.spec.ts` |
| RF-SEG-004/RF-COL-030 PIN (definir, verificar, 3 falhas → login completo) | `pin/pin.service.ts` + `.controller.ts` (reaproveita `PasswordService`/`JwtService`) | `campo.integration.spec.ts` |
| T1 Minhas Tarefas (putaway+replenishment por `assigned_to_user_id`) | `my-tasks/my-tasks.service.ts` + `.controller.ts` | `campo.integration.spec.ts` |
| T7 Consulta de saldo (oculta `qty_available` em endereço `INVENTORY`) | `stock-search/stock-search.service.ts` + `.controller.ts` | `campo.integration.spec.ts` |
| T8 Sincronização (`wms.sync_operation` por `device_id`) | `sync-status/sync-status.service.ts` + `.controller.ts` | `campo.integration.spec.ts` |
| `wms_worker` grants para leitura cross-tenant (`pallet`, `sync_operation`) | `infra/postgres/migrations/0067-campo-grants-worker.sql` | `grants-contract.integration.spec.ts` (DECLARED_GRANTS atualizado) |
| RNF-COL-010 `[INVIOLÁVEL]` leitura wedge sem campo focado | `apps/frontend/src/lib/field/use-wedge-scanner.ts` | `use-wedge-scanner.spec.ts` (5 testes, jsdom) |
| RNF-COL-011 fallback de câmera (`BarcodeDetector`) | `apps/frontend/src/lib/field/use-camera-scanner.ts` | manual (sem Chrome real no CI, ver §4) |
| RN-COL-012 `[INVIOLÁVEL]` validador universal de leitura | `apps/frontend/src/lib/field/scanner.ts` | `scanner.spec.ts` (12 testes) |
| RNF-COL-002 PWA instalável (manifest + SW mínimo, sem fila offline) | `public/field-manifest.json`, `public/field-sw.js` | manual (`docker compose` + `curl`, ver §4) |
| RNF-COL-020 `[INVIOLÁVEL]` UX de campo (alvo ≥48dp, texto ≥16, ações na metade inferior) | `app/field/layout.tsx`, `app/field/page.tsx`, `app/field/consulta/page.tsx`, `app/field/sincronizacao/page.tsx` | build + inspeção visual |
| RF-COL-030 bloqueio por inatividade (5 min) + overlay de PIN | `app/field/layout.tsx` (`PinLockOverlay`) | build (sem teste de timer — ver §5 lacunas) |
| device_id (UUID v7, IndexedDB) | `apps/frontend/src/lib/field/device-id.ts` | coberto indiretamente via `campo.integration.spec.ts` (registro aceita o id enviado) |

## 2. Comandos executados e saída real

### Build

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm --filter @wms/frontend build
✓ Compiled successfully
✓ Generating static pages (12/12)
Route (app)                              Size     First Load JS
├ ○ /field                               3.42 kB        90.7 kB
├ ○ /field/consulta                      4.35 kB        91.6 kB
├ ○ /field/login                         983 B          99.9 kB
├ ○ /field/sincronizacao                 1.32 kB        92.2 kB
(demais rotas inalteradas)
```

### Testes unitários

```
$ pnpm --filter @wms/backend test
 Test Files  19 passed (19)
      Tests  193 passed (193)

$ pnpm --filter @wms/frontend test
 Test Files  3 passed (3)
      Tests  18 passed (18)
 ✓ src/lib/field/__tests__/scanner.spec.ts (12 tests)
 ✓ src/lib/field/__tests__/use-wedge-scanner.spec.ts (5 tests)
```

### Testes de integração (Postgres real, 2 execuções consecutivas)

```
$ pnpm test:integration   # execução 1
 Test Files  70 passed (70)
      Tests  287 passed (287)
 ✓ src/modules/campo/__tests__/campo.integration.spec.ts (9 tests)
 ✓ src/core/database/__tests__/grants-contract.integration.spec.ts (6 tests)
 Duration  163.63s

$ pnpm test:integration   # execução 2
 Test Files  70 passed (70)
      Tests  287 passed (287)
 Duration  163.19s
```

Nenhum teste pré-existente regrediu; nenhuma flakiness entre as duas execuções.

### Docker (DoD)

```
$ docker compose -f infra/docker-compose.yml up -d --build
 Image infra-backend-api Built
 Image infra-backend-scheduler Built
 Image infra-backend-worker Built
 Image infra-frontend Built
 Container wms-backend-api Started (healthy)
 Container wms-backend-worker Started (healthy)
 Container wms-backend-scheduler Started (healthy)
 Container wms-frontend Started

$ docker compose ps
wms-backend-api         Up (healthy)   0.0.0.0:3000->3000/tcp
wms-frontend            Up             0.0.0.0:3001->3001/tcp
(postgres/redis/minio já rodando de sessões anteriores, healthy)

$ curl -s localhost:3000/health/ready
{"status":"ok","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" localhost:3001/field/login
HTTP 200
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" localhost:3001/login
HTTP 200
```

Log do boot confirma RN-SEG-012 (auditoria de rotas) cobrindo as novas rotas
`/campo/*`:

```
[RoutesResolver] FieldDeviceController {/campo/dispositivos}
[RoutesResolver] PinController {/campo/pin}
[RoutesResolver] MyTasksController {/campo/minhas-tarefas}
[RoutesResolver] StockSearchController {/campo/consulta}
[RoutesResolver] SyncStatusController {/campo/sincronizacao}
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.
```

## 3. Decisões tomadas e justificativa

- **`MyTasksController` agrega apenas `putaway_task` + `replenishment_task`**
  — ambos já possuem `assigned_to_user_id`. `picking_task` foi
  deliberadamente excluído (ver lacuna §5) em vez de forçar uma consulta
  cross-order que exigiria mudança de schema fora do escopo desta sessão.
- **`transactionAsWorker()`/grants novos em `pallet` e `sync_operation`**
  (migration `0067`) — a tarefa de um operador pode envolver LPNs/paletes de
  mais de um tenant dentro do mesmo armazém; seguido o padrão do ADR-006
  (grant granular por consumidor real, não especulativo).
- **PIN reaproveita `PasswordService`/`JwtService`** em vez de duplicar o
  fluxo de login — o PIN é uma re-autenticação de sessão já autenticada, não
  um segundo mecanismo de login.
- **Service worker SEM fila offline** — implementar uma fila que finge
  sincronizar sem produtor real (`wms.sync_operation` está vazio até COL-2)
  seria pior que não ter nenhuma: passaria a falsa impressão de que ações
  offline são preservadas. A tela T8 reflete isso mostrando contadores
  zerados com o rótulo explícito de que a fila real é da próxima sessão.
- **Rota real `apps/frontend/src/app/field/`** em vez de route group
  `(field)` — um route group não gera segmento de URL; `(field)` resolveria
  para `/login`, colidindo com a rota interna já existente. Usar um segmento
  real dá `/field/*` sem ambiguidade.
- **Teste do listener wedge adicionado nesta sessão** (não estava no
  primeiro build) — o prompt (§5) exige explicitamente esse teste; foi
  criado com `@vitest-environment jsdom` + `@testing-library/react`
  (`renderHook`), cobrindo: captura sem elemento focado, buffer vazio,
  teclas de modificador ignoradas, `enabled=false` e cleanup no unmount.

## 4. Verificação manual (sem Chrome real no ambiente de CI)

- Manifest servido em `http://localhost:3001/field-manifest.json` e
  referenciado dinamicamente pelo layout de campo (`rel=manifest`
  injetado via `useEffect`).
- Service worker registrado em `/field-sw.js`, escopo restrito a `/field`
  (early-return em `fetch` para qualquer path fora de `/field`).
- `BarcodeDetector` (RNF-COL-011) não tem teste automatizado — é uma API só
  disponível em Chrome Android real; o fallback foi verificado por leitura
  de código (guard `camera.supported` antes de oferecer o botão).

## 5. Lacunas e débitos (explícitos, para COL-2)

- **`picking_task` fora de "Minhas Tarefas" (T1)** — `PickingTaskService`
  não tem coluna/consulta por operador nem lista cross-order hoje; exigiria
  mudança no módulo de expedição, fora do escopo de COL-1.
  `[LACUNA: DOC-15]` citada no código (`my-tasks.service.ts`).
- **Sem produtor real de fila de sincronização** — `wms.sync_operation`
  existe mas nada escreve nela ainda; T8 sempre mostra zero. Fica para
  COL-2 (RF-ARQ-052).
- **T2–T6 (Putaway, Picking, Conferência, Contagem, Transferência) não
  implementadas** — são as telas de execução, todas atribuídas a COL-2 pelo
  DOC-15 §10, incluindo a T5 Contagem mesmo com o motor de inventário da
  Sessão 5C já pronto no servidor.
- **Pacote de Turno (RF-ARQ-051), resolução de conflito (RN-ARQ-053), limite
  de fila (RNF-ARQ-054), telemetria (RNF-COL-051) e atualização controlada
  por versão mínima (RNF-COL-050)** — todos dependem de haver execução
  offline real, que só existe a partir de COL-2; `COL.VERSAO_MINIMA` já está
  parametrizado no schema mas não há tela de execução para bloquear ainda.
- **Bloqueio por inatividade sem teste automatizado de timer** — o
  comportamento de 5 minutos em `field/layout.tsx` foi verificado por
  leitura de código (mesmo padrão de `setInterval`+`Date.now()` já usado em
  outras telas do sistema), mas não há teste de componente cobrindo a
  transição para o overlay de PIN.

## 6. Arquivos desta sessão

**Migrations**: `0066-campo-catalogo-dispositivo-pin.sql`,
`0067-campo-grants-worker.sql`.

**Backend** (`apps/backend/src/modules/campo/`): `campo.module.ts`,
`field-device/{field-device.service,controller}.ts`,
`pin/{pin.service,controller}.ts`,
`my-tasks/{my-tasks.service,controller}.ts`,
`stock-search/{stock-search.service,controller}.ts`,
`sync-status/{sync-status.service,controller}.ts`,
`__tests__/campo.integration.spec.ts` (9 testes). `app.module.ts` atualizado
para importar `CampoModule`. `grants-contract.integration.spec.ts`
atualizado com os novos grants.

**Frontend**: `src/app/field/{layout,page}.tsx`, `field/login/page.tsx`,
`field/consulta/page.tsx`, `field/sincronizacao/page.tsx`,
`src/lib/field/{device-id,field-api,scanner,use-wedge-scanner,use-camera-scanner}.ts`,
`src/lib/field/__tests__/{scanner,use-wedge-scanner}.spec.ts`,
`public/{field-icon.svg,field-manifest.json,field-sw.js}`. `package.json`
(dependência `idb`), `src/lib/auth-context.tsx` (assinatura de
`login`/`logout` com `redirectTo`), `src/app/(internal)/layout.tsx` (ajuste
de `onClick` após a mudança de assinatura).

**Prompt**: `docs/PROMPT-SESSAO-COL1-pwa-coletor.md` (reescrito nesta sessão
para ficar fiel ao DOC-15, ver §0).
