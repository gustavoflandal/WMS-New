# Relatório — Sessão 7A: DOC-10 Backend (KPIs, Alertas e Chat)

**Data**: 2026-08-22/23
**Escopo**: worker de materialização de KPIs (RN-PAI-042), os 17 KPIs (RN-PAI-041), endpoints de dashboard (RF-PAI-040/043), centro de alertas (RF-PAI-010), chat operacional (RF-PAI-030/RN-PAI-031). Frontend é a 7B.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-10-paineis-dashboards-tempo-real.md`, `docs/relatorios/SESSAO-7-relatorio.md` (checkpoint herdado).

---

## 1. Resumo executivo

Os 5 entregáveis do backend do DOC-10 foram implementados e verificados por execução real. `pnpm build` limpo; **unit 180/180 testes** (+7 desde o checkpoint: limites de fuso horário do snapshot); **integração 264/264 testes** (+18 desde o checkpoint: materialização de KPI, dashboard, alertas, chat), em **2 execuções consecutivas idênticas**. `docker compose up -d --build` — os 3 papéis de backend (`api`/`worker`/`scheduler`) saudáveis, com os 4 novos workers (`kpi-materialization`, `alert-materialization`, `kpi-snapshot`, mais o `realtime-fanout` já corrigido no checkpoint) confirmados na saída real dos logs, não por inferência.

**Decisão estrutural central**: a mesma função de cômputo (`KpiComputationService.compute()`, uma SQL por KPI contra as FONTES) é chamada tanto pelo caminho incremental (evento → recomputa o dia) quanto pelo comando de recontagem — a determinística exigida por RN-PAI-042 é uma consequência trivial de usar o mesmo código nos dois caminhos, não algo verificado à parte.

---

## 2. Achados reais desta sessão (por execução, não por inspeção)

### 2.1 `vehicle_visit.dock_at` — mesmo padrão do `flow_step.started_at` do checkpoint

A coluna existe desde a migration 0028 com o comentário "timestamps de marco para KPIs de permanência (DOC-10)", mas nenhum serviço a escrevia. Populada em `DockService.dockVehicle()` (RF-REC-002, atracação) — necessária para K-03 (dock-to-stock). "Liberação da doca" (a outra metade de K-02) **não tem sinal persistido em nenhum DOC implementado**: `DockService.releaseDock()` existe mas nunca é chamado por nenhum fluxo real (achado, não introduzido por esta sessão). K-02 fica `[LACUNA]` explícita — `KpiComputationService.compute('K-02', ...)` retorna `null` (não uma fórmula adaptada), documentado em `UNCOMPUTABLE_KPIS`.

### 2.2 Rede de segurança de RLS (`CLAUDE.md`, corrigida na sessão anterior) pegou um bug NOVO, na própria migration desta sessão

As 5 tabelas de `kpi_daily`/`alert`/`alert_read`/`chat_room`/`chat_message` (migration 0055, escritas no checkpoint) repetiam o EXATO padrão de bug que motivou o `CLAUDE.md`: a policy exigia `app.tenant_ids` mesmo para linhas `client_id`/`tenant_id` NULL (que são, por desenho da própria 0055, as linhas "sem dimensão de cliente"). Corrigido na origem — migration `0056** — não nos chamadores, mesma disciplina. Sem essa correção, `KpiSnapshotService`, `AlertService.list()` para alertas sem cliente, e a sala armazém-turno do chat estariam todos mascarados por RLS silenciosa.

### 2.3 GRANT a `wms_worker` — 6ª, 7ª e 8ª ocorrência do mesmo achado recorrente

`KpiComputationService`/`KpiMaterializationService`/`AlertService`/`ChatService` rodam via `transactionAsWorker` (cross-cliente por natureza — a materialização de KPI soma pedidos de TODOS os clientes de um armazém numa passada; o mesmo vale para alertas e a sala armazém-turno do chat). `wms_worker` nunca havia lido `warehouse`, `putaway_task`, `discrepancy`, `loading`, `loading_order`, `inventory_count`, `picking_task`, `inbound_order_item`, `alert_read`, `chat_room`, `chat_message` — GRANT explícito em 4 migrations (0057/0058/0059), cada uma achada por um teste de integração falhando com `permission denied`, nunca por `tsc`. `putaway_task`/`picking_task` são particionadas — GRANT retroativo às partições já existentes, mesmo padrão da migration 0046.

### 2.4 Bug de rota: `@Query('group')` em vez de `@Param('group')`

`DashboardController` declarava a rota como `@Get(':group')` mas lia o valor via `@Query('group')` — o parâmetro nunca seria populado por uma chamada HTTP real (o valor chega no segmento da URL, não na query string). Encontrado por revisão manual do controller (não por teste automatizado — este projeto testa services diretamente, não via HTTP; ver §6 "Lacunas"). Corrigido para `@Param('group')` nos dois handlers (`getGroup`, `exportCsv`).

### 2.5 Achado transversal, fora do escopo do DOC-10: teste de portaria flakey perto da meia-noite local

Ao rodar a suíte completa uma 3ª vez (verificação extra após o fix de §2.4), `inbound-order.integration.spec.ts` falhou uma única vez com `CONSTRAINT_VIOLATION appointment_window_config_time_check` — root-caused (não descartado como "flaky de sempre", ver `[[wms-no-accepting-flaky-as-preexisting]]`): `windowCoveringNow()` (helper de teste do DOC-03/04, não tocado por esta sessão) monta uma janela `[agora−60min, agora+60min]` só com HH:MM:SS, sem carregar a data — perto da meia-noite local, `end_time` vira menor que `start_time` textualmente, violando a constraint real do banco. Registrado como achado (`wms-midnight-flaky-window-config-test`), não corrigido (fora do escopo do DOC-10). As 2 execuções OFICIAIS do DoD (§7) foram capturadas ANTES desta 3ª rodada incidental e estão 264/264 limpas nas duas.

---

## 3. Matriz requisito → arquivo → teste

| Requisito | Arquivo(s) principais | Teste(s) |
|---|---|---|
| **RN-PAI-042 [INVIOLÁVEL]** idempotência por event_id | `kpi/kpi-materialization.service.ts` (`applyEvent`), `kpi/kpi-materialization.worker.impl.ts` (consumer group próprio nos streams `events:*`) | `kpi-materialization.integration.spec.ts`: reprocessar o mesmo event_id não duplica nem altera `kpi_daily` |
| **RN-PAI-042** recontagem determinística | `kpi/kpi-materialization.service.ts` (`recomputeDay`, MESMA função de `compute()`) | idem: 2 chamadas de `recomputeDay` produzem valor idêntico |
| **RN-PAI-042** snapshot 23:59 fuso do armazém (K-13/K-16, + K-14 nesta sessão) | `kpi/kpi-snapshot.service.ts`, `kpi/kpi-snapshot-boundary.util.ts` (função pura `isPastLocalSnapshotTime`), `kpi/kpi-snapshot.worker.impl.ts` | `kpi-snapshot-boundary.util.spec.ts` (7 unit, América/São Paulo UTC-3 vs UTC provando que a checagem depende do fuso) + `kpi-materialization.integration.spec.ts` (K-13 real) |
| **RN-PAI-041 [INVIOLÁVEL]** os 17 KPIs, fórmulas exatas | `kpi/kpi-computation.service.ts` (K-01..K-17; K-02 `[LACUNA]` explícita) | **Exemplo normativo K-06 OTIF permanece**: 40/32/30 → 75,0% (`kpi-materialization.integration.spec.ts`) |
| Aritmética decimal dos KPIs percentuais | `kpi/kpi-formula.util.ts` (função pura, herdada do checkpoint) | `kpi-formula.util.spec.ts` (12 unit) |
| **RF-PAI-040** dashboard só `kpi_daily` | `dashboard/dashboard.service.ts`, `dashboard/dashboard-groups.util.ts` | `dashboard.integration.spec.ts`: prova por inspeção do código-fonte (regex sobre `FROM`/`JOIN`) que nenhuma tabela além de `kpi_daily`/`client` é referenciada |
| **RF-PAI-043** cartão + comparativo 7 dias + tendência + série + ranking | idem | idem: tendência UP com dado real, série cobre o período, ranking top-5 clientes por K-05 |
| **RN-SEG-032** exportação CSV auditada | `dashboard/dashboard.service.ts` (`exportGroupCsv`) | idem: `audit_log` recebe entrada `action='EXPORT'` |
| **RF-PAI-010** consolidação de alertas | `alertas/alert.service.ts`, `alertas/alert-materialization.service.ts` + worker (consumer group próprio) | `alert.integration.spec.ts`: exceção→alerta, dedup por origem, RN-SEG-011 |
| **§5.2** resolução automática | `alert-materialization.service.ts` (`resolveByOrigin`, chamado por `seguranca.excecao_aprovada/rejeitada` e por `estoque.lote_vencido_bloqueado` sobre o `LOTE_A_VENCER` anterior) | idem: aprovação resolve; lote vencido resolve o "a vencer" e abre um CRIT novo |
| **RF-PAI-010** marcação de lido / badge | `alert.service.ts` (`markRead`, `countUnread`) | idem: badge decresce após marcar lido |
| **RF-PAI-030** salas (armazém-turno + operação) | `chat/chat.service.ts` | `chat.integration.spec.ts`: sala armazém-turno idempotente (1 por armazém); sala de operação herda `tenant_id`, isolada por RLS, idempotente |
| **RF-PAI-030** mensagem ≤2.000 chars, imutável | idem | idem: rejeita >2.000; `UPDATE` direto falha (RLS/REVOKE do checkpoint) |
| **RN-PAI-031 [INVIOLÁVEL]** chat não aciona operação | `chat/chat.service.ts`, `chat/chat.controller.ts` (só `DatabaseService`/`EventsService` injetados) | idem: prova estrutural — nenhuma linha `import` dos dois arquivos referencia `OperationFlowService`/`StockMovementService`/`OperationalExceptionService`/etc. |

**Totais desta sessão**: unit **+7 testes** (180 no total); integração **+18 testes** (264 no total).

---

## 4. Lacunas e débitos

**Em aberto:**

- **`[LACUNA]` K-02** (tempo de doca) — "liberação da doca" não tem timestamp em nenhum DOC implementado; `DockService.releaseDock()` é código morto (nunca chamado). `compute('K-02', ...)` retorna `null` explicitamente.
- **`[LACUNA]` alertas EDGE_AGENT_OFFLINE, TRANSBORDO_PENDENTE, FALHA_INTEGRACAO** — catálogo pronto (CHECK constraint de `wms.alert.alert_type`, migration 0055) e `AlertService.create()` aceita qualquer um dos 9 tipos, mas nenhum materializador os dispara: DOC-11 (Edge Agent) e DOC-13 (integrações) são stubs vazios nesta base, e "transbordo de armazém lógico pendente de retorno" não tem estado modelado em nenhum DOC implementado.
- **`[DÉBITO]` ESTOQUE_SEGURANCA_VIOLADO nunca resolve automaticamente** — `ReplenishmentAlertWorkerImpl` só detecta violação, nenhum evento "restaurado" existe nesta base. Alerta fica `EMITIDO` até resolução manual (endpoint genérico, se existisse — hoje não há rota de resolve manual exposta, só a automática por evento) ou até a sessão que adicionar esse evento.
- **`[LACUNA]` ranking "etapas por atraso"** (RF-PAI-043, 2º ranking do texto normativo) — exigiria K-14 quebrado por `step_code`, mas `kpi_daily` (grão dia×armazém×cliente×kpi) não guarda essa dimensão. Só "clientes por volume" (K-05) foi implementado. Mudar exigiria alterar RD-PAI-001.
- **`[LACUNA]` grupo do dashboard por KPI** — DOC-10 nomeia os 4 grupos e a "Origem" de cada KPI, mas não os associa 1:1. Mapeamento desta sessão (`dashboard-groups.util.ts`) segue a Origem onde ela aponta claramente; K-14 (origem DOC-10) e K-15 (origem DOC-06) exigiram uma escolha sem texto normativo direto — documentada no próprio arquivo.
- **`[DÉBITO]` sem teste de cliente WebSocket real ponta a ponta** — herdado do checkpoint; a correção do pipeline (lá) e o `paineis.chat_mensagem` com tópico dinâmico (aqui) seguem verificados por inspeção de código + regressão dos testes que assinam Redis diretamente, não por um cliente Socket.IO de teste.
- **`[DÉBITO, achado, fora de escopo]` `windowCoveringNow()` flakey perto da meia-noite local** — ver §2.5 e `wms-midnight-flaky-window-config-test` (memória). Não é DOC-10; sessão-alvo é quem tocar `recebimento/__tests__/inbound-order.integration.spec.ts` ou os helpers de portaria em seguida.

**Fechados nesta sessão**: os 4 achados de §2.1–2.4 (todos corrigidos e re-verificados por execução real).

**Fora de escopo confirmado**: todo o frontend (7B — trilha de etapas, painel visual, telas de alertas/chat/dashboard), portal do cliente (§4.3), telas de coletor (DOC-15), KPIs financeiros (DOC-09), tudo do DOC-10 §8.

---

## 5. Nota sobre superfície HTTP não testada por HTTP

Como em toda sessão anterior deste projeto, os controllers (`DashboardController`, `AlertController`, `ChatController`, `OperationsBoardController`) são exercitados nos testes via chamada direta aos services, não via requisição HTTP real (`supertest` ou equivalente não é uma dependência deste projeto). O bug de §2.4 (`@Query` em vez de `@Param`) é exatamente o tipo de erro que esse padrão de teste não pega — foi encontrado por revisão manual do código, não automaticamente. Registrado aqui como um ponto cego estrutural do projeto, não um débito desta sessão especificamente (o padrão já existia em toda sessão anterior).

---

## 6. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  18 passed (18)
     Tests  180 passed (180)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  68 passed (68)
     Tests  264 passed (264)
Test Files  68 passed (68)
     Tests  264 passed (264)

$ docker compose -f infra/docker-compose.yml up -d --build
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-worker | grep -E "Bootstrap|Materialization"
[KpiMaterializationWorkerImpl] KPI materialization worker started
[AlertMaterializationWorkerImpl] Alert materialization worker started
[Bootstrap] ✓ Worker service started (outbox-publisher + realtime-fanout + kpi-materialization + alert-materialization)

$ docker logs wms-backend-scheduler | grep -E "Bootstrap|Snapshot"
[KpiSnapshotWorkerImpl] KPI snapshot worker started
[Bootstrap] ✓ Scheduler service started (... + kpi-snapshot)

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-23T00:57:54.768Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version, description FROM wms.schema_migration WHERE version >= 54 ORDER BY version"
 54 | DOC-10: catalogo de permissoes PAI.PAINEL_OPERACOES/DASHBOARD/DASHBOARD_CLIENTE/CHAT
 55 | DOC-10: kpi_daily/kpi_event_applied, alert/alert_read, chat_room/chat_message, user_board_preference
 56 | DOC-10: kpi_daily/alert/alert_read/chat_room/chat_message - linhas sem cliente visiveis so com warehouse_id
 57 | DOC-10: GRANT SELECT a wms_worker em warehouse/putaway_task/discrepancy/loading/inventory_count/picking_task
 58 | DOC-10: GRANT SELECT a wms_worker em alert_read para AlertService.list/countUnread
 59 | DOC-10: GRANT SELECT, INSERT a wms_worker em chat_room/chat_message para ChatService
```

**`frontend`**: mesmo bloqueio de porta 3001 documentado desde a Sessão 5C (container de outro projeto no host), ambiental — 7B trata.

---

## 7. Commit/push

Commit incluindo: migrations 0056–0059, `modules/paineis/kpi/*` (materialização, snapshot, computação dos 17 KPIs), `modules/paineis/dashboard/*`, `modules/paineis/alertas/*`, `modules/paineis/chat/*`, `RbacService.resolveWarehouseAuthorizedClientIds` (extraído do painel para reuso pelos alertas), `DockService.dockVehicle` (dock_at), `main.ts` (4 workers novos), `grants-contract.integration.spec.ts` atualizado, e o prompt desta sessão (`docs/PROMPT-SESSAO-7A-doc10-backend.md`). Push feito por instrução explícita do usuário.
