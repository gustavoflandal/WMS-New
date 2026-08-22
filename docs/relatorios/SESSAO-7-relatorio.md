# Relatório — Sessão 7 (checkpoint parcial): DOC-10 Painéis, Dashboards e Tempo Real

**Data**: 2026-08-22
**Escopo executado**: fundação de dados (migrations, catálogo de permissões),
correção estrutural do pipeline de tempo real, e o Painel de Operações
(RF-PAI-001/002, RN-PAI-004) — backend completo e testado.
**Escopo NÃO executado nesta sessão** (fica para 7A/7B, ver
`docs/PROMPT-SESSAO-7A-doc10-backend.md` e `docs/PROMPT-SESSAO-7B-doc10-frontend.md`):
worker de materialização de KPIs, endpoints de dashboard, centro de alertas,
chat operacional, e **todo o frontend** (a sessão foi interrompida/dividida
neste ponto — este relatório documenta o checkpoint, não um fechamento de
DoD completo do DOC-10).
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`,
`docs/DOC-10-paineis-dashboards-tempo-real.md`,
`docs/relatorios/SESSAO-6B-relatorio.md`.

---

## 1. Por que este relatório existe como checkpoint, não como fechamento

O prompt original desta sessão (`docs/PROMPT-SESSAO-7-doc10-paineis.md`) cobria
backend + frontend do DOC-10 inteiro — escopo maior do que uma sessão de
implementação cuidadosa comporta com verificação real em cada etapa (ao
contrário de sessões anteriores de menor superfície, aqui backend e frontend
foram deliberadamente separados em 7A/7B a meio da execução, com a
concordância do usuário). Tudo abaixo foi verificado por execução real
(build, testes, containers) antes de ser dado como pronto — nada foi
declarado ✅ sem saída de comando colada.

---

## 2. Entregáveis prontos e verificados

### 2.1 Migrations e catálogo (RD-PAI-001..005, DOC-10 §3/§7)

- `0054-paineis-catalogo.sql` — permissões `PAI.PAINEL_OPERACOES`/`DASHBOARD`/
  `DASHBOARD_CLIENTE`/`CHAT` (DOC-10 §3), atribuídas a todo papel INTERNAL
  (Painel/Chat) exceto `ADMIN_SISTEMA`/`ADMIN_SEGURANCA` (mantidos só-GLOBAL,
  ver §4.1), a Gestor/Líder (Dashboard) e aos papéis de portal
  (Dashboard Cliente).
- `0055-paineis-tabelas.sql` — `kpi_daily`, `kpi_event_applied`, `alert` +
  `alert_read`, `chat_room` + `chat_message`, `user_board_preference`
  (RD-PAI-001..005). Decisão de modelagem registrada no cabeçalho da
  migration: linhas "sem dimensão de cliente" (KPIs de doca/pátio/ocupação,
  alertas sem cliente natural, sala armazém-turno) usam `client_id`/
  `tenant_id` NULL — visíveis a qualquer sessão com o `warehouse_id` certo,
  mesmo padrão já usado por `app_parameter` escopo `WAREHOUSE`.
- `[LACUNA: DOC-10 não define catálogo de turnos]` — "armazém-turno" modelado
  como 1 sala persistente por armazém (não 1 por turno/dia), documentado no
  comentário da migration.

### 2.2 Correção estrutural no pipeline de tempo real (RF-ARQ-040/041, RF-PAI-003)

Achado ao implementar o Painel: o pipeline outbox→Streams→fanout→WebSocket
tinha uma lacuna real e pré-existente — **nenhum código assinava os canais
Pub/Sub que o fanout publica**. `RealtimeGateway.broadcast()` existia mas
nunca era chamado, e o formato da room Socket.IO (`rt:{tenant}:{tópico}`, 2
segmentos) divergia do canal Pub/Sub publicado pelo fanout
(`rt:{tenant}:{warehouse}:{tópico}`, 3 segmentos). Na prática: eventos
publicados nunca alcançavam um cliente WebSocket real — só os testes que
assinam o Redis cru diretamente (padrão da 1.5) provavam a entrega.

Corrigido (sem o qual RF-PAI-003 "atualização em ≤ 2s" seria impossível para
o frontend real, não só para os testes):
- `RealtimeGateway`: `afterInit()` agora assina `rt:*` via um cliente Redis
  dedicado e repassa a mensagem para a room Socket.IO de mesmo nome
  (`subscribeToFanout()`); `handleSubscribe()` corrigido para o formato de 3
  segmentos (inclui `warehouse_id`, lido do socket autenticado).
- `realtime-fanout.worker.impl.ts`: `resolveTopic()` extraído para permitir
  `paineis.chat_mensagem` resolver um tópico DINÂMICO por sala
  (`chat:{room_id}`, lido do payload) — `EVENT_TOPIC_MAPPING` só suporta
  1 event_type → 1 tópico fixo, insuficiente para RF-PAI-030 ("tópico
  `chat:{sala}`").
- `realtime-topics.ts`: `paineis.alerta_emitido` → `ALERTS` (mesmo tópico já
  usado por toda notificação de exceção/condição anormal — não um tópico
  `painel_operacoes` novo; o painel consome `operations:pending`, já
  documentado em `outbound-flow.service.ts` desde a 6A/6B).

Não foi adicionado teste de cliente Socket.IO real (exigiria a dependência
`socket.io-client`, nova, e o padrão de teste já estabelecido no projeto para
essa SLA é assinar o Redis cru diretamente — mantido). A correção foi
verificada por: build limpo, as 246 integração continuarem verdes (inclusive
`e2e-event-pipeline.integration.spec.ts`, que exercita o worker de fanout
real), e boot do container `backend-api` sem erro.

### 2.3 `OperationFlowService.started_at` (pré-requisito do Painel)

`flow_step.started_at` existia na tabela desde a 6A mas nunca era escrito —
sem ele não há como calcular "tempo na etapa atual" (RF-PAI-001) nem SLA/
atraso (RN-PAI-004). Corrigido em 3 pontos do serviço CANÔNICO (não uma
segunda leitura):
- `createFlow()`: a 1ª etapa nasce com `started_at = now()` (já é a
  acionável desde a criação).
- `completeStep()`: ao concluir uma etapa, a NOVA primeira PENDING recebe
  `started_at = now()`.
- `insertDynamicStep()`: a etapa dinâmica (RF-REC-020) nasce já acionável,
  mesmo raciocínio.

Nenhuma mudança de comportamento de negócio — só popula um campo que já
existia e que nada lia com um valor real. As 246 integrações (incluindo toda
a suíte de picking/putaway/recebimento que usa fluxos) continuam verdes.

### 2.4 Painel de Operações — backend completo (RF-PAI-001/002, RN-PAI-004)

`modules/paineis/operacoes/`:
- `operations-board.service.ts` — `listCards()`: RN-SEG-011 resolvido em
  código (não por RLS — o painel é deliberadamente cross-cliente dentro do
  armazém): se QUALQUER atribuição vigente que concede
  `PAI.PAINEL_OPERACOES` no armazém tiver `client_id` NULL, acesso
  irrestrito; caso contrário, restrito ao conjunto de clientes concedidos.
  Consulta os 2 tipos de entidade que hoje criam `operation_flow`
  (`inbound_order`, `outbound_order` — Reversa/Transferência/Inventário não
  abrem fluxo ainda, então simplesmente não aparecem, sem código morto).
  Atraso via `PAI.SLA_ETAPA_MIN` (JSON `app_parameter` WAREHOUSE, "sem
  entrada = sem SLA"). Ordenação padrão: atrasados primeiro, depois maior
  tempo na etapa.
- `board-preference.service.ts` (RD-PAI-005) + `operations-board.controller.ts`
  (`paineis/operacoes`, `PAI.PAINEL_OPERACOES`).

**Achado real durante a implementação**: `wms_worker` (BYPASSRLS) nunca havia
lido `operation_flow`/`flow_step`/`inbound_order`/`client` — GRANT explícito
adicionado na migration 0055 (mesmo padrão já quebrado e corrigido 4 vezes
em sessões anteriores; ver `CLAUDE.md`).

**Teste** (`operations-board.integration.spec.ts`, 6 cenários): RN-SEG-011
(cliente A não vê cartões do cliente B; usuário irrestrito vê ambos — usando
o papel `PORTEIRO` para o caso irrestrito, não `GESTOR_ARMAZEM`, que acumula
permissões `CLIENT_WAREHOUSE` de outras sessões e por isso não pode ser
atribuído sem `client_id`, RD-SEG-010); conteúdo do cartão (RF-PAI-001);
atraso ausente sem SLA configurado e presente com SLA=0 (RN-PAI-004);
ordenação padrão (RF-PAI-002).

---

## 3. Achados/correções que não eram do escopo do Painel, mas foram necessários

Ver `CLAUDE.md` (novo, raiz do repo) para a regra geral extraída destes
achados. Resumo:

1. **`app_parameter` GLOBAL com RLS incorreta** (migration 0053, sessão
   anterior a esta) — corrigida na policy, não nos chamadores; fechou por
   tabela o débito de `expiration.service.ts` sem tocar no arquivo.
2. **`DatabaseService.queryGlobal()` ganhou uma rede de segurança** contra o
   mesmo bug de RLS silenciosa se repetindo numa 4ª tabela — só escala
   quando a reconferência via `wms_worker` **encontra** linhas (não quando a
   reconferência falha por outro motivo, ex. falta de GRANT — achado
   corrigido na mesma sessão anterior, ver relatório da 5C §5.6).
3. **Regra de teste**: nunca comparar dois resultados possivelmente vazios
   sem antes afirmar que ao menos um é não-vazio.

---

## 4. Matriz requisito → arquivo → teste (só o executado nesta sessão)

| Requisito | Arquivo(s) | Teste |
|---|---|---|
| RD-PAI-001..005 (schema) | `infra/postgres/migrations/0054-paineis-catalogo.sql`, `0055-paineis-tabelas.sql` | `grants-contract.integration.spec.ts` (7 tabelas novas + 4 GRANTs novos em tabelas existentes) |
| RF-PAI-003 (infra de tempo real) | `core/realtime/realtime.gateway.ts`, `workers/realtime-fanout.worker.impl.ts`, `packages/contracts/src/realtime-topics.ts` | Regressão: `e2e-event-pipeline.integration.spec.ts`, `person-visit-realtime-events.integration.spec.ts` (continuam verdes); sem teste de cliente Socket.IO real (ver §2.2) |
| RF-PAI-001 conteúdo do cartão | `modules/paineis/operacoes/operations-board.service.ts` | `operations-board.integration.spec.ts` |
| RF-PAI-002 filtros/ordenação/preferências | idem + `board-preference.service.ts` | idem |
| RN-PAI-004 atraso por SLA | idem | idem |
| RN-SEG-011 (RBAC filtra cartões) | idem | idem (cenário Gherkin §6 do DOC-10) |
| KPI: fórmulas puras + OTIF normativo | `modules/paineis/kpi/kpi-formula.util.ts` | `kpi-formula.util.spec.ts` (12 testes) — **fórmulas prontas, mas NENHUM consumidor de produção ainda as usa** (materialização é da 7A) |

**Totais desta sessão**: unit **+12 testes** (173 no total do backend);
integração **+7 testes** (246 no total do backend, 2 execuções consecutivas
idênticas).

---

## 5. Lacunas e débitos (para 7A/7B)

- **`[DÉBITO: 7A]`** worker de materialização de KPIs (RN-PAI-042), os 17
  KPIs ligados a eventos reais, endpoints de dashboard (RF-PAI-040/043),
  centro de alertas (RF-PAI-010), chat operacional (RF-PAI-030/RN-PAI-031).
  Nada disso foi tocado além das tabelas/migrations e dos utilitários puros
  de fórmula.
- **`[DÉBITO: 7B]`** todo o frontend — trilha de etapas (RF-PAI-005, "o
  coração"), painel visual, telas de alertas/chat/dashboard.
- **`[LACUNA]`** catálogo de turnos para "armazém-turno" (ver §2.1).
- **`[DÉBITO]`** teste de cliente Socket.IO real ponta a ponta (ver §2.2) —
  a correção do pipeline foi verificada por regressão e inspeção de código,
  não por um novo cliente WS de teste.

---

## 6. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  17 passed (17)
     Tests  173 passed (173)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  64 passed (64)
     Tests  246 passed (246)
Test Files  64 passed (64)
     Tests  246 passed (246)

$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-22T20:02:21.017Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version, description FROM wms.schema_migration WHERE version >= 53 ORDER BY version"
 53 | app_parameter_visibility: escopo GLOBAL legivel/gravavel sem contexto de tenant (DOC-02 5.7)
 54 | DOC-10: catalogo de permissoes PAI.PAINEL_OPERACOES/DASHBOARD/DASHBOARD_CLIENTE/CHAT
 55 | DOC-10: kpi_daily/kpi_event_applied, alert/alert_read, chat_room/chat_message, user_board_preference
```

**`frontend`**: não testado nesta sessão (7B é o dono desse escopo);
continua com o mesmo bloqueio de porta 3001 documentado na 5C, ambiental.

---

## 7. Commit/push

Commit incluindo: migrations 0054/0055, correções de `RealtimeGateway`/
`realtime-fanout.worker.impl.ts`/`realtime-topics.ts`, `OperationFlowService`
(started_at), módulo `paineis/operacoes` completo (service, controller,
board-preference, testes), `paineis/kpi/kpi-formula.util.ts` + teste,
`grants-contract.integration.spec.ts` atualizado, `paineis.module.ts`
(substituindo o stub vazio da Sessão 0), e o prompt original desta sessão
(`docs/PROMPT-SESSAO-7-doc10-paineis.md`). Push feito por instrução explícita
do usuário. `docs/PROMPT-SESSAO-7A-doc10-backend.md` e
`docs/PROMPT-SESSAO-7B-doc10-frontend.md` ficam de fora deste commit —
pertencem à sessão que de fato os executar.
