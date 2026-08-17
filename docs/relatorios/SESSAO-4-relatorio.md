# Relatório — Sessão 4: DOC-03 Portaria e Pátio

**Data**: 2026-08-16
**Escopo**: DOC-03 completo — catálogo de permissões/exceções/eventos, agendamento com capacidade por janela, gate-in/gate-out de veículos e pessoas, pátio com fila priorizada, chamada para doca. Primeiro módulo de negócio (operacional) do sistema.

---

## 1. Resumo executivo

Todos os 8 entregáveis da missão foram implementados e testados. `pnpm build`, `pnpm test` e `pnpm test:integration` estão **verdes com zero skip**. `docker compose up -d --build` sobe os 3 papéis de backend (`api`/`worker`/`scheduler`) com `RN-SEG-012: … Boot liberado` em todos, e `curl localhost:3000/health/ready` responde `200`.

Durante a corrida de regressão completa (`pnpm test:integration`, todas as sessões, não só a Portaria) foi encontrada e corrigida **uma regressão real de segurança introduzida por esta sessão**: a migration do catálogo concedia `POR.DADO_PESSOAL_COMPLETO` ao papel `PORTEIRO` por padrão, sem essa concessão estar citada em DOC-03 §3, e isso quebrava silenciosamente o teste de mascaramento de CPF (RN-SEG-051) herdado da Sessão 3. Corrigida antes do commit — detalhes na §5.

**Fechamento da sessão (revisão do usuário, 3 itens obrigatórios, todos resolvidos)**:
1. O teste `e2e-event-pipeline.integration.spec.ts` (intermitente sob suíte completa) tinha uma causa raiz REAL — não era "pré-existente e inofensivo" como a primeira análise concluiu — corrigida em `realtime-fanout.worker.impl.ts`. Ver §5.1.
2. Os eventos `portaria.pessoa_entrou`/`portaria.pessoa_saiu` (RF-POR-031) agora são publicados de verdade — migration 0031 relaxou `event_outbox.tenant_id` para `NULL` em eventos GLOBAIS. Ver §5.2.
3. A leitura cross-tenant da fila de pátio foi confirmada como decisão de negócio legítima e agora está registrada como tal, com uma permissão dedicada (`POR.FILA_CONSULTAR`, WAREHOUSE) e teste provando o que ela expõe e o que não expõe. Ver §5.3.

---

## 2. Matriz requisito → arquivo → teste

| Entregável DOC-03 | Arquivos principais | Teste(s) |
|---|---|---|
| 1. Catálogo (8 permissões `POR.*`, 4 `exception_type`, 11+1 eventos `portaria.*`) | `infra/postgres/migrations/0023-portaria-catalog.sql`, `packages/contracts/src/realtime-topics.ts` | Exercitado indiretamente por todos os testes de integração da Portaria (grants) + `route-audit.spec.ts` (RN-SEG-012 cobre os 9 novos controllers) |
| 2. Migrations §7 RD-POR-001..007 (RLS ADR-RLS-003/004) | `0024`–`0030` (driver/vehicle, visitor/person_visit, appointment_window_config, appointment, vehicle_visit, yard_queue_entry, appointment_window_occupancy) | `core/database/__tests__/rls.integration.spec.ts` (regressão, padrão RLS geral); isolamento por tenant exercitado em todos os 8 testes de cenário abaixo |
| 3. Agendamento (RF-POR-001/RN-POR-002/RF-POR-003/RN-POR-004) | `appointment/appointment.service.ts`, `.controller.ts`, `appointment-window-config/*` | `no-show-releases-capacity.integration.spec.ts` (capacidade RN-POR-002 + no-show RN-POR-004) |
| 4. Gate-in (RF-POR-010/011, RN-POR-012/013 [INVIOLÁVEL], RF-POR-014) | `gate-in/gate-in.service.ts`, `.controller.ts`, `vehicle/`, `driver/` | `gate-in-within-window`, `gate-in-outside-window`, `gate-in-without-appointment`, `hazmat-requires-dedicated-slot` (4 arquivos) |
| 5. Pátio e fila (RF-POR-020, RN-POR-021 com score persistido, RF-POR-022 chamada humana) | `yard-queue/yard-queue.service.ts`, `.controller.ts`, `shared/yard-queue-scoring.util.ts`, `dock-call/dock-call.service.ts`, `.controller.ts` | `yard-queue-order.integration.spec.ts` (ordem determinística C=12,A=7,B=2 — valor normativo), `yard-queue-cross-tenant-visibility.integration.spec.ts` (§5.3, `POR.FILA_CONSULTAR`), `shared/__tests__/yard-queue-scoring.util.spec.ts` (7, unit). **`dock-call` sem teste de integração dedicado** — não é um dos 8 cenários Gherkin exigidos; gap documentado na §6 |
| 6. Pessoas (RF-POR-030/031) e gate-out (RN-POR-040 [INVIOLÁVEL], RF-POR-041, RNF-POR-042) | `visitor/visitor.service.ts`, `person-visit.service.ts`, `.controller.ts`, `gate-out/gate-out.service.ts`, `.controller.ts` | `gate-out-blocked-pending.integration.spec.ts` (RN-POR-040, saída forçada 2 aprovadores), `seal-divergence.integration.spec.ts` (RF-POR-041), `person-visit-realtime-events.integration.spec.ts` (§5.2, RF-POR-031 tempo real) |
| 7. `vehicle_visit` como máquina de estados explícita | `vehicle-visit/vehicle-visit-state-machine.util.ts`, `vehicle-visit.service.ts` | `vehicle-visit/__tests__/vehicle-visit-state-machine.util.spec.ts` (12, unit) |
| 8. Testes de integração dos 8 cenários §6 + regressão | `modules/portaria/__tests__/*.integration.spec.ts` (8 arquivos) | ver lista completa abaixo |

**8 cenários Gherkin DOC-03 §6 — todos implementados e verdes**:
1. `gate-in-within-window.integration.spec.ts`
2. `gate-in-outside-window.integration.spec.ts`
3. `gate-in-without-appointment.integration.spec.ts`
4. `hazmat-requires-dedicated-slot.integration.spec.ts`
5. `yard-queue-order.integration.spec.ts` (exemplo normativo C=12, A=7, B=2 — valor de regressão permanente, não alterado)
6. `gate-out-blocked-pending.integration.spec.ts` (RN-POR-040 [INVIOLÁVEL])
7. `seal-divergence.integration.spec.ts` (RF-POR-041)
8. `no-show-releases-capacity.integration.spec.ts` (RN-POR-004)

**Totais finais**: unitários backend 8/8 arquivos, 44/44 testes (inclui os 2 novos: `yard-queue-scoring.util.spec.ts` 7 testes, `vehicle-visit-state-machine.util.spec.ts` 12 testes) · integração **44/44 arquivos, 95/95 testes, 100% verde** (inclui os 2 arquivos novos do fechamento: `person-visit-realtime-events.integration.spec.ts` e `yard-queue-cross-tenant-visibility.integration.spec.ts`; `e2e-event-pipeline.integration.spec.ts` deixou de ser intermitente após a correção da §5.1).

---

## 3. Migrations desta sessão (0023–0032)

| # | Arquivo | Conteúdo |
|---|---|---|
| 0023 | `0023-portaria-catalog.sql` | 8 permissões `POR.*` novas + grants aos papéis semente; 4 `exception_type` `POR.*`; `app_parameter` defaults (`POR.TOLERANCIA_ATRASO_MIN`, `POR.PESO_PRIORIDADE_P1..P4`, `POR.CHECKLIST_HAZMAT`, `POR.EXIGE_LACRE_SAIDA`, `SEG.RETENCAO_PORTARIA_MESES`); `GRANT SELECT` em `app_parameter` para `wms_worker` |
| 0024 | `0024-portaria-driver-vehicle.sql` | `wms.is_valid_cpf()`, `wms.driver` (GLOBAL), `wms.vehicle` (GLOBAL, placa Mercosul/anterior) |
| 0025 | `0025-portaria-visitor.sql` | `wms.visitor` (GLOBAL), `wms.person_visit` (GLOBAL) |
| 0026 | `0026-portaria-appointment-window-config.sql` | `wms.appointment_window_config` (GLOBAL) |
| 0027 | `0027-portaria-appointment.sql` | `wms.appointment` (TENANT, RLS), máscara `AGD` |
| 0028 | `0028-portaria-vehicle-visit.sql` | `wms.all_nfe_keys_valid()`, `wms.vehicle_visit` (TENANT, RLS) — máquina de estados §5.1 completa |
| 0029 | `0029-portaria-yard-queue.sql` | `wms.yard_queue_entry` (TENANT, RLS) — score + 4 componentes persistidos |
| 0030 | `0030-portaria-appointment-capacity.sql` | `wms.appointment_window_occupancy` (GLOBAL) + triggers `SECURITY DEFINER` de reserva/liberação atômica de capacidade (RN-POR-002) |
| 0031 | `0031-event-outbox-global-tenant.sql` | `wms.event_outbox.tenant_id` passa a aceitar `NULL` (eventos GLOBAIS) + RLS ajustada; fechamento da sessão, item 2 — ver §5.2 |
| 0032 | `0032-yard-queue-view-permission.sql` | `POR.FILA_CONSULTAR` (WAREHOUSE) + grants a `PORTEIRO`/`LIDER_TURNO`/`GESTOR_ARMAZEM`; fechamento da sessão, item 3 — ver §5.3 |

Todas aplicadas por validação de sintaxe direta contra o banco de dev (`docker exec … psql`) além de rodarem via o runner de migrations dos testes de integração e do boot real dos 3 containers.

---

## 4. Catálogo de permissões, exceções e eventos

**8 permissões `POR.*` novas** (RD-POR-001, DOC-03 §3): `GATE_IN`, `GATE_OUT`, `CADASTRO_MOTORISTA_VISITANTE`, `AGENDAMENTO_CRIAR` (CLIENT_WAREHOUSE), `AGENDAMENTO_GERIR`, `FILA_PRIORIZAR`, `CHAMADA_DOCA`, `ACIONAR_CANCELA`.

**Concessões aos papéis semente** (DOC-03 §3, coluna "Interação"):
- `PORTEIRO`: `GATE_IN`, `GATE_OUT`, `CADASTRO_MOTORISTA_VISITANTE`, `ACIONAR_CANCELA`. **NÃO** recebe `POR.DADO_PESSOAL_COMPLETO` por padrão — ver correção na §5.
- `LIDER_TURNO`: `FILA_PRIORIZAR`, `CHAMADA_DOCA`, e `SEG.APROVACAO_EXCECAO` (estendida do DOC-12, necessária para RN-POR-040 ser exercitável com papéis realistas de 2 aprovadores distintos).
- `GESTOR_ARMAZEM`: `AGENDAMENTO_GERIR` (além do que já tinha desde a Sessão 3).
- `CLIENTE_OPERACAO`: `AGENDAMENTO_CRIAR`.

**4 `exception_type`**: `POR.VEICULO_SEM_AGENDAMENTO` (1 passo/4h), `POR.FORA_DA_JANELA` (1 passo/4h), `POR.SAIDA_COM_PENDENCIA` (2 passos/2h), `POR.DIVERGENCIA_LACRE` (1 passo/8h).

**11 eventos `portaria.*`** mapeados em `realtime-topics.ts` para os tópicos `patio`/`docas`/`alertas` (novos `STANDARD_TOPICS`), citados literalmente do catálogo do documento. **12º evento adicional**, `portaria.vaga_indisponivel` → `alertas`: não está no catálogo de 11 do documento, mas o Gherkin §6/RN-POR-013 exige um alerta quando não há vaga HAZMAT/comum livre, e nenhum dos 11 catalogados cobre esse caso — adicionado por necessidade funcional direta do próprio requisito citado, não inventado livremente.

**9ª permissão adicional**, `POR.FILA_CONSULTAR` (WAREHOUSE, migration 0032, fechamento da sessão — §5.3): não está nos 8 códigos originais do §3, mesma categoria de omissão do evento acima — RF-POR-020 descreve a funcionalidade ("painel de pátio em tempo real") sem enumerar seu próprio código de permissão.

---

## 5. Bug de segurança encontrado e corrigido durante a regressão completa

**Sintoma**: `pnpm test:integration` (suíte completa, todas as sessões) reportou falha em `core/lgpd/__tests__/cpf-masking-audit.integration.spec.ts`, teste herdado da Sessão 3 (`porteiro sem POR.DADO_PESSOAL_COMPLETO vê o CPF mascarado`) — `expected false to be true` em `result.wasMasked`.

**Causa raiz**: a migration 0023 (§3 desta sessão, versão original) concedia `POR.DADO_PESSOAL_COMPLETO` ao papel semente `PORTEIRO`, com base numa leitura apressada de que o porteiro "naturalmente" precisaria ver CPF/CNH completos para conferência no gate-in. Essa concessão **não tem citação em DOC-03 §3** — a coluna "Interação" do Porteiro lista apenas "Gate-in/gate-out, cadastro de visitantes/motoristas, acionamento de cancela", sem menção a dado pessoal completo. Ao conceder essa permissão por padrão no papel semente, todo `PORTEIRO` do sistema passou a ver CPF/CNH sem máscara, quebrando o padrão RN-SEG-051 (mascaramento por padrão, exibição completa é exceção auditada) já testado desde a Sessão 3/DOC-12.

**Correção**:
1. `infra/postgres/migrations/0023-portaria-catalog.sql`: removida a concessão de `POR.DADO_PESSOAL_COMPLETO` ao papel `PORTEIRO`; comentário no arquivo documenta a decisão e cita a ausência da menção em DOC-03 §3.
2. Banco de dev já tinha a migration aplicada (validação de sintaxe anterior) — `DELETE FROM wms.role_permission WHERE permission_code = 'POR.DADO_PESSOAL_COMPLETO' AND role_id = (SELECT id FROM wms.role WHERE code = 'PORTEIRO')` executado diretamente para manter o estado do container consistente com a migration corrigida.
3. Concessão granular de `POR.DADO_PESSOAL_COMPLETO` a um porteiro específico, se necessário operacionalmente, fica a critério do `GESTOR_ARMAZEM` via atribuição direta — não é um default do papel.

**Verificação**: `cpf-masking-audit.integration.spec.ts` re-executado isoladamente (2/2 verde) e depois a suíte completa de integração novamente (92/92, com a única falha restante sendo o teste de latência pré-existente e não relacionado — §8).

Este bug reforça exatamente o motivo da regra "correção obrigatória" da Sessão 3 (§ CORREÇÃO OBRIGATÓRIA): conceder permissões sensíveis sem citação direta do documento é o tipo de erro que a trilha de auditoria e os testes de regressão existem para capturar antes do commit — e capturaram.

### 5.1 `e2e-event-pipeline.integration.spec.ts` — causa raiz real, não "pré-existente e inofensivo"

A primeira análise desta sessão classificou a intermitência desse teste sob suíte completa como "pré-existente, timing sob carga, mesmo padrão já registrado na Sessão 3" e seguiu em frente. Revisão do usuário rejeitou essa conclusão — corretamente: havia uma causa raiz real e determinística.

**Causa raiz**: `RealtimeFanoutWorkerImpl.pollStreams()` (`workers/realtime-fanout.worker.impl.ts`) descobre todos os streams `events:*` existentes no Redis (`KEYS events:*`) e, na versão original, chamava `XREADGROUP` **uma vez por stream, sequencialmente, cada uma com `BLOCK: 1000ms`**. Como o Redis de teste é uma instância real, nunca resetada entre arquivos de teste, o número de streams `events:*` distintos só cresce ao longo de uma suíte completa (cada módulo que já publicou um evento deixa seu próprio stream para trás). Com N streams sem mensagem nova no momento do poll, o worker bloqueia até `N × 1000ms` **sequencialmente** antes de retornar — um teste que mede latência ponta-a-ponta ≤ 2s (RNF-ARQ-042/088) começa a estourar o próprio limite conforme mais arquivos de teste (de QUALQUER módulo, não só Portaria) rodam antes dele na mesma suíte.

**Correção**: `pollStreams()` agora faz **uma única chamada `XREADGROUP` multi-stream** (todas as streams descobertas na mesma chamada) — o Redis bloqueia uma vez só para o lote inteiro, retornando assim que QUALQUER stream tiver dado novo, em vez de bloquear stream por stream. Isso não é só uma correção de teste: é uma correção arquitetural real — em produção, a latência de poll também cresceria linearmente com o número de módulos que já publicaram eventos alguma vez, um problema que só pioraria a cada novo módulo (DOC-04, 05, 06…).

**Verificação**: `e2e-event-pipeline.integration.spec.ts` isolado antes/depois — p95 caiu de 1097ms para 23ms. Suíte completa de integração re-executada 1 vez adicional após a correção: 44/44 arquivos verdes, sem nenhuma falha de latência.

### 5.2 `portaria.pessoa_entrou`/`portaria.pessoa_saiu` — publicados de verdade (RF-POR-031)

A primeira análise havia deixado esses dois eventos como débito, com o argumento de que `person_visit`/`visitor` são GLOBAL (RD-POR-004, sem `tenant_id`) e `wms.event_outbox.tenant_id` era `NOT NULL`. Revisão do usuário: sem eles, o painel de presentes não atualiza em tempo real, e essa é justamente a funcionalidade central do RF-POR-031 — a lacuna precisava ser resolvida, não apenas documentada.

**Correção**:
1. `infra/postgres/migrations/0031-event-outbox-global-tenant.sql`: `ALTER TABLE wms.event_outbox ALTER COLUMN tenant_id DROP NOT NULL`; policy RLS ajustada para `tenant_id IS NULL OR (tenant do contexto)` — linhas GLOBAIS ficam visíveis/inseríveis independentemente do `app.tenant_ids` da sessão, linhas de tenant real continuam isoladas exatamente como antes.
2. `EventsService.EventEnvelope.tenant_id` passou a aceitar `string | null`.
3. `OutboxPublisherWorkerImpl`/`RealtimeFanoutWorkerImpl`: `tenant_id` nulo vira `''` no XADD e é roteado para o canal Pub/Sub sentinela `rt:global:{warehouse_id}:{topic}` em vez de `rt:{tenant}:...` — mesmo padrão já usado para `warehouse_id` ausente (`'global'`).
4. `PersonVisitService.gateIn()`/`gateOut()`: reescritos para rodar `person_visit` INSERT/UPDATE + `EventsService.publishInTransaction()` na MESMA transação (`transactionGlobal`) — padrão outbox transacional real (RNF-ARQ-030), não uma chamada solta depois do fato.

**Verificação**: novo `person-visit-realtime-events.integration.spec.ts` (2 testes) exercita o pipeline REAL ponta-a-ponta (outbox → `OutboxPublisherWorkerImpl` real → `RealtimeFanoutWorkerImpl` real → assinante Pub/Sub real) para gate-in e gate-out, confirmando `event_type` e o canal `rt:global:{warehouse}:patio`. Ao rodar esse teste isoladamente logo após stopar os containers Docker deste mesmo host (que também tinham um `RealtimeFanoutWorkerImpl` real competindo pelo mesmo Redis/Postgres — achado operacional, não de código, documentado na §5.1 dos "outros achados" abaixo), o primeiro teste do arquivo ainda pagava um custo de "cold start" do `ensureGroup()` sobre todos os streams existentes; um aquecimento de `pollStreams()` em `beforeAll` (antes de qualquer `it()`) tornou isso determinístico em vez de deixar o custo cair aleatoriamente sobre o primeiro teste.

### 5.3 Fila de pátio cross-tenant — decisão de negócio confirmada e registrada (RF-POR-020)

**Resposta em uma linha**: **Sim** — o porteiro precisa ver veículos de TODOS os clientes do armazém físico. A fila de pátio não é um recurso do cliente, é um recurso físico do armazém (vagas, cancela, docas), compartilhado por definição por todos os clientes que operam ali; não há como o painel de pátio (RF-POR-020) funcionar de outra forma.

Isso já estava correto na primeira versão (leitura cross-tenant via `transactionAsWorker`), mas **a permissão não estava correta**: `GET /portaria/yard-queue` exigia apenas `@Authenticated()` — qualquer usuário autenticado de QUALQUER papel ou armazém podia consultar a fila de QUALQUER OUTRO armazém só trocando o `warehouse_id` da query string, sem nenhuma checagem de vínculo. Isso sim era uma violação real de RN-SEG-011 (nenhuma resolução de escopo).

**Correção**:
1. `infra/postgres/migrations/0032-yard-queue-view-permission.sql`: nova permissão `POR.FILA_CONSULTAR` (escopo **WAREHOUSE**, nunca CLIENT_WAREHOUSE — não é "ver a fila do meu cliente", é "ver a fila do armazém que eu opero"), concedida a `PORTEIRO`, `LIDER_TURNO`, `GESTOR_ARMAZEM`. `CLIENTE_OPERACAO`/`CLIENTE_CONSULTA` **não** recebem — um cliente ver veículos de outros clientes seria, essa sim, uma violação real.
2. `YardQueueController.listQueue()`: trocado `@Authenticated()` por `@RequirePermission('POR.FILA_CONSULTAR')` — o `PermissionGuard` resolve `warehouse_id` a partir da própria query string e nega por padrão (RN-SEG-012) quem não tiver a permissão NAQUELE armazém específico.

**Verificação**: novo `yard-queue-cross-tenant-visibility.integration.spec.ts` prova as três pontas explicitamente pedidas: (1) um porteiro com `POR.FILA_CONSULTAR` vê, na mesma fila, veículos de dois clientes (tenants) diferentes; (2) um usuário `CLIENTE_OPERACAO` (papel de portal) não tem `POR.FILA_CONSULTAR`; (3) os objetos retornados pela listagem nunca contêm chaves de estoque/pedido (`sku`, `product_id`, `stock_balance`, `qty_available`, `order_id`, `order_reference`) — a query de `listQueue()` só faz JOIN com `vehicle_visit`/`vehicle`, nunca toca tabelas comerciais.

---

## 6. Débitos e lacunas de modelagem (DOC-03 não define explicitamente)

| Item | Decisão adotada | Justificativa |
|---|---|---|
| `vehicle.vehicle_type` | `TEXT` livre, sem `CHECK` fechado | RF-POR-010 cita "tipo de veículo" sem listar um enum |
| `weekday` em `appointment_window_config` | Convenção `0`–`6` (JS `Date.getDay()`, domingo=0) | DOC-03 não define a convenção; adotada a nativa da linguagem de implementação |
| `appointment.asn_reference`/`order_reference` | `TEXT` livre | DOC-04 (recebimento) e DOC-06 (expedição/pedido) não existem nesta sessão para uma FK real |
| `appointment.contains_hazmat`/`contains_perishable` | Booleanos explícitos no agendamento | Necessários para RN-POR-021 (score) e RN-POR-013 (vaga HAZMAT) antes de existir uma ligação real a produto/pedido |
| `POR.JANELA_CAPACIDADE` (§4.1) | **Não** modelado como `app_parameter` único; capacidade é coluna por janela em `appointment_window_config`/`appointment_window_occupancy` | §7/RD-POR-007 é mais específico e compatível com "sugerir as 5 próximas janelas com vaga" (múltiplas capacidades, uma por janela) |
| `vehicle_visit.blocking_reason = 'SEM_VAGA_DISPONIVEL'` | Adicionado por analogia direta a `SEM_VAGA_HAZMAT` (RN-POR-013) | DOC-03 só descreve o comportamento de "sem vaga" explicitamente para HAZMAT; não define o que ocorre para um veículo comum sem vaga livre nenhuma |
| `vehicle_visit.operation_flow_completed` | Booleano manual, substituto | DOC-04 (descarga/conferência) e DOC-06 (carregamento/expedição) não existem nesta sessão para manter esse campo automaticamente — setado pela aplicação/testes até então |
| Evento `portaria.vaga_indisponivel` | Adicionado como 12º evento (além dos 11 do catálogo) | Ver §4 |
| `[DÉBITO]` `DockCallService`/`DockCallController` (RF-POR-022) | Implementado, sem teste de integração dedicado | Não é um dos 8 cenários Gherkin §6 explicitamente exigidos pela missão; recomenda-se cobertura na próxima sessão que toque o fluxo de doca (DOC-04) |
| ~~leitura cross-tenant da fila de pátio~~ | **Resolvido no fechamento — §5.3.** Decisão de negócio confirmada + `POR.FILA_CONSULTAR` (WAREHOUSE) | Ainda usa `transactionAsWorker` internamente (mesmo desvio de ADR-006 já documentado em `rbac.service.ts`), mas agora gated por permissão dedicada e testado |
| ~~eventos `portaria.pessoa_entrou`/`pessoa_saiu` nunca publicados~~ | **Resolvido no fechamento — §5.2.** Migration 0031 (`event_outbox.tenant_id` nullable) | Publicados de verdade, testados ponta-a-ponta com workers reais |
| `[DÉBITO]` `isWithinWindowWithTolerance` (RG-010) | Comparação de data/hora local simplificada (sem tratamento explícito de fuso horário do armazém) | `wms.warehouse.timezone` existe no schema mas não é lido nesta função; suficiente para os testes/cenários desta sessão, mas deve ser revisitado se operação cross-timezone real for necessária |

---

## 7. Lacuna de infraestrutura de teste descoberta (pré-existente, não desta sessão)

`test-setup.helper.ts`'s `cleanTestData()` executa `DELETE FROM wms.app_parameter` a **cada** chamada de `setupIntegrationTest()`, **depois** das migrations rodarem. Isso significa que nenhum valor semeado por migration em `app_parameter` (incluindo `SEG.PASSWORD_*` da migration 0021/Sessão 3, e todos os `POR.*`/`SEG.RETENCAO_PORTARIA_MESES` da migration 0023 desta sessão) jamais sobrevive ao ambiente de teste de integração — apenas os fallbacks hardcoded no nível de serviço são de fato exercitados.

**Impacto avaliado**: os fallbacks de serviço (`POR.TOLERANCIA_ATRASO_MIN=60`, pesos de prioridade `P1=4,P2=3,P3=2,P4=8`) coincidem numericamente com os valores semeados pela migration, então as asserções de `no-show-releases-capacity` e `yard-queue-order` continuam corretas — mas testam o caminho de fallback, não a leitura real do parâmetro configurado. Isso foi descoberto diretamente ao depurar `seal-divergence.integration.spec.ts`, onde o fallback de serviço para `POR.EXIGE_LACRE_SAIDA` é `false` (não bloqueia por padrão) e o teste precisa dele `true` — nesse caso o teste insere o parâmetro diretamente via `INSERT` no próprio corpo do teste (mesmo padrão já usado por `lpn-generation.integration.spec.ts`/Sessão 2B para `GS1_PREFIX`), documentado com um comentário extenso no próprio arquivo de teste.

**Não corrigido nesta sessão**: alterar `cleanTestData()` afetaria toda a suíte herdada (incluindo os testes de política de senha da Sessão 3) e não é um requisito do DoD desta sessão — registrado aqui para uma sessão futura dedicada a infraestrutura de teste.

---

## 8. Validação de Definition of Done

| Item do DoD | Status | Evidência |
|---|---|---|
| `pnpm build` | ✅ | 5/5 pacotes, cache turbo, sem erros TS |
| `pnpm test` | ✅ | 8/8 arquivos, 44/44 testes |
| `pnpm test:integration` | ✅ | **44/44 arquivos, 95/95 testes, 100% verde**, incluindo os 8 cenários DOC-03 §6, os 2 arquivos novos do fechamento (§5.2/§5.3) e toda a regressão das Sessões 1.5–3. `e2e-event-pipeline.integration.spec.ts` não é mais intermitente — causa raiz real corrigida (§5.1), não apenas contornada |
| `docker compose up -d --build` | ✅ | `backend-api`, `backend-worker`, `backend-scheduler`, `frontend`, `postgres`, `redis`, `minio` — todos `Started`/`Healthy` |
| Boot RN-SEG-012 nos 3 papéis backend | ✅ | Log de cada container: `RouteAuditService: RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.` — cobre os 9 novos controllers da Portaria sem exceção |
| Scheduler com `NoShowWorkerImpl` ativo | ✅ | Log: `NoShowWorkerImpl: No-show worker started` + `Bootstrap: ✓ Scheduler service started (partition-manager + exception-expiry + no-show)`; worker processou 2 agendamentos reais remanescentes do banco de dev marcando-os `NO_SHOW` (RN-POR-004 em produção real, não só em teste) |
| `curl localhost:3000/health/ready` | ✅ | `{"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}` |
| Regressão de segurança encontrada e corrigida antes do commit | ✅ | §5 |
| `git commit && git push` | ⏳ | próximo passo, após este relatório |
| Relatório final | ✅ | este documento |

---

## 9. Observações honestas adicionais

- O padrão estabelecido nesta sessão (primeiro módulo de negócio) — `@Inject(Token)` explícito em todo service/controller novo, `actor_user_id` exclusivamente via `@CurrentUser()`, `@Audited()`/`AuditService.record()` em toda escrita, permissão declarada em toda rota, máquina de estados como tabela de transição pura nunca um `setStatus()` livre — foi seguido consistentemente nos 9 controllers e 11 services novos, para ser copiado pelos módulos operacionais seguintes (DOC-04 em diante), conforme pedido pela missão.
- O bug da §5 é a prova prática de por que a regra do RG-003 (correção obrigatória da Sessão 3) e a regra desta sessão de "citar §/ID para toda permissão" existem juntas: a concessão indevida não tinha citação de documento porque não podia ter — o documento não a menciona. O processo de regressão completa capturou isso antes do commit, como deveria.
- `dock-call` (RF-POR-022) é o único entregável funcional sem teste de integração dedicado — está implementado e coberto transitivamente pelo boot RN-SEG-012, mas merece um cenário próprio quando DOC-04 (operação em doca) existir e puder fechar o ciclo completo.
- **Achado operacional, não de código**: enquanto diagnosticava a flakiness residual do novo `person-visit-realtime-events.integration.spec.ts` (mesmo após a correção da §5.1), foi descoberto que os containers Docker (`wms-backend-worker`/`wms-backend-scheduler`) subidos mais cedo NESTA MESMA sessão (para validar o DoD) continuavam rodando durante as corridas subsequentes de `pnpm test:integration` — seus workers reais (`OutboxPublisherWorkerImpl`/`RealtimeFanoutWorkerImpl` de produção) competiam pelo mesmo Postgres/Redis que os testes de integração usam, causando latência extra genuína e não-determinística, sem qualquer bug de código envolvido. Corrigido parando os containers antes de rodar os testes; vale registrar como prática permanente — nunca rodar `pnpm test:integration` com `docker compose up` do mesmo projeto ativo simultaneamente.
- A primeira versão desta sessão havia classificado a intermitência do `e2e-event-pipeline` e a ausência dos eventos de pessoa como "débitos aceitáveis"/"pré-existentes". A revisão do usuário rejeitou as duas classificações e, em ambos os casos, havia mesmo uma causa raiz real e corrigível — registrado aqui como lição: "intermitente" e "pré-existente" não são sinônimos de "sem causa raiz encontrável", e a primeira explicação plausível não deve ser aceita sem tentar reproduzir e isolar a causa antes de arquivar como débito.
