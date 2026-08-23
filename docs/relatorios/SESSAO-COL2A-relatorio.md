# Sessão COL-2A — Motor Offline: Pacote de Turno, Fila e Resolução de Conflitos (Servidor)

Prompt executado: `docs/PROMPT-SESSAO-COL2A-motor-offline-sincronizacao.md`.

Sem conflito de stack a reportar (NestJS + PostgreSQL, dentro de
`apps/backend/src/modules/campo/`, conforme DOC-00 §2.2).

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| DOC-01 §5.2 máquina de estados normativa da `sync_operation` | `infra/postgres/migrations/0068-campo-sincronizacao-offline.sql` §1 | `campo-col2a.integration.spec.ts` (b), `campo.integration.spec.ts` (T8, atualizado) |
| RF-ARQ-051 Pacote de Turno + `COL.PACOTE_TURNO_MAX` | `shift-package/shift-package.service.ts` + `.controller.ts`; migration §3 | `campo-col2a.integration.spec.ts` (d) |
| RF-ARQ-052 recepção da fila offline | `offline-sync/offline-sync.service.ts` + `.controller.ts` | `campo-col2a.integration.spec.ts` (b) |
| RN-ARQ-053 `[INVIOLÁVEL]` as 4 decisões | `offline-sync/offline-sync.service.ts::classifyAndDispatch` | `campo-col2a.integration.spec.ts` (b) — PUTAWAY e REPOSICAO, 4 decisões + reenvio idempotente |
| RNF-ARQ-054 limite de fila não bloqueia sincronização | `offline-sync.service.ts::sincronizar` (processa sempre a fila inteira) | `campo-col2a.integration.spec.ts` (c) |
| RNF-ARQ-050/RG-009 idempotência por `operationId` em `CheckingService` (T4) | `recebimento/checking/checking.service.ts::countFirstRound/recount/applyCount`; `wms.checking_operation` (migration §2) | `campo-col2a.integration.spec.ts` (a) |
| idem em `StockTransferService.transferInternal` (T6) | `estoque/transfer/stock-transfer.service.ts`; `wms.stock_transfer_operation` | `campo-col2a.integration.spec.ts` (a) |
| idem em `InventoryCountExecutionService.submitRound` (T5) | `estoque/inventory/inventory-count-execution.service.ts`; `wms.inventory_count_operation` | `campo-col2a.integration.spec.ts` (a) |
| RNF-COL-050 `[INVIOLÁVEL]` gate de versão mínima | `field-device/field-device.service.ts::isVersionBlocked/registerOrTouch` | `campo-col2a.integration.spec.ts` (e) |
| RNF-COL-051 telemetria (fila, falhas de leitura físico/câmera) | `field-device.service.ts::recordTelemetry`; colunas novas em `wms.field_device` (migration §2b) | `campo-col2a.integration.spec.ts` (f) |
| RNF-COL-051 alerta "dispositivo sem contato > 24h com fila > 0" | `field-device.service.ts::checkOfflineWithPendingQueue`; `workers/field-device-offline.worker.impl.ts`; `alert-materialization.service.ts` (`campo.dispositivo_sem_contato` → `DISPOSITIVO_CAMPO_OFFLINE`) | verificado por leitura de código + boot real (log do scheduler, §2 abaixo) — sem teste de integração dedicado, ver §5 |
| Divergência de sincronização (AD-007, decisão 4) | migration §4 (`exception_type` `COL.SINCRONIZACAO_REJEITADA`) | `campo-col2a.integration.spec.ts` (b, decisão 4) |
| Grants `wms_worker`/`wms_app` por consumidor real | migration §6; `core/database/__tests__/grants-contract.integration.spec.ts` (atualizado) | `grants-contract.integration.spec.ts` |

## 2. Comandos executados e saída real

### Build

```
$ cd apps/backend && pnpm exec tsc --noEmit -p tsconfig.json
TypeScript: No errors found

$ pnpm build
> nest build
(sem erros)
```

### Testes unitários

```
$ pnpm test
 Test Files  19 passed (19)
      Tests  193 passed (193)
```

### Testes de integração (Postgres real)

O agente que escreveu a suíte desta sessão rodou o ciclo completo 2x
consecutivas (nenhuma flakiness); a verificação abaixo foi refeita de forma
independente nesta sessão principal antes de fechar o relatório:

```
$ pnpm test:integration
 ✓ src/modules/campo/__tests__/campo-col2a.integration.spec.ts (15 tests) 2357ms
 ✓ src/modules/campo/__tests__/campo.integration.spec.ts (9 tests)
 ✓ src/core/database/__tests__/grants-contract.integration.spec.ts (6 tests)
 Test Files  71 passed (71)
      Tests  302 passed (302)
 Duration  160.05s
```

Rodada novamente (2ª execução consecutiva, mesma verificação independente):
mesmo resultado — `71 passed (71)` / `302 passed (302)`, sem flakiness.

### Docker (DoD)

```
$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-postgres         Healthy
 Container wms-redis            Healthy
 Container wms-minio            Healthy
 Container wms-backend-worker   Started
 Container wms-backend-api      Started
 Container wms-backend-scheduler Started
 Container wms-frontend         FALHOU — porta 3001 já alocada no host (pré-
   existente, sem relação com esta sessão — COL-2A é 100% backend, nenhum
   arquivo de apps/frontend foi tocado)

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"...","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200
```

Log do boot confirma migração `0068` aplicada sem erro ("✓ Ran 0 pending
migrations" na subida — já aplicada por execução anterior do próprio ciclo
de verificação desta sessão), RN-SEG-012 liberando o boot com as novas rotas
declaradas, e o worker novo ativo:

```
[RoutesResolver] ShiftPackageController {/campo/pacote-turno}
[RouterExplorer] Mapped {/campo/pacote-turno, GET} route
[RoutesResolver] OfflineSyncController {/campo/sincronizacao}
[RouterExplorer] Mapped {/campo/sincronizacao, POST} route
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.
...
[Bootstrap] ✓ Scheduler service started (partition-manager + exception-expiry + no-show + crossdock-aging + expiration-alert + replenishment-alert + reservation-expiry + kpi-snapshot + field-device-offline)
```

## 3. Decisão sobre o enum de `wms.sync_operation_status` (§1 do prompt)

Migrado para os **nomes normativos do DOC-01 §5.2**
(`LOCAL_PENDENTE`/`ENVIANDO`/`APLICADA`/`DESCARTADA_DUPLICIDADE`/
`REJEITADA_TAREFA_INVALIDA`/`REJEITADA_REGRA`), em vez de manter
`PENDING`/`IN_PROGRESS`/`SYNCED`/`CONFLICT`/`FAILED`/`EXPIRED` com uma
tabela de mapeamento. Justificativa: evita uma tradução implícita "o que o
banco diz" × "o que a especificação diz" em todo consumidor futuro — CLAUDE.md
exige máquinas de estado explícitas e fiéis à especificação. Não havia dado
real em produção (COL-2A é o primeiro produtor efetivo da fila; migration
0006 já registrava isso). `EXPIRED` (TTL de 7 dias, sem correspondente na
máquina normativa de 6 estados) foi absorvido em `REJEITADA_TAREFA_INVALIDA`
(mesma família semântica — operação que não pode mais ser aplicada).

**Bug real encontrado e corrigido durante a implementação**: a migration
originalmente derrubava os 2 índices parciais de `wms.sync_operation`
(`idx_sync_operation_pending`/`idx_sync_operation_expired`, cujo predicado
`WHERE` cita os literais do enum antigo) **depois** do
`ALTER COLUMN status TYPE`. Isso falha em runtime
(`operator does not exist: sync_operation_status = sync_operation_status_old`)
porque o rewrite da coluna precisa reconciliar o predicado do índice
dependente com o tipo novo, e o literal ainda está ligado ao OID do tipo
velho (renomeado, não convertido — não há cast implícito entre dois enums
distintos). Corrigido invertendo a ordem: `DROP INDEX` primeiro,
`ALTER COLUMN TYPE` depois, `CREATE INDEX` (já com os literais novos) por
último. Confirmado rodando a migration do zero contra o Postgres de teste.

`SyncStatusService` (T8, COL-1) manteve o contrato público de 4 contadores
(`pending`/`synced`/`conflict`/`failed`) já testado por COL-1, remapeando
internamente: `pending` = `LOCAL_PENDENTE+ENVIANDO`; `synced` = `APLICADA`;
`conflict` = `DESCARTADA_DUPLICIDADE`; `failed` =
`REJEITADA_TAREFA_INVALIDA+REJEITADA_REGRA`. O teste pré-existente
(`campo.integration.spec.ts`) foi atualizado para inserir com os literais
novos.

## 4. Outras decisões tomadas e justificativa

- **Idempotência das 3 novas operações em tabela PRÓPRIA** (`checking_operation`/
  `stock_transfer_operation`/`inventory_count_operation`), não em coluna
  `operation_id` nas tabelas de domínio — apesar de `checking_item`/
  `stock_transfer`/`inventory_count_round` NÃO serem particionadas (diferente
  de `putaway_task`/`replenishment_task`, onde a tabela própria é obrigatória
  por causa da partição). Optado por uniformidade com o padrão já
  estabelecido e testado (`wms.putaway_operation`/`wms.replenishment_operation`)
  e porque o replay precisa devolver a MESMA resposta computada (item +
  divergência / documento / resultado da rodada), não só detectar "já
  existe".
- **`CheckingService`: idempotência só em `countFirstRound`/`recount`**, não
  em `registerAvaria`/`registerTroca` — DOC-15 T4 é especificamente "contagem
  cega/informada" (RF-REC-021); avaria/troca são ações excepcionais, fora do
  fluxo padrão do coletor. Escopo explícito, não um esquecimento.
- **`OfflineSyncService`: classificação por "peek" do status ANTES de
  chamar o service de execução** — para cada operação com `taskId` (todas
  exceto TRANSFERENCIA), lê o status atual da tarefa e decide: status
  "cancelado" (`CANCELLED`/`REFUSED`, conforme o tipo) → `REJEITADA_TAREFA_INVALIDA`
  sem sequer chamar o service; senão chama o service normalmente — sucesso
  (inclusive replay idempotente) → `APLICADA`; se lançar exceção, usa o
  status já observado no peek para decidir entre `DESCARTADA_DUPLICIDADE`
  (status já era "concluído" antes desta sincronização) e `REJEITADA_REGRA`
  (qualquer outra falha de regra de negócio, que também abre a Divergência
  `COL.SINCRONIZACAO_REJEITADA`). Isso evita inspecionar códigos de erro por
  serviço (5 services diferentes, cada um com seus próprios códigos) e reusa
  o mesmo dado (status observado) tanto para decidir se chama o service
  quanto para classificar uma falha inesperada. **Risco aceito e documentado
  no código**: existe uma janela de corrida entre o peek e a chamada — se
  outro ator concluir a tarefa EXATAMENTE nesse intervalo, a operação é
  classificada como `REJEITADA_REGRA` em vez de `DESCARTADA_DUPLICIDADE`
  (mesma classe de risco já aceita em outros pontos da base, ex.:
  `operationalExceptionService.create()` fora da transação principal em
  `picking-task.service.ts`/`inventory-count-execution.service.ts`).
- **TRANSFERENCIA (T6, RF-EST-050) é tratada como ad-hoc, sem `taskId`** —
  diferente de putaway/reposição/picking/conferência/contagem, RF-EST-050 não
  tem tarefa dirigida pré-aprovisionada ("imediata em tela"); só as decisões
  1 (APLICADA) e 4 (REJEITADA_REGRA) se aplicam — decisões 2/3 pressupõem uma
  tarefa que pode ter sido concluída/cancelada por outro ator, o que não
  existe nesse fluxo.
- **Eventos novos** (`campo.sincronizacao_aplicada`/`_descartada`/`_rejeitada`,
  `campo.dispositivo_sem_contato`) roteados em
  `packages/contracts/realtime-topics.ts` seguindo a categorização já
  estabelecida (progresso rotineiro → `operations:pending`; o que exige
  atenção humana → `alertas`) — mesmo precedente de
  `recebimento.crossdock_tempo_excedido`/`portaria.vaga_indisponivel`
  (evento novo citando a fonte exata do requisito, não um dos catálogos
  fechados por DOC).
- **Alerta RNF-COL-051 publicado por evento, não por chamada direta a
  `AlertService`** — `FieldDeviceService` não importa `PaineisModule`;
  publica `campo.dispositivo_sem_contato` (mesmo padrão de
  `CrossDockService.checkAging()`), consumido por
  `AlertMaterializationService.applyEvent()`.
- **`ShiftPackageService` reaproveita as queries de `MyTasksService`**
  (putaway/reposição por `assigned_to_user_id`) e as estende: `picking_task`
  (T3) passa a entrar no Pacote de Turno, filtrado por
  `assigned_to_user_id = operador OU NULL` (mesmo padrão de atribuição
  preguiçosa já usado por `PickingTaskService.executeTask` — resolve o débito
  citado pela auditoria de COL-1, decisão explícita desta sessão, não
  acidente). Conferência (T4) e Contagem de Inventário (T5) entram como POOL
  do armazém inteiro (não filtradas por operador): `checking_item`/
  `inventory_count_location` não têm coluna de atribuição por operador —
  `[LACUNA: DOC-05/DOC-15 não modelam atribuição de célula de inventário/
  item de conferência por operador]`, documentada no código.
- **`FieldDeviceService.isVersionBlocked()` lê `COL.VERSAO_MINIMA` via
  `transactionAsWorker`, não `queryGlobal()`** — `wms.app_parameter` TEM RLS
  mesmo em linhas `scope='GLOBAL'` (achado transversal já registrado em
  CLAUDE.md); sem `tenant_id` disponível no momento do registro do
  dispositivo, a leitura precisa ser cross-tenant via `wms_worker`
  (BYPASSRLS), mesmo padrão de `CrossDockService.checkAging()`.
- **Comparação semver própria (`compareSemver`)**, sem dependência nova —
  `COL.VERSAO_MINIMA` usa o formato simples `major.minor.patch`; uma função
  pura de ~10 linhas evita puxar uma lib externa para um comparador trivial.

## 5. Lacunas e débitos

- **`[DÉBITO]` Cenários PICKING via `OfflineSyncService`** não têm teste de
  integração dedicado nesta sessão — a fixture completa de picking (onda →
  reserva → tarefa) tem o mesmo custo do arquivo inteiro de
  `picking-packing-carregamento.integration.spec.ts` (Sessão 6B); PUTAWAY e
  REPOSICAO já provam as 4 decisões de RN-ARQ-053 em 2 tipos de tarefa
  distintos, conforme a própria seção 4 do prompt permite ("pelo menos 2
  tipos de tarefa diferentes"). O dispatch para `PickingTaskService.executeTask`
  está implementado e compila (`OfflineSyncService::executeTask`, case
  `'PICKING'`), só não tem cenário de integração cobrindo-o. Sessão-alvo:
  COL-2B ou uma sessão futura de regressão de picking.
- **`[DÉBITO]` `checkOfflineWithPendingQueue()`/`FieldDeviceOfflineWorkerImpl`
  (alerta RNF-COL-051)** verificados por leitura de código + confirmação de
  boot real (log do scheduler mostrando o worker ativo), mas sem teste de
  integração dedicado simulando um dispositivo real sem contato > 24h — o
  padrão é idêntico ao já testado de `CrossDockAgingWorkerImpl`
  (`crossdock-aging.integration.spec.ts`, se existir) e ao já usado por
  `AlertMaterializationService`, mas não foi replicado aqui por escopo/tempo
  desta sessão.
- **`[LACUNA]` DOC-05/DOC-15 não modelam atribuição de célula de inventário
  (`inventory_count_location`) nem de item de conferência
  (`inbound_order_item`/`checking_item`) por operador específico** — DOC-15
  §4.7 fala em "endereços atribuídos ao operador" para a T5, mas a tabela
  real é um pool do armazém (qualquer titular de `EST.INVENTARIO_CONTAR`/
  `REC.CONFERIR` pode pegar qualquer célula/item pendente). `ShiftPackageService`
  lista o pool inteiro do armazém para essas duas telas — ver §4 acima.
- **`[LACUNA]` "pendência de supervisão" (decisão 3, `REJEITADA_TAREFA_INVALIDA`)
  não tem entidade própria modelada em nenhum DOC lido nesta sessão** —
  implementado como: atualização de `wms.sync_operation`, evento
  `campo.sincronizacao_rejeitada` (tópico `alertas`) e log de auditoria
  (RG-003). Se uma sessão futura definir uma entidade formal de "pendência de
  supervisão", este é o ponto de extensão.
- Herdado de COL-1, ainda não resolvido: nenhum — o único débito citado pela
  auditoria de COL-1 relacionado a esta sessão (`picking_task` fora de
  "Minhas Tarefas") foi resolvido no Pacote de Turno (§4 acima).

## 6. Arquivos desta sessão

**Migration**: `infra/postgres/migrations/0068-campo-sincronizacao-offline.sql`.

**Backend — novo**:
`modules/campo/shift-package/{shift-package.service,controller}.ts`,
`modules/campo/offline-sync/{offline-sync.service,controller}.ts`,
`workers/field-device-offline.worker.impl.ts`,
`modules/campo/__tests__/campo-col2a.integration.spec.ts` (15 testes).

**Backend — alterado**:
`modules/recebimento/checking/{checking.service,controller}.ts`
(`operationId` em `countFirstRound`/`recount`),
`modules/estoque/transfer/{stock-transfer.service,controller}.ts`
(`operationId` em `transferInternal`),
`modules/estoque/inventory/{inventory-count-execution.service,inventory-count.controller}.ts`
(`operationId` em `submitRound`),
`modules/campo/field-device/field-device.service.ts` (gate de versão,
telemetria estendida, `checkOfflineWithPendingQueue`, injeta `EventsService`),
`modules/campo/sync-status/sync-status.service.ts` (remapeamento do enum
novo), `modules/campo/campo.module.ts` (importa `RecebimentoModule`/
`EstoqueModule`/`ExpedicaoModule`/`WorkflowModule`/`EventsModule`, registra
`ShiftPackageService`/`OfflineSyncService`), `modules/paineis/alertas/alert.service.ts`
(`DISPOSITIVO_CAMPO_OFFLINE`), `modules/paineis/alertas/alert-materialization.service.ts`
(case `campo.dispositivo_sem_contato`), `packages/contracts/src/realtime-topics.ts`
(4 eventos novos), `main.ts` (registra `FieldDeviceOfflineWorkerImpl` no
scheduler), `modules/campo/__tests__/campo.integration.spec.ts` (enum novo,
construtor de `FieldDeviceService`), `core/database/__tests__/grants-contract.integration.spec.ts`
(6 tabelas novas/alteradas).

**Prompt**: `docs/PROMPT-SESSAO-COL2A-motor-offline-sincronizacao.md`.

## 7. Próximo passo

**Sessão COL-2B**: IndexedDB do Pacote de Turno e da fila local, as 5 telas
de execução T2–T6 (reaproveitando `useWedgeScanner`/`useCameraScanner`/
`scanner.ts` da COL-1), sincronização oportunista (RF-COL-041), bloqueio
client-side por limite de fila (RNF-ARQ-054, > 500 operações ou > 8h) e por
versão mínima (RNF-COL-050 — `GET /campo/dispositivos` já devolve
`versionBlocked`; falta o consumo no cliente), estado permanente no topo da
tela. Payloads de `POST /campo/sincronizacao` para os 6 `taskType` já estão
definidos por este backend (`OfflineOperationInput`/`OfflineTaskType`) — ver
`offline-sync.service.ts` para o contrato exato de cada `payload`.
