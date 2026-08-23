# PROMPT — SESSÃO COL-2A: MOTOR OFFLINE — PACOTE DE TURNO, FILA E RESOLUÇÃO DE CONFLITOS (SERVIDOR)

## Especificação de Execução

| Metadado | Valor |
|---|---|
| Sessão | COL-2A (parte 1 de 2 — backend; COL-2B é o frontend que consome esta API) |
| Módulo | DOC-15 (Operação em Campo), §4.6/§10; DOC-01 §4.6 (RF-ARQ-051/052/RN-ARQ-053/RNF-ARQ-054), §5.2 (máquina de estados da `sync_queue`) |
| Dependência de | DOC-00 v1.4.0 (§2.2 stack congelada), Sessão COL-1 ✓ (`wms.field_device`, `COL.*`, PIN), Sessão 5C ✓ (motor de inventário), Sessão 4B ✓ (putaway), Sessão 6B ✓ (picking) |
| Modelo | Sonnet (médio-alto — máquina de estados, idempotência, dispatch por tipo de tarefa; sem UI) |
| Data de Abertura | — (abrir quando a Sessão COL-1 estiver commitada; ela está — commit `8940f99`) |
| Stack | NestJS + PostgreSQL 16, dentro de `apps/backend/src/modules/campo/` (DOC-00 §2.2 `[INVIOLÁVEL]`). **Nenhum módulo/serviço externo novo.** |
| Alvo | Endpoints server-side de RF-ARQ-051 (Pacote de Turno), RF-ARQ-052 (recepção da fila offline), RN-ARQ-053 (as 4 decisões, aplicadas por dispatch aos services já existentes de cada tarefa), RNF-ARQ-054 (limite), RNF-COL-050 (versão mínima) e RNF-COL-051 (telemetria/alerta) |
| Posição no Plano | COL-2A, após COL-1 ✓. Antes de **COL-2B** (as 5 telas de execução T2–T6 offline, que consomem esta API). |

---

## 1. ESTADO REAL DO BACKEND (levantado nesta sessão — não presumir nada além disto)

Isto é o achado mais importante desta sessão — leia antes de desenhar qualquer endpoint:

- **`PutawayTaskService.executeTask()`, `PickingTaskService.executeTask()` e `ReplenishmentTaskService.executeTask()` JÁ SÃO idempotentes por `operationId`** (UUID v7 gerado no dispositivo, campo `operationId` no input de cada um). Cada um verifica, ANTES de qualquer efeito colateral, se aquele `operation_id` já foi processado (ex.: `SELECT result FROM wms.putaway_operation WHERE operation_id = $1`) e, se sim, devolve o mesmo resultado (`idempotent_replay: true`). **Isto já implementa a idempotência de RG-009/RF-ARQ-052 no nível da tarefa — COL-2A não precisa reinventá-la, só precisa CHAMAR esses métodos com o `operationId` vindo do dispositivo.**
- **`CheckingService` (T4 Conferência), `StockTransferService` (T6 Transferência) e `InventoryCountExecutionService.submitRound()` (T5 Contagem) NÃO têm essa idempotência ainda** — nenhum dos três aceita/verifica `operationId`. Isto é um requisito NOVO desta sessão: adicionar o mesmo padrão (parâmetro `operationId`, tabela ou coluna de rastreio, checagem antes do efeito) a esses três antes de expô-los pela fila offline — sem isso, um reenvio de rede duplicaria uma contagem, uma avaria ou uma transferência.
- **`wms.sync_operation` (migration `0006`) existe mas seu enum de status (`PENDING`/`IN_PROGRESS`/`SYNCED`/`CONFLICT`/`FAILED`/`EXPIRED`) NÃO corresponde aos nomes de estado da máquina normativa do DOC-01 §5.2** (`LOCAL_PENDENTE`/`ENVIANDO`/`APLICADA`/`DESCARTADA_DUPLICIDADE`/`REJEITADA_TAREFA_INVALIDA`/`REJEITADA_REGRA`). CLAUDE.md exige máquinas de estado explícitas com tabela de transições fiel à especificação — decida nesta sessão se o enum é migrado para os nomes normativos (preferível — evita uma tradução implícita e sujeita a erro entre "o que o banco diz" e "o que a Sessão especifica") ou se mantém os nomes atuais com uma tabela de mapeamento explícita e testada; documente a decisão. `entity_type`/`entity_id`/`entity_data` (JSONB) já servem bem para carregar tipo de tarefa + payload de execução (ex.: `entity_type='PUTAWAY_TASK'`, `entity_id=taskId`, `entity_data=ExecutePutawayInput`); `conflict_resolution` (JSONB) já existe para registrar qual das 4 decisões foi tomada e por quê.
- **`COL.PACOTE_TURNO_MAX` (citado no DOC-15 §7) NÃO foi criado em nenhuma migration** — só `COL.SCAN_TERMINADOR`/`COL.VERSAO_MINIMA`/`COL.FEEDBACK_SONORO` existem (migration `0066`). Precisa ser adicionado (RF-ARQ-051 define o teto em 2.000 tarefas — o parâmetro deve ter esse valor como default).
- **`FieldDeviceService.registerOrTouch()` já recebe `appVersion`** mas não confronta com `COL.VERSAO_MINIMA` nem devolve um sinal de bloqueio — RNF-COL-050 ainda não está implementado, nem no registro nem em nenhum outro lugar.
- **`FieldDeviceService.recordTelemetry()` já grava `last_sync_at`/`battery_pct`**, mas não recebe tamanho de fila nem falhas de leitura por origem (físico/câmera) — RNF-COL-051 está parcial.
- **`MyTasksService.listMyTasks()` (COL-1) lista só putaway+replenishment, sem os dados de produto/endereço/LPN envolvidos** — o Pacote de Turno (RF-ARQ-051) precisa ser mais rico que essa lista: além das tarefas, os DADOS necessários para executá-las 100% offline (produto, endereço, LPN, parâmetros de validação). Decida se o pacote de turno é um endpoint novo que reaproveita as queries de `MyTasksService` e as enriquece, ou se estende o próprio `MyTasksService` — mas não duplique a query de listagem.
- **`wms.picking_task` continua sem coluna/consulta por operador** (mesma lacuna já registrada em COL-1) — T3 Picking no Pacote de Turno herda essa lacuna; se o escopo desta sessão decidir resolvê-la (mudança em `PickingTaskService`), documente como decisão, não como acidente.
- **Nenhum worker/scheduler job existe hoje para o alerta "dispositivo sem contato > 24h com fila > 0"** (RNF-COL-051) — o padrão de alerta já existe para outros casos (tópico `alertas`, ver `AlertService`/`RealtimeGateway`); reaproveite o padrão, não invente um novo canal.

---

## 2. ENTREGÁVEIS DESTA SESSÃO

### 2.1 Migration

1. Resolver o enum de `wms.sync_operation_status` conforme a decisão do §1 (nomes normativos do DOC-01 §5.2 ou mapeamento documentado).
2. Adicionar idempotência por `operationId` a `CheckingService`, `StockTransferService` e `InventoryCountExecutionService.submitRound()` — mesmo padrão de `PutawayTaskService` (tabela ou coluna dedicada, checagem antes do efeito, retorno com `idempotent_replay: true` no replay).
3. Criar `COL.PACOTE_TURNO_MAX` (`app_parameter`, default `2000`, RF-ARQ-051).
4. Grants `wms_worker`/`wms_app` conforme os novos consumidores reais (ADR-006 — não especulativo).

### 2.2 `ShiftPackageService`/`ShiftPackageController` (RF-ARQ-051 — Pacote de Turno)

`GET /campo/pacote-turno` (`COL.OPERAR`): monta o pacote do operador autenticado — tarefas de todos os tipos executáveis offline (T2–T6: putaway, picking, conferência, contagem, transferência/reposição) mais os dados de produto/endereço/LPN necessários para executá-las sem rede, respeitando o teto `COL.PACOTE_TURNO_MAX`. Marca d'água de versão do pacote (para o dispositivo saber se precisa re-sincronizar dados de referência).

### 2.3 `OfflineSyncService`/`OfflineSyncController` (RF-ARQ-052/RN-ARQ-053 — fila e resolução de conflitos)

`POST /campo/sincronizacao` (`COL.OPERAR`): recebe um lote de operações offline do dispositivo (ordem FIFO por `device_id`, cada uma com `operationId`, tipo de tarefa, `taskId`, payload de leituras/medições). Para cada operação, em ordem:

1. Grava/atualiza `wms.sync_operation` com o estado inicial (`LOCAL_PENDENTE`/`ENVIANDO` conforme a decisão do §1);
2. Classifica a situação atual da tarefa no servidor e aplica **exatamente uma** das 4 decisões da RN-ARQ-053 — nenhuma decisão nova, nenhuma aplicação parcial:
   - Tarefa ainda válida → despacha para o service da tarefa (`PutawayTaskService.executeTask`, `PickingTaskService.executeTask`, `CheckingService.*`, `ReplenishmentTaskService.executeTask`, `StockTransferService.*`, `InventoryCountExecutionService.submitRound`, cada um já validando suas próprias regras de negócio) → `APLICADA`;
   - Tarefa já concluída por outro ator (mesmo `operationId` ou mesma tarefa já finalizada) → `DESCARTADA_DUPLICIDADE`, sem efeito, notifica o operador;
   - Tarefa cancelada/reatribuída após o aprovisionamento → `REJEITADA_TAREFA_INVALIDA`, sem efeito, vira pendência de supervisão;
   - Efeito violaria regra de negócio (RG-004/RG-005/RG-014, ex.: saldo insuficiente, endereço bloqueado) → `REJEITADA_REGRA`, sem efeito, vira Divergência (workflow, AD-007);
3. Persiste a decisão em `conflict_resolution` (JSONB) com o motivo, gera log (RG-003) e notifica o operador (mecanismo de tempo real já existente, RF-ARQ-043).

`POST /campo/sincronizacao` DEVE continuar aceitando e processando a fila mesmo que ultrapasse o limite de RNF-ARQ-054 — o bloqueio de novas execuções é do CLIENTE (COL-2B), o servidor nunca recusa sincronizar uma fila existente.

### 2.4 Versão mínima e telemetria (RNF-COL-050/051)

- Estender `FieldDeviceService.registerOrTouch()` (ou criar um endpoint de checagem dedicado) para comparar `appVersion` recebido contra `COL.VERSAO_MINIMA` e devolver um sinal (`versionBlocked: boolean`) — bloqueia novas execuções no cliente, nunca a sincronização da fila existente (mesma regra do Gherkin do DOC-15 §6, cenário "Versão mínima bloqueia execução mas não a sincronização").
- Estender `FieldDeviceService.recordTelemetry()` para aceitar tamanho de fila e falhas de leitura por origem (físico/câmera).
- Job de alerta (scheduler, reaproveitando o padrão de tópico `alertas`): dispositivo com `last_seen_at` > 24h e fila pendente > 0 no `wms.sync_operation`.

### 2.5 Fora de escopo desta sessão (fica para COL-2B, citar no relatório, não implementar)

Toda a interface (`apps/frontend`): IndexedDB do Pacote de Turno, fila local espelhando `sync_operation`, as 5 telas T2–T6, sincronização oportunista no cliente (RF-COL-041), bloqueio client-side por limite de fila (RNF-ARQ-054) e por versão mínima (RNF-COL-050), estado permanente no topo da tela (operador/armazém/zona/conexão/fila).

---

## 3. CENÁRIOS GHERKIN (DOC-15 §6 e DOC-01 §4.6 — só os aplicáveis ao servidor)

```gherkin
Cenário: Decisão 1 — tarefa ainda válida
  Dado uma tarefa de putaway ASSIGNED aprovisionada no Pacote de Turno
  Quando o dispositivo sincronizar a execução offline com o operationId original
  Então a decisão deve ser APLICADA
  E o efeito de estoque deve ser o mesmo de uma execução online

Cenário: Decisão 2 — duplicidade
  Dado uma operação já sincronizada anteriormente com o mesmo operationId
  Quando o dispositivo reenviar a mesma operação (retry de rede)
  Então a decisão deve ser DESCARTADA_DUPLICIDADE
  E nenhum efeito de estoque deve ocorrer uma segunda vez

Cenário: Decisão 3 — tarefa inválida
  Dado uma tarefa de picking que foi cancelada após o aprovisionamento do turno
  Quando o dispositivo sincronizar uma execução offline dessa tarefa
  Então a decisão deve ser REJEITADA_TAREFA_INVALIDA
  E uma pendência de supervisão deve ser criada, sem efeito de estoque

Cenário: Decisão 4 — violação de regra
  Dado uma reposição offline que deixaria o saldo negativo no servidor
  Quando o dispositivo sincronizar essa execução
  Então a decisão deve ser REJEITADA_REGRA
  E uma Divergência deve ser criada (AD-007), sem efeito de estoque

Cenário: Limite de fila não bloqueia sincronização (RNF-ARQ-054)
  Dado um dispositivo com 600 operações pendentes de sincronização
  Quando a conexão retornar e o dispositivo enviar a fila completa
  Então o servidor deve processar as 600 operações normalmente
  E não deve haver nenhuma rejeição pelo simples tamanho da fila

Cenário: Versão mínima bloqueia execução mas não sincronização
  Dado COL.VERSAO_MINIMA = "1.2.0" e um dispositivo reportando versão "1.0.0"
  Quando o dispositivo checar o gate de versão
  Então o servidor deve sinalizar bloqueio de novas execuções
  E a sincronização da fila existente deve continuar permitida
```

---

## 4. TESTES

Integração real (Postgres), 2 execuções consecutivas: as 4 decisões da RN-ARQ-053 (uma por cenário acima, para pelo menos 2 tipos de tarefa diferentes — ex.: putaway e reposição), idempotência de `operationId` nos 3 services que ganharam o padrão nesta sessão (reenvio não duplica efeito), Pacote de Turno respeitando `COL.PACOTE_TURNO_MAX`, gate de versão mínima, telemetria com tamanho de fila.

---

## 5. DEFINITION OF DONE

```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções
curl localhost:3000/health/ready
git commit && git push   # inclui este prompt
```

Relatório em `docs/relatorios/SESSAO-COL2A-relatorio.md`: matriz requisito → arquivo → teste, saída real dos comandos, decisão tomada sobre o enum de `sync_operation_status` (com justificativa), lacunas/débitos (citar explicitamente `picking_task` sem coluna de operador, se não resolvida nesta sessão).

---

## 6. PRÓXIMO PASSO

Após COL-2A: **Sessão COL-2B** — IndexedDB do Pacote de Turno e da fila local, as 5 telas de execução T2–T6 (reaproveitando `useWedgeScanner`/`useCameraScanner`/`scanner.ts` da COL-1), sincronização oportunista (RF-COL-041), bloqueio client-side por limite de fila e por versão mínima, estado permanente no topo da tela. COL-2B fecha o débito declarado nas auditorias como "PWA — Session 3" (DOC-15 §10).
