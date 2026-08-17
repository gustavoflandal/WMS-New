# HANDOFF EM ANDAMENTO — Sessão 4A: DOC-04 Recebimento e Docas (sem motor de putaway)

**Status**: **CONCLUÍDA — DoD completo, aguardando só a confirmação do usuário para commit/push.** Todos os services de negócio do escopo (exceto motor de putaway, 4B) implementados e testados; `docker compose up -d --build` (dev) com os 3 papéis `healthy`; `curl localhost:3000/health/ready` → 200. Relatório final em `docs/relatorios/SESSAO-4A-relatorio.md`. Este documento (`HANDOFF-EM-ANDAMENTO.md`) fica como registro histórico do processo da retomada — pode ser apagado após o commit, ou mantido como referência de "como os 10 bugs foram encontrados", a critério do usuário.

**Antes de retomar**: leia este documento inteiro. Ele reflete o estado REAL verificado (não aspiracional) no momento da última pausa. A seção 3 original (Sessão 4A parte 1) foi mantida abaixo para histórico; a seção 3-BIS descreve o que mudou nesta retomada.

---

## 1. Missão (resumo)

Implementar o DOC-04 completo EXCETO o motor de putaway (RN-REC-040/041/042 — Fase 1 filtros + Fase 2 ranqueamento — fica para a Sessão 4B). Escopo: docas, Ordem de Recebimento (ASN/XML/manual), conferência cega com recontagem, as 5 divergências com workflows, etiquetagem/LPN, quarentena por espécie, cross-docking. Contexto autorizado: DOC-00, DOC-04, `docs/relatorios/SESSAO-4-relatorio.md` — nenhum outro documento.

**Regras vigentes** (idênticas às da Sessão 4, RG-002/RG-003/RN-SEG-012 herdadas): citar §/ID do DOC-04 em toda tabela/coluna/enum/permissão/exceção/evento; `[LACUNA: ...]` em vez de inventar; `[DÉBITO: descrição + sessão-alvo]` para dificuldade técnica (débito que bloqueia o DoD não pode ser adiado); proibido `USING(true)`, optional chaining escondendo DI, `.skip`, mock de Postgres/Redis em integração, enfraquecer regra `[INVIOLÁVEL]`, declarar ✅ sem saída real; proibido remover/mover/renomear arquivo fora do escopo sem confirmação explícita.

**Item 0 era prioridade explícita e bloqueante**: isolar a infraestrutura de teste do Docker Compose de desenvolvimento (achado real da Sessão 4 — contenção causou falha fantasma). Critério: `pnpm test:integration` roda com o Docker Compose de dev ATIVO, sem interferência, 2 execuções seguidas verdes.

---

## 2. O que está PRONTO E VERIFICADO (item 0 — 100% completo)

✅ **Isolamento de infraestrutura de teste — verificado com saída real, 2 execuções consecutivas, 44/44 arquivos e 95/95 testes, com `docker compose up` de DEV totalmente ativo (backend-api/worker/scheduler rodando) durante as duas corridas.** Confirmado também que o Postgres de dev NÃO foi tocado (32 migrations intactas, `curl localhost:3000/health/ready` respondeu 200 depois).

**Achado crítico descoberto**: `apps/backend/test-setup.ts` (globalSetup do vitest) executa `DROP SCHEMA wms CASCADE` a cada corrida. Antes desta sessão, isso rodava contra `POSTGRES_PORT` do shell/`.env` — se apontado para a porta do Postgres de DEV (5432, igual ao `docker-compose.yml`), **apagaria dados reais de desenvolvimento**, não é só contenção de recursos como a Sessão 4 havia registrado.

**Arquivos criados/modificados** (nenhum commitado ainda):
- `infra/docker-compose.test.yml` (novo) — projeto Compose `wms-test` (nome fixo via `name:`, evita colidir com o projeto `infra` do dev compose, que fica no mesmo diretório). 3 serviços: `postgres-test` (porta 5433), `redis-test` (porta 6380, `--appendonly no`), `minio-test` + `minio-test-init` (porta 9002, bucket `wms-test`).
- `.env.test` (novo, **gitignorado** — só existe localmente, precisa ser recriado se o worktree for clonado de novo; copiar de `.env.test.example`).
- `.env.test.example` (novo, rastreado) — modelo documentado.
- `.gitignore` — adicionado `.env.test`.
- `apps/backend/test-setup.ts` — carrega `.env.test` via `dotenv.config({override:true})` ANTES de ler `POSTGRES_*`; lança erro se `.env.test` não existir OU se `POSTGRES_PORT === '5432'` (defesa em profundidade contra apontar para o dev).
- `apps/backend/src/core/database/__tests__/test-setup.helper.ts` — mesmo mecanismo (dotenv override + guarda de porta 5432); defaults trocados de 5432/`wms_db`/6379 para 5433/`wms_test`/6380.
- `apps/backend/package.json` — `dotenv` e `minio` e `fast-xml-parser` adicionados como dependências (minio/fast-xml-parser são para itens 6/4, ver §4 abaixo); novo script `pretest:integration`: `docker compose -f ../../infra/docker-compose.test.yml up -d --wait` (roda automaticamente antes de `pnpm test:integration` via hook do pnpm — CONFIRMADO que funciona, foi assim que as 2 corridas verificadas rodaram).

**Comando para verificar que a infra de teste está de pé**:
```bash
docker compose -f infra/docker-compose.test.yml up -d --wait
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}"
# Espera: wms-postgres-test (5433), wms-redis-test (6380), wms-minio-test (9002) healthy
```

---

## 3. O que está ESCRITO MAS NÃO TESTADO (compilação nunca confirmada)

**Nenhum destes arquivos foi rodado através de `pnpm build` ou de qualquer teste ainda.** Trate como rascunho a revisar, não como implementação confiável.

### 3.1 Migrations (0033–0041) — aplicadas com sucesso via `psql` direto (sintaxe validada), mas NUNCA através do pipeline real de testes/build TypeScript

Todas aplicadas manualmente contra `wms-postgres-test` (`docker exec -i wms-postgres-test psql -U postgres -d wms_test -v ON_ERROR_STOP=1 -f - < <arquivo>`), sem erro:

| # | Arquivo | Conteúdo |
|---|---|---|
| 0033 | `0033-recebimento-catalog.sql` | 6 permissões `REC.*` + grants; 6 `exception_type`; `app_parameter` (`REC.PERMITE_PALETE_MISTO`, `REC.QUARENTENA_ESPECIES`, `REC.CROSSDOCK_TEMPO_MAX_H`) |
| 0034 | `0034-operation-flow.sql` | `wms.operation_flow` + `wms.flow_step` (TENANT, RLS) — **núcleo genérico reutilizável**, não específico de recebimento |
| 0035 | `0035-recebimento-inbound-order.sql` | `inbound_order` + `inbound_order_item` (TENANT, RLS) — máquina de estados §5.1 completa |
| 0036 | `0036-recebimento-inbound-invoice.sql` | `inbound_invoice` (TENANT, RLS) |
| 0037 | `0037-recebimento-checking.sql` | `checking` + `checking_item` (TENANT, RLS) — contagem por `round` (1=primeira, 2=recontagem) |
| 0038 | `0038-recebimento-discrepancy.sql` | `discrepancy` (TENANT, RLS) — CHECK `AVARIA` exige `photo_keys` não vazio |
| 0039 | `0039-recebimento-putaway-task.sql` | `putaway_task` (TENANT, RLS, particionada RNF-ARQ-090) — **ESTRUTURA APENAS, nada insere linhas nesta sessão** (motor é 4B) |
| 0040 | `0040-recebimento-crossdock-link.sql` | `crossdock_link` (TENANT, RLS) |
| 0041 | `0041-recebimento-dock-zone-distance.sql` | `dock_zone_distance` (GLOBAL, sem RLS — como `dock`/`zone`) — matriz `REC.MAPA_DISTANCIA_DOCA_ZONA` |

### 3.2 Código TypeScript — estado ATUALIZADO em 2026-08-17

- `apps/backend/src/core/operation-flow/operation-flow.service.ts` + `.module.ts` — motor genérico RG-002. **Compilado e exercitado de verdade** via `InboundOrderService` (ver §3-BIS) — `createFlow`+`completeStep('CHEGADA')` chamados em toda criação de Ordem, com asserção real do resultado (`CHEGADA:DONE`, demais `PENDING`) em teste de integração.
- `apps/backend/src/core/storage/file-storage.service.ts` + `.module.ts` — cliente MinIO real. **Agora conectado e testado de verdade**: `InboundOrderService.createFromXml` sobe o XML da NF-e para `wms-minio-test` e o teste confirma `fileStorageService.exists(key) === true`. Achado real corrigido no processo: ver §3-BIS item "bugs corrigidos".
- `apps/backend/src/modules/recebimento/shared/db-error.util.ts` — inalterado, ainda não exercitado por um teste que force uma constraint violation neste módulo especificamente (os testes atuais não cobrem esse caminho).
- `apps/backend/src/modules/recebimento/shared/nfe-xml.util.ts` — **testado contra XML sintético real** (7 cenários). Bug real encontrado e corrigido: ver §3-BIS.
- `apps/backend/src/modules/recebimento/dock/dock.service.ts` — inalterado desde a sessão anterior. **Agora tem controller** (`dock.controller.ts`, ver §3-BIS) mas **ainda nenhum teste de integração** — `dockVehicle()`/`releaseDock()`/`suggestDock()` continuam nunca exercitados end-to-end. Ver "débito" em §3-BIS sobre uma possível inconsistência entre `dockVehicle()` (SQL cru) e o padrão `VehicleVisitService.transitionWithClient()`/máquina de estados usado no resto do DOC-03 — não corrigido, só observado.
- `apps/backend/src/modules/recebimento/inbound-order/inbound-order.service.ts` (NOVO) + `.controller.ts` (NOVO) — ver §3-BIS.
- `apps/backend/src/modules/recebimento/recebimento.module.ts` — **de stub vazio para módulo real**, ver §3-BIS.

### 3.3 Worker registration

- `apps/backend/src/workers/partition-manager.worker.impl.ts` — `putaway_task` em `PARTITIONED_TABLES`. **Verificado**: o teste `partition-manager.integration.spec.ts` tinha uma lista `MANAGED_TABLES` local desatualizada (só `stock_movement`+`audit_log`) que quebrava com a 3ª tabela — corrigido (bug real, não hipotético — ver §3-BIS).

### 3.4 Contratos

- `packages/contracts/src/realtime-topics.ts` — 11 eventos `recebimento.*` mapeados. **Só `recebimento.ordem_criada` foi exercitado até agora** (publicado por `InboundOrderService`); os outros 10 continuam nunca testados.

---

## 3-BIS. Retomada em 2026-08-17 — o que foi feito, verificado e corrigido

### Trabalho novo (compilado, testado com Postgres+Redis+MinIO reais, 2 execuções consecutivas verdes de `pnpm test:integration`: **45/45 arquivos, 103/103 testes**)

- **`InboundOrderService`** (`apps/backend/src/modules/recebimento/inbound-order/inbound-order.service.ts`) — `createFromXml()`, `createManual()`, `cancel()`, `findById()`. Cobre RF-REC-010(a)/(c), RN-REC-011, RN-REC-012.
  - Casamento de item: SKU exato → EAN exato (`product_barcode`) → NCM+descrição (`[LACUNA]`: sem fuzzy matching, só igualdade exata case-insensitive — documentado no código).
  - RN-REC-011/RG-014 passo 1: a `inbound_invoice` (e o início do prazo de regularização) só é registrada quando a Ordem casa com um `vehicle_visit` cujo **gate-in já foi confirmado** (status ∉ {CHEGADA_REGISTRADA, AGUARDANDO_AUTORIZACAO}) — não no upload do XML em si. Casamento automático por `vehicle_visit.nfe_keys` (DOC-03 RF-POR-011) ou `vehicleVisitId` explícito.
  - `[DÉBITO: Sessão 4B+]` documentado no próprio código: quando a Ordem é criada SEM vehicle_visit casado (ASN pré-chegada, permitido por RF-REC-010(a)/(b)), a Ordem fica CREATED mas SEM `inbound_invoice` — não existe nesta sessão um endpoint de "vínculo tardio" para registrar a fatura quando o gate-in correspondente ocorrer depois. Reenviar o mesmo XML depois falharia com `NFE_ALREADY_REGISTERED` incorretamente. Esse fluxo tardio precisa ser desenhado antes de expor `createFromXml` a ASNs verdadeiramente pré-chegada em produção.
  - `client_warehouse_settings.inbound_invoice_deadline_days` sendo `NULL` é tratado como erro determinístico (`DEADLINE_NOT_CONFIGURED`), não com um default inventado — `[LACUNA]`: nem DOC-02 nem DOC-04 definem um `app_parameter` global de prazo padrão de regularização.
  - Nenhum evento fabricado: `cancel()` e o registro de `inbound_invoice` NÃO publicam eventos porque DOC-04 §4.7 não lista nenhum para esses casos (só `recebimento.ordem_criada` é publicado, com o resultado do registro da fatura embutido no payload).
- **`InboundOrderController`** (`inbound-order.controller.ts`) — `POST /recebimento/inbound-orders/xml`, `POST /recebimento/inbound-orders/manual`, `POST /recebimento/inbound-orders/:orderId/cancel`, `GET /recebimento/inbound-orders/:orderId`. Guards `PermissionGuard` + `@RequirePermission` em toda rota (confirmado pelo `RouteAuditService`/RN-SEG-012 — o boot completo da aplicação não acusou nenhuma rota sem permissão declarada).
- **`DockController`** (`dock/dock.controller.ts`, NOVO) — expõe `DockService` (já existia, sem controller): `POST /recebimento/docks/dock-vehicle`, `POST /recebimento/docks/:dockId/release`, `GET /recebimento/docks/suggest`. **Sem teste de integração ainda** (só compilação + boot da app).
- **`recebimento.module.ts`** — de stub vazio para módulo real: importa `DatabaseModule, RbacModule, AuditModule, EventsModule, WorkflowModule, OperationFlowModule, StorageModule`; providers `DocumentNumberingService` (reinstanciado, mesmo padrão do `portaria.module.ts`), `DockService`, `InboundOrderService`; controllers `DockController`, `InboundOrderController`. **Boot completo da aplicação verificado** (`NestFactory.create(AppModule).init()` real, contra `.env.test`, sem mocks) — toda a árvore de DI resolve, incluindo os novos providers.
- **`apps/backend/src/modules/recebimento/__tests__/inbound-order.integration.spec.ts`** (NOVO, 8 testes, todos reais — Postgres+MinIO, sem mock): XML casado por SKU com invoice registrada + Fluxo Operacional correto; item SEM_CADASTRO abre `REC.PRODUTO_SEM_CADASTRO`; casamento por EAN; idempotência de chave de NF-e duplicada; ASN pré-chegada sem invoice; Ordem manual; Ordem manual com produto inexistente rejeitada; cancelamento CREATED + rejeição de cancelamento duplo.
- `apps/backend/src/modules/recebimento/shared/nfe-xml.util.ts` ganhou `raw_ncm` (extração de `<NCM>`, necessária para o casamento por NCM+descrição de RN-REC-012 — o parser anterior não extraía esse campo).

### Bugs REAIS encontrados e corrigidos nesta retomada (nenhum era hipotético — todos travavam um teste real)

1. **`partition-manager.integration.spec.ts`** tinha `MANAGED_TABLES = ['stock_movement', 'audit_log']` hardcoded, desatualizada desde que `putaway_task` entrou em `PARTITIONED_TABLES` do worker real. `missingPartitionAlerts` tinha 3 itens, o teste esperava 2. Corrigido incluindo `putaway_task` na lista do teste.
2. **`infra/docker-compose.test.yml`** — `mc config host add` está descontinuado nas imagens recentes de `minio/mc` ("config is not a recognized command"); o `; exit 0` do script mascarava a falha (container saía com exit=0 mesmo sem criar o bucket `wms-test`). Só foi descoberto quando o 1º upload real via `FileStorageService` falhou com `NoSuchBucket` — a tarefa da Sessão 4A original nunca chegou a exercitar esse caminho. Corrigido: `mc alias set` (comando atual) + removido o `exit 0` mascarador.
3. **`docker compose up -d --wait`** sobre TODOS os serviços do compose de teste falha de forma **determinística** (não apenas ocasional) sempre que os demais containers já existem: o job one-shot `minio-test-init` roda e sai (`exit 0`) rápido demais para o watcher de eventos do `--wait` observar um estado "running"/"healthy" antes do "exited". Só não falhou na 1ª execução desta sessão porque os containers ainda estavam sendo criados (mascarando a corrida). Corrigido: `apps/backend/package.json` → `pretest:integration` agora faz `up -d --wait` só nos 3 serviços de vida longa (`postgres-test redis-test minio-test`) e roda o init via `docker compose run --rm minio-test-init` (bloqueia até o fim, devolve exit code real). Verificado determinístico em 3 execuções consecutivas.
4. **`nfe-xml.util.ts`** — o `XMLParser` do `fast-xml-parser` estava sem `parseTagValue: false`, então campos textuais-mas-numéricos (CNPJ, SKU, EAN, NCM, chave de acesso) eram convertidos para `Number` internamente ANTES do `.toString()` do código, derrubando silenciosamente zeros à esquerda (ex.: CNPJ `"03817125008262"` virava `3817125008262`, 13 dígitos). Bug de CORRETUDE real em dado fiscal, nunca detectado porque o parser nunca tinha sido exercitado contra um XML antes desta retomada. Corrigido com `parseTagValue: false` (todos os campos numéricos já são convertidos explicitamente no código, então desligar o parsing automático é seguro).

### CheckingService (2ª parte desta retomada, RF-REC-020/021/024 + RN-REC-022/023 [INVIOLÁVEL])

- **`apps/backend/src/modules/recebimento/checking/checking.service.ts`** (NOVO) + `.controller.ts` (NOVO), wired em `recebimento.module.ts`. Métodos: `startUnloading` (AT_DOCK→UNLOADING), `startChecking` (UNLOADING→CHECKING, cria sessão `checking`, libera itens PENDING→CHECKING_PENDING, conclui etapa de Fluxo "DESCARGA"), `countFirstRound`/`recount` (RN-REC-022, mecânica de rounds com "conferente diferente" — ver abaixo), `registerAvaria` (foto obrigatória via CHECK do banco), `registerTroca` (par FALTA+SOBRA vinculado), `decideDiscrepancy` (aplica a tabela de efeitos de RN-REC-023 sobre `inbound_order_item`, chamando o motor genérico `OperationalExceptionService.decide()` do DOC-12 por baixo — MESMO padrão de 2 chamadas já usado por `GateInService.resumeAfterExceptionDecision`, não existe hook automático de "decisão → efeito" neste codebase), `closeChecking` (RF-REC-024).
- **Migration 0037 alterada** (ainda sem commit, então seguro revisar): `checking_item.round` deixou de ser `CHECK (round IN (1,2))` para `CHECK (round >= 1)` — RN-REC-023 ("Item volta para recontagem" quando uma decisão de FALTA/AVARIA/TROCA é REJEITADA) precisa reabrir uma NOVA rodada além da recontagem original, e travar em 2 tornava isso impossível. Também ganhou a coluna `forced_same_conferente BOOLEAN` — a "marcação" literal exigida por RN-REC-022 quando não há outro conferente elegível disponível e a recontagem precisa aceitar o mesmo.
- **Simplificações conscientes, documentadas no próprio código**:
  - Efeitos de RN-REC-023 aplicados só a `inbound_order_item` (qty_received/status) — **nenhum crédito de `stock_balance`** (DOC-05, fora de escopo desta sessão, RF-REC-042/motor de putaway é 4B).
  - Carta de divergência em PDF e notificação formal ao cliente: `[LACUNA: DOC-08/DOC-11 não implementados]` — só o evento `recebimento.divergencia_registrada` existe como sinal.
  - TROCA: `[LACUNA]` só cobre o caso em que ambos os lados (faltante/excedente) já existem como `inbound_order_item` da mesma Ordem — não cobre um produto excedente que não estava listado na NF-e/ASN original.
  - SOBRA/AVARIA aprovadas exigem um `destination` explícito no `decideDiscrepancy()` (a tabela do DOC-04 dá DUAS opções nesses casos — "decisão do aprovador" — não escolhido automaticamente).
- **7 testes novos** em `apps/backend/src/modules/recebimento/__tests__/checking.integration.spec.ts`, cobrindo os 4 cenários Gherkin do §6 em escopo desta sessão ("Conferência cega com divergência de falta", "Falta aprovada ajusta a ordem", "Sobra recebida como bloqueada", "Avaria exige foto") + item sem divergência + RF-REC-024 (fecha/rejeita fechamento) + `forced_same_conferente` com conferente único.
- **Bug REAL adicional encontrado e corrigido**: `discrepancy_avaria_requires_photo` (migration 0038) usava `array_length(photo_keys, 1) >= 1` — para array VAZIO (não NULL), `array_length` retorna `NULL`, e `NULL >= 1` é `NULL`; um CHECK constraint só reprova quando o resultado é `FALSE` (NULL passa), então a exigência de foto NUNCA era de fato aplicada para `photo_keys = '{}'`. Só descoberto ao testar `registerAvaria()` sem foto pela 1ª vez — o teste esperava rejeição e a chamada teve sucesso. Corrigido com `cardinality(photo_keys) >= 1` (retorna 0 para array vazio, não NULL).
- Regressão completa verificada 2x consecutivas depois deste trabalho: **46/46 arquivos, 110/110 testes**.

### LabelingService (3ª parte desta retomada, RF-REC-030 + RN-REC-031)

- **`apps/backend/src/modules/recebimento/labeling/labeling.service.ts`** (NOVO) + `.controller.ts` (NOVO), wired em `recebimento.module.ts`. Métodos: `startLabeling` (CHECKED→LABELING), `formPallet` (RF-REC-030: forma palete via `PalletService`/`LpnService` reaproveitados de DOC-02, valida palete misto via `REC.PERMITE_PALETE_MISTO`, valida quantidade contra "restante a paletizar" por item, cria/casa `wms.batch` e aplica RN-REC-031), `releaseQuarantine` (RN-REC-031, `REC.LIBERAR_QUARENTENA`), `getLabelingProgress` (helper de UI/teste).
- **Migration 0042 (NOVA)**: `ALTER TABLE wms.pallet ADD COLUMN inbound_order_id` + `ALTER TABLE wms.pallet_content ADD COLUMN inbound_order_item_id` — `wms.pallet`/`wms.pallet_content` (migration 0012, Sessão 2B, **JÁ COMMITADA**) não tinham NENHUM vínculo com `inbound_order`, impossibilitando rastrear "quantidade restante a paletizar" por item (RF-REC-020 §5.1). Por serem tabelas de uma sessão já commitada, o vínculo foi adicionado via `ALTER TABLE` numa migration nova, não editando a 0012.
- **`PalletService.create()` corrigido** (débito documentado desde a Sessão 3): `actor_user_id` saiu do DTO `CreatePalletInput` e virou parâmetro separado (`create(input, actorUserId)`) — o ator vem do principal autenticado, nunca do corpo enviado pelo cliente. `LabelingService` é o 1º chamador real; `lpn-generation.integration.spec.ts` (Sessão 2B, já commitado) atualizado para a nova assinatura.
- **`[DÉBITO: Sessão 4B]` explícito no código**: RN-REC-031 pede que a liberação de quarentena "gere tarefas de transferência" — depende do motor de putaway, fora de escopo. `§5.1 LABELING -> PUTAWAY_IN_PROGRESS` depende de "tarefas geradas" (idem) — por isso `inbound_order.status` **não é** transicionado para `PUTAWAY_IN_PROGRESS` por este service; a Ordem fica em `LABELING` até a Sessão 4B poder gerar as tarefas de fato.
- **5 testes novos** em `apps/backend/src/modules/recebimento/__tests__/labeling.integration.spec.ts`: palete simples com LPN+progresso, quantidade excedente rejeitada, palete misto (permitido por padrão / rejeitado com `REC.PERMITE_PALETE_MISTO=false`), RN-REC-031 completo (nasce QUARANTINE, libera para RELEASED, dupla liberação rejeitada), Ordem/item fora do estado exigido rejeitados.

### 3 bugs REAIS adicionais encontrados e corrigidos nesta 3ª parte (nenhum hipotético)

5. **`LpnService`/`DEFAULT_GS1_PREFIX` — colisão de LPN entre armazéns sem prefixo GS1 próprio** `[DÉBITO: DOC-02, sessão futura]`. Todo armazém SEM `GS1_PREFIX` configurado em `app_parameter` usa o mesmo prefixo padrão `'2900000'` — o "1º palete" de QUALQUER armazém nessa situação gera SEMPRE o mesmo LPN (prefixo + sequencial=1), violando `pallet_lpn_unique` (UNIQUE GLOBAL) assim que dois armazéns sem prefixo próprio criam paletes na mesma suíte de testes. Nunca detectado antes porque `lpn-generation.integration.spec.ts` (Sessão 2B) era o ÚNICO consumidor de `PalletService` até `LabelingService` (1º consumidor real com múltiplos armazéns/paletes). **Não corrigido em `LpnService`** (fora do escopo desta sessão, é DOC-02) — contornado no fixture de `labeling.integration.spec.ts` configurando um `GS1_PREFIX` próprio para o armazém de teste, exatamente como uma implantação real deveria operar (prefixo GS1 dedicado por armazém, não um fallback compartilhado). **Risco real de produção**: dois armazéns reais sem GS1_PREFIX configurado gerariam LPNs colidentes.
6. **`BatchService.update()` (Sessão 2B, já commitado) sempre passava `warehouseId: null` para `auditService.record()`** — DOC-12 RD-SEG-030 `[INVIOLÁVEL]` exige `audit_log.warehouse_id` NOT NULL para toda ação exceto LOGIN/LOGOUT (migration 0019). Qualquer chamada real a `PATCH /cadastro/batches/:id` (endpoint HTTP já existia, `batch.controller.ts`) ou a `BatchService.update()` internamente SEMPRE falhava com `CONSTRAINT_VIOLATION` — nunca detectado porque nenhum teste até agora exercitava esse método com um audit write de verdade. Corrigido: `update()` ganhou parâmetro `warehouseId` obrigatório; `BatchController.update()` ganhou `@Query('warehouse_id')`; `LabelingService.releaseQuarantine`/`formPallet` (RN-REC-031) são os 1os chamadores reais.
7. **`LabelingService` (meu próprio código, corrigido antes de qualquer commit)**: a consulta de espécie do produto (`SELECT ... FROM wms.product p JOIN wms.product_species ps ...`) usava `db.queryGlobal()` em vez de `db.query({tenant_id,...})` — `wms.product` tem RLS (TENANT, `FORCE ROW LEVEL SECURITY`), então sem `app.tenant_ids` setado a policy nega TODAS as linhas silenciosamente (sem erro, só 0 linhas) e a quarentena de RN-REC-031 nunca era aplicada (lote sempre nascia RELEASED). Encontrado pelo próprio teste novo (`RN-REC-031: lote de espécie... nasce QUARANTINE` falhava com `RELEASED`).

### CrossDockService + REC.RECUSA_TOTAL (4ª e última parte desta retomada — fecha o escopo de negócio da sessão)

- **`apps/backend/src/modules/recebimento/crossdock/crossdock.service.ts`** (NOVO) + `.controller.ts` (NOVO) + **worker** `apps/backend/src/workers/crossdock-aging.worker.impl.ts` (NOVO, registrado em `main.ts` no role `scheduler`, eleição de líder via Redis, mesmo padrão de `NoShowWorkerImpl`). Métodos: `linkToOutboundOrder` (RN-REC-050, só ANTES da conferência, soma de vínculos ≤ qty_expected), `formCrossDockPallet` (RF-REC-051, paletiza via `PalletService`, move para location de zona `CROSS_DOCKING`, marca vínculos `CONSUMED`), `cancelLink` (RESERVED/CONSUMED → CANCELLED), `checkAging` (RNF-REC-052, chamado pelo worker).
- **2 novos eventos cunhados fora do catálogo de 11 do §4.7** (mesmo precedente já usado em `portaria.vaga_indisponivel`, DOC-03 — citando a fonte EXATA, não o catálogo): `recebimento.crossdock_tempo_excedido` (RNF-REC-052) e `recebimento.recusa_total_aplicada` (RN-REC-023). Mapeados em `packages/contracts/src/realtime-topics.ts`.
- **`REC.RECUSA_TOTAL` implementado em `InboundOrderService`** (`requestTotalRefusal` + `applyTotalRefusalDecision`) — **gap real encontrado ao revisar o DoD contra `docs/PROMPT-SESSAO-4A-doc04-recebimento.md` item 6**: a sessão original menciona explicitamente "REC.RECUSA_TOTAL com 2 aprovadores" e o diagrama §5.1 tem `AT_DOCK/UNLOADING -> REFUSED`, mas isso não tinha sido implementado até este ponto. Segue o padrão de 2 chamadas já usado por `GateInService.resumeAfterExceptionDecision` (decide pelo motor genérico do DOC-12, depois um "resume" aplica o efeito). Testado com 2 aprovadores distintos (RN-SEG-043) em `inbound-order.integration.spec.ts`.
- **`[DÉBITO]`** "a visita segue para gate-out" (RN-REC-023, efeito da recusa total sobre `vehicle_visit` do DOC-03) não é acionado automaticamente — mesma fronteira entre módulos já respeitada em todo o resto da sessão (nenhum service de `recebimento/` importa services de `portaria/` via DI).
- **8 testes novos** em `crossdock.integration.spec.ts` (cross-docking pula o picking, elegibilidade antes/depois da conferência, limite de quantidade, cancelamento, alerta RNF-REC-052) + 1 teste novo em `inbound-order.integration.spec.ts` (RN-REC-023 completo, 2 aprovadores).

### 2 bugs REAIS adicionais encontrados durante os testes de CrossDockService

8. **`wms.location.location_type` usa `'CROSS_DOCK'`, não `'CROSS_DOCKING'`** (`wms.zone.zone_type` usa `'CROSS_DOCKING'`) — nomenclatura DIFERENTE entre as duas tabelas para o mesmo conceito (DOC-02, migration 0008, já commitada). Não é bug de código, é uma armadilha de nomenclatura real do schema — documentado aqui para a próxima sessão não cair na mesma pegadinha.
9. **Meu próprio teste** usou `queryGlobal()` para atualizar `wms.crossdock_link.updated_at` (simulando permanência antiga para RNF-REC-052) — mesma classe de erro do achado #7 (`queryGlobal()` em tabela com RLS não vê/não afeta nenhuma linha, silenciosamente). Corrigido antes de qualquer commit.

### DoD final — `docker compose up -d --build` (dev) revelou mais 1 bug REAL

10. **`MigrationRunner` (RNF-ARQ-090, código committed desde a Sessão 1) sem nenhuma serialização entre instâncias concorrentes.** `docker-compose.yml` de dev sobe `backend-api`/`backend-worker`/`backend-scheduler` ao mesmo tempo — as 3 chamam `runPending()` contra o MESMO Postgres simultaneamente. `getAppliedVersions()` é lido por todas ANTES de qualquer uma commitar, então todas viram a mesma migration como pendente e tentam rodá-la em paralelo. A migration 39 (bootstrap de partição de `wms.putaway_task`, `IF NOT EXISTS (...) THEN CREATE TABLE ... PARTITION OF`) não é atômica entre transações concorrentes — 2 dos 3 containers (`backend-api`, `backend-scheduler`) quebraram com `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` na 1ª tentativa real de `docker compose up -d --build` desta sessão. Nunca detectado antes porque as migrations 1-32 (sessões anteriores) provavelmente já estavam aplicadas incrementalmente quando os 3 containers foram testados juntos pela 1ª vez — esta sessão é a primeira com um lote GRANDE (10 migrations, 33-42) genuinamente pendente nas 3 instâncias ao mesmo tempo. **Corrigido**: `apps/backend/src/core/database/migration.runner.ts` agora adquire um `pg_advisory_lock` de sessão em volta de toda `runPending()` — instâncias concorrentes bloqueiam até a 1ª terminar, releem `schema_migration` (já tudo aplicado) e não fazem nada. Verificado: `docker compose up -d --build` + `restart` de novo (2 ciclos) → todos os 3 containers `healthy`; `curl localhost:3000/health/ready` → `200 {"status":"ok",...}`. Regressão completa (unit+integration) re-verificada 2x consecutivas depois desta mudança, sem quebra.

**Observação à parte, NÃO relacionada a este achado**: `wms-frontend` também falhou ao subir (`ERR_PNPM_NO_SCRIPT_OR_SERVER — Missing script start or file server.js`) — problema de empacotamento do frontend, pré-existente, nada tocado nesta sessão (DOC-04 é só backend). Fora do escopo do DoD desta sessão (que exige `pnpm build && pnpm test && pnpm test:integration` do BACKEND + `curl health/ready`, ambos satisfeitos), mas registrado aqui para não ser perdido.

### Observação registrada, NÃO corrigida (fora do escopo desta retomada)

- `DockService.dockVehicle()` atualiza `wms.vehicle_visit.status = 'EM_DOCA'` via SQL cru, em vez de `VehicleVisitService.transitionWithClient(client, visit.id, visit.status, 'ATRACACAO_REGISTRADA', ...)` — a transição `ATRACACAO_REGISTRADA` já existe em `vehicle-visit-state-machine.util.ts` (comentário no próprio arquivo diz "DOC-04, fora de escopo desta sessão — transição exposta, sem chamador ainda", escrito na Sessão 4/DOC-03). Usar SQL cru pula a validação de que a visita estava em `EM_DESLOCAMENTO_DOCA` antes de atracar. Não corrigido agora porque `dock.service.ts` não fazia parte do escopo desta retomada (era código já escrito da sessão anterior) e não há teste cobrindo esse caminho ainda — sinalizado aqui para quando `DockService` ganhar testes de integração.

---

## 4. Decisões de modelagem tomadas nesta sessão (NÃO redderivar diferente — já documentadas nos comentários dos arquivos, resumidas aqui)

1. **Sem papel `QUALIDADE` novo.** DOC-04 §3 diz "papel com REC.LIBERAR_QUARENTENA", não nomeia um papel semente específico. Os 13 papéis semente são fixos desde a Sessão 3/DOC-12 (RF-SEG-013). `REC.LIBERAR_QUARENTENA` e `REC.CANCELAR_RECEBIMENTO` (ambas sensíveis) concedidas a `GESTOR_ARMAZEM`, mesmo padrão já usado para `POR.DADO_PESSOAL_COMPLETO`.
2. **`REC.CONFERIR` concedida também a `CLIENTE_OPERACAO`** (não só `CONFERENTE`) — RF-REC-010(c) cita `REC.CONFERIR` como a permissão para digitação manual; sem código separado para upload de XML/ERP, a mesma permissão cobre a criação da Ordem independente da origem.
3. **`REC.MAPA_DISTANCIA_DOCA_ZONA` é tabela própria** (`wms.dock_zone_distance`, GLOBAL), não `app_parameter` — matriz não cabe em scope/name/value escalar (mesma decisão já tomada para `POR.JANELA_CAPACIDADE` na Sessão 4).
4. **`REC.CRITERIOS_PUTAWAY` deliberadamente NÃO semeado** — pertence ao motor de putaway (4B); nada nesta sessão o lê.
5. **`operation_flow`/`flow_step` são um núcleo GENÉRICO** em `core/operation-flow/`, não específico de recebimento — DOC-00 §4.5 trata esses termos como canônicos cross-módulo. Reaproveitável por DOC-06/07 quando existirem.
6. **`dock.status` FREE→RESERVED já é feito pelo DOC-03** (`DockCallService.confirmCall`, Sessão 4) — `DockService` desta sessão só cobre RESERVED→OCCUPIED (atracação) e OCCUPIED→FREE (liberação). "Doca não reservada para a visita" é checado via `vehicle_visit.dock_id` (setado pela chamada do DOC-03), não um registro de reserva separado.
7. **Divergência de lacre na atracação (RF-REC-002) reaproveita `POR.DIVERGENCIA_LACRE`** (exception_type já existente do DOC-03, criado para o gate-OUT) — não um novo tipo REC.*. Comparação contra `vehicle_visit.seals_in`.
8. **`inbound_order_item.product_id` é NULLABLE** com `raw_sku`/`raw_description`/`raw_ean` — suporta RN-REC-012 (item SEM_CADASTRO, sem produto correspondente ainda).
9. **`putaway_task` só tem ESTRUTURA** — nada insere linhas nesta sessão (motor é 4B, FORA DE ESCOPO explícito). **`crossdock_link.outbound_order_reference` é TEXT livre, sem FK** — `outbound_order` (DOC-06) não existe.
10. **Parser de XML de NF-e usa `fast-xml-parser`** (nova dependência), não regex — NF-e tem múltiplos `<det>`/`<rastro>` aninhados. **`parseTagValue: false` é obrigatório** (ver §3-BIS item 4 — sem isso, campos numéricos-mas-textuais perdem zeros à esquerda).
11. **Fotos de AVARIA usam MinIO real** (`FileStorageService`, nova dependência `minio`) — primeiro client S3 real do backend, sem mock. **Confirmado funcionando** nesta retomada (upload real de XML de NF-e, não just fotos de avaria — mesmo client, `entity` diferente).
12. **`inbound_invoice` só é registrada quando a Ordem casa com um `vehicle_visit` de gate-in JÁ CONFIRMADO** (RN-REC-011/RG-014 passo 1 — "a mercadoria chegar", não "o XML foi enviado"). Ver `[DÉBITO: Sessão 4B+]` em §3-BIS sobre o vínculo tardio de ASN pré-chegada.
13. **Casamento de item por NCM+descrição (RN-REC-012) é exato, não fuzzy** — `[LACUNA]`, DOC-04 não define critério de similaridade textual.

---

## 5. O que NÃO foi começado (atualizado 2026-08-17, depois de CrossDock — TODOS os services de negócio do escopo estão feitos)

- **Testes de integração do `DockService`** — o service e o controller existem, mas nenhum teste real ainda cobre `dockVehicle()`/`releaseDock()`/`suggestDock()`. Ver observação sobre `ATRACACAO_REGISTRADA` em §3-BIS antes de escrever esses testes (decidir se corrige o service para usar a máquina de estados ou documenta a divergência como débito consciente). **Não bloqueia o DoD** (RN-REC-001/RF-REC-002/003 não estão entre os cenários Gherkin do §6), mas é uma lacuna de cobertura real digna de nota no relatório final.
- **9 testes de integração do §6 do DOC-04** (7 no escopo desta sessão — 2 são só de putaway e ficam de fora). **Todos os 7 agora têm cobertura equivalente**: falta/falta-aprovada/sobra-bloqueada/avaria-foto (`checking.integration.spec.ts`), cross-docking pula o picking/cancelamento desfaz (`crossdock.integration.spec.ts`), medicamento em quarentena (`labeling.integration.spec.ts` — nasce QUARANTINE → libera RELEASED; a asserção do MOTOR de putaway do cenário original, fora de escopo, não foi replicada literalmente, já que RN-REC-040 é 4B).
- **`[DÉBITO: Sessão 4B+]`** vínculo tardio de Ordem pré-chegada (ASN antes do gate-in) a um `vehicle_visit`, com registro consequente de `inbound_invoice`/RG-014 — ver §3-BIS.
- **`[DÉBITO: DOC-02, sessão futura]`** `LpnService`/`DEFAULT_GS1_PREFIX` — risco real de colisão de LPN entre armazéns sem `GS1_PREFIX` próprio configurado — ver §3-BIS "bugs REAIS adicionais", item 5.
- **`[DÉBITO]`** RN-REC-023 "a visita segue para gate-out" (efeito de REC.RECUSA_TOTAL sobre `vehicle_visit`, DOC-03) não é acionado automaticamente — ver §3-BIS.
- Regressão completa sem filtro — **rodada com sucesso 2x consecutivas depois de TODOS os services** (48/48 arquivos, 121/121 testes) + unit tests (8/8, 44/44).
- **Falta apenas**: `docker compose up -d --build` (dev, verificar não-interferência com a infra de teste isolada) + `curl localhost:3000/health/ready` + `docs/relatorios/SESSAO-4A-relatorio.md` (matriz requisito→arquivo→teste) + commit/push (aguardando confirmação explícita do usuário antes de qualquer `git commit`/`push`, por instrução permanente de sessão).

---

## 6. Como retomar (se a sessão for interrompida antes do DoD final)

1. Ler este documento inteiro (feito, se você chegou até aqui — a §3-BIS é a parte que importa se você já leu uma versão anterior deste arquivo).
2. Confirmar infra de teste de pé: `docker compose -f infra/docker-compose.test.yml up -d --wait postgres-test redis-test minio-test && docker compose -f infra/docker-compose.test.yml run --rm minio-test-init` (NÃO use `--wait` sem a lista de serviços — ver bug #3 em §3-BIS; `pnpm test:integration` já faz isso sozinho via `pretest:integration`, esse comando manual é só para inspecionar o estado sem rodar os testes).
3. Confirmar que `.env.test` existe localmente (gitignorado — se não existir, copiar de `.env.test.example`).
4. `pnpm --filter @wms/backend build` — deve compilar limpo.
5. `cd apps/backend && pnpm test:integration` — deve passar 48/48 arquivos, 121/121 testes (verificado 2x consecutivas); `pnpm test` (unit) deve passar 8/8, 44/44.
6. Todos os services de negócio (Dock/InboundOrder/Checking/Labeling/CrossDock) estão implementados e testados — o que falta é só o DoD final: `docker compose up -d --build` (dev), `curl localhost:3000/health/ready`, `docs/relatorios/SESSAO-4A-relatorio.md`, e commit/push (com confirmação do usuário).
