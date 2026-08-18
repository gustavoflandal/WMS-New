# HANDOFF EM ANDAMENTO — Sessão 5A: DOC-05 Parte 1 (Movimentações, Bloqueios, Transferências, Kanban)

**Status (retomada, 2026-08-18): CONCLUÍDA — todos os 7 entregáveis implementados e verificados.** `pnpm build` limpo; unit 11/11 arquivos (107/107 testes); integração 55/55 arquivos (171/171 testes) em 2 execuções consecutivas; `docker compose up -d --build` com os 3 papéis do backend `healthy`; `curl localhost:3000/health/ready` → `200`. Relatório completo em `docs/relatorios/SESSAO-5A-relatorio.md`. Nenhum commit foi feito ainda (aguardando confirmação explícita do usuário, padrão de todas as sessões). Este documento fica preservado como histórico da sessão (decisões/achados da primeira metade, antes da pausa) — o relatório final é a fonte de verdade sobre o estado concluído.

**Resumo do que foi adicionado nesta retomada** (detalhes completos abaixo, seção "Retomada 2026-08-18"):
- Entregável 1 (parte pendente): 13 eventos `estoque.*` em `packages/contracts/src/realtime-topics.ts` — feito.
- Entregável 3 (RF-EST-030/031): bloqueio/desbloqueio manual + reclassificação de avaria + descarte (exceção EST.DESCARTE_SALDO, 2 passos) — migration 0046, `modules/estoque/blocking/*`.
- Entregável 4 (RN-EST-014): job diário de alerta de vencimento + bloqueio automático — `modules/estoque/expiration/*`, `workers/expiration-alert.worker.impl.ts`.
- Entregável 5 (RF-EST-040/041/042): estoque de segurança (dedup por cruzamento de limiar) + kanban + reposição (tarefa dirigida, dupla leitura, idempotência) — migration 0047, `modules/estoque/replenishment/*`, `workers/replenishment-alert.worker.impl.ts`.
- Entregável 6 (RF-EST-050/051/RN-EST-052): transferência interna (imediata, Fase 1 no destino) + transferência entre armazéns (§5.2 completo) — migration 0048, `modules/estoque/transfer/*`. Exigiu extrair `PutawayEngineService.evaluateSingleLocationForProduct()` (refactor não-destrutivo, testado) para reusar a Fase 1 sem palete formal.
- **Bug real corrigido**: `wms.stock_balance_unique` não tinha `NULLS NOT DISTINCT` — UPSERTs (`ON CONFLICT`) para o mesmo produto/endereço sem lote/palete NUNCA batiam contra a linha existente (Postgres trata NULL≠NULL em UNIQUE por padrão), duplicando linhas de saldo silenciosamente. Corrigido na migration 0046. Achado pelo teste de RF-EST-030 (bloqueio seguido de desbloqueio no mesmo endereço).
- Vários grants ADR-006/`wms_worker` novos (batch, product, product_species, location, stock_balance, stock_movement incl. partições, product_warehouse_parameter, replenishment_task incl. partições) — necessários para os novos jobs cross-tenant.

**Antes de retomar**: leia este documento inteiro. Ele reflete o estado REAL verificado (não aspiracional) no momento da pausa.

---

## 1. Missão (resumo)

Implementar o DOC-05 (Estoque/Movimentação) EXCETO Seleção de Saldo (RN-EST-010/011/012/013 — Sessão 5B, PREMIUM) e Inventários §4.7 (Sessão 5C). Contexto autorizado: `docs/DOC-00-documento-mestre.md`, `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-4B-relatorio.md` — nenhum outro documento.

**Regras vigentes** (idênticas às sessões anteriores): citar §/ID do DOC-05 em toda tabela/coluna/enum/permissão/exceção/evento; `[LACUNA: ...]` em vez de inventar; `[DÉBITO: descrição + sessão-alvo]` para dificuldade técnica (débito que bloqueia o DoD não pode ser adiado); proibido `USING(true)`, optional chaining escondendo DI, `.skip`, mock de Postgres/Redis em integração, enfraquecer regra `[INVIOLÁVEL]`, declarar ✅ sem saída real; proibido remover/mover/renomear arquivo fora do escopo sem confirmação explícita; herdar padrões estabelecidos (actor_user_id do JWT, auditoria before+after, RN-SEG-012 permissão-por-rota, máquinas de estado explícitas, eventos via outbox transacional, leitura cross-tenant só via SECURITY DEFINER de exposição mínima).

**7 entregáveis da missão** (texto completo já recebido do usuário nesta conversa, não reproduzido aqui por extenso — resumo):
1. Catálogo central: 8 permissões `EST.*` (§3), 4 `exception_type` `EST.*` (§3), 13 eventos `estoque.*` (§4.8).
2. **RN-EST-001 [INVIOLÁVEL] — O NÚCLEO**: catálogo fechado de 18 `movement_type` (não 16 — recontagem feita nesta sessão, ver §3 abaixo), cada um com efeito EXATO nas parcelas de `stock_balance`; um ÚNICO serviço é o único caminho para alterar `stock_balance`, "proibido por construção".
3. Bloqueios/reclassificações (§4.4): RF-EST-030 (bloqueio/desbloqueio com motivo tipificado), RF-EST-031 (avaria + descarte via exceção 2 passos).
4. RN-EST-014: job diário de alerta de vencimento (90/60/30/15/0 dias) + bloqueio automático de saldo vencido, idempotente.
5. RF-EST-040/041/042: estoque de segurança (alerta só na travessia do limiar) + kanban (uma única reposição por produto×endereço) + reposição (tarefa dirigida com dupla leitura).
6. Transferências (§4.6): RF-EST-050 (interna, reusando os filtros Fase 1 do motor de putaway da 4B), RF-EST-051 (interarmazém, TRF com `in_transit`), RN-EST-052 (RG-015 no destino).
7. Testes de integração reais cobrindo tudo acima + regressão completa de todas as suítes anteriores verde.

**DoD**: `docker compose up -d --build`; `pnpm build && pnpm test && pnpm test:integration` (2 execuções consecutivas); `curl localhost:3000/health/ready`; `docs/relatorios/SESSAO-5A-relatorio.md`; commit/push só com confirmação explícita do usuário.

---

## 2. O que está PRONTO E VERIFICADO

### Entregável 1 — Catálogo central (COMPLETO)

- **`infra/postgres/migrations/0044-estoque-catalogo.sql`** (NOVA, não commitada): 8 permissões `EST.*` (§3, valores exatos) + grants a papéis semente (`GESTOR_ARMAZEM` acumula as sensíveis/supervisão; `LIDER_TURNO`+`GESTOR_ARMAZEM` ganham `EST.TRANSFERIR_INTERNO`; `INVENTARIANTE` ganha `EST.INVENTARIO_CONTAR` — `[LACUNA]` documentada no arquivo: DOC-05 não nomeia o papel-alvo, é inferência desta sessão); correção idempotente de `EST.QUEBRA_FEFO` (placeholder da Sessão 3/migration 0018 era 2 passos/24h — corrigido para 1 passo/8h, valor real do §3); 3 novos `exception_type` (`EST.AJUSTE_INVENTARIO`, `EST.DESCARTE_SALDO`, `EST.TRANSBORDO_ARMAZEM_LOGICO`); `wms.stock_block_reason` (RD-EST-004, catálogo GLOBAL, 5 motivos tipificados).
- **`apps/backend/src/core/workflow/__tests__/two-step-distinct-approvers.integration.spec.ts`** — migrado de `EST.QUEBRA_FEFO` (agora 1 passo, quebraria o teste) para `EST.DESCARTE_SALDO` (2 passos de verdade). **Verificado passando.**
- Eventos `estoque.*` em `packages/contracts/src/realtime-topics.ts` — **AINDA NÃO FEITO** (fica para a próxima retomada, ver §5).

### Entregável 2 — RN-EST-001, o núcleo (PARCIAL — mecânica pronta, integração com módulos futuros pendente)

- **`infra/postgres/migrations/0045-estoque-movimento-core.sql`** (NOVA, não commitada): CHECK fechado de `movement_type` (18 valores — a tabela §4.1 tem 14 linhas mas algumas juntam 2 códigos, ex. "RESERVA / LIBERACAO_RESERVA"; a contagem de "16" do prompt original da sessão estava ERRADA, recontada e corrigida para 18 ao ler o documento de novo); colunas `policy_break`/`break_reason` em `stock_movement` (RD-EST-005); trigger de guarda `wms.guard_stock_balance_direct_write` em `wms.stock_balance` (BEFORE INSERT/UPDATE, rejeita com `ERRCODE 42501` a menos que `current_setting('app.stock_movement_authorized') = 'true'` tenha sido setado na MESMA transação — só `StockMovementService.apply()` faz isso).
- **`apps/backend/src/modules/estoque/movement/stock-movement-effects.util.ts`** (NOVO) — função PURA `resolveMovementBucketEffect(movementType, override)`, catálogo fechado `MOVEMENT_TYPES` (18), mapeamento bucket→coluna. Testado em `__tests__/stock-movement-effects.util.spec.ts` (17 testes, **passando**) — cobre os 18 tipos.
- **`apps/backend/src/modules/estoque/movement/stock-movement.service.ts`** (NOVO) — `StockMovementService.apply(client, params)` (dentro de transação aberta, mesmo contrato de `EventsService.publishInTransaction`) e `.applyStandalone(ctx, params)` (abre a própria transação). Débito com revalidação de RG-004 no nível da app (`UPDATE ... WHERE qty_bucket >= $qty`, 0 linhas = `BadRequestException INSUFFICIENT_BALANCE`); crédito via UPSERT (mesmo padrão que já existia em `putaway-task.service.ts`); grava sempre `stock_movement`. Caso especial `TRANSFERENCIA_ENTRADA_ARMAZEM`: dois armazéns, duas linhas de `stock_movement` (débito do `in_transit` na origem + crédito no destino).
- **`apps/backend/src/modules/estoque/estoque.module.ts`** — de stub vazio para módulo real (`DatabaseModule` import, `StockMovementService` provider+export).
- **`apps/backend/src/modules/recebimento/putaway/putaway-task.service.ts`** — `executeTask()` refatorado: a escrita direta de `stock_balance`/`stock_movement` foi substituída por UMA chamada a `stockMovementService.apply(client, {movementType:'PUTAWAY', ...})`. **`recebimento.module.ts`** ganhou `StockMovementService` como provider reinstanciado (mesmo padrão de `DocumentNumberingService` etc.).

**Decisão de design importante (documentada em comentário no código, não re-derivar)**: PUTAWAY/TRANSFERENCIA_INTERNA/REPOSICAO são "mesma parcela, move de endereço" pelo texto do DOC-05, mas o débito só acontece quando o chamador informa uma origem (`locationIdFrom`/`palletIdFrom`). Sem origem — que é o caso REAL de `putaway-task.service.ts` hoje, já que nenhum módulo credita um saldo de "doca"/staging antes do putaway — o efeito é um crédito puro no destino, preservando o `movement_type` documental mesmo sem débito para casar. Isso NÃO é um desvio silencioso: está comentado em `stock-movement.service.ts` como `[LACUNA]` justificada.

**`requirement_id` de `stock_movement` é UUID, não texto** (migration 0014) — cuidado ao chamar `StockMovementService.apply()` daqui pra frente: nunca passar uma citação tipo `"DOC-05 RF-EST-030"` nesse campo (já documentado como comentário no `ApplyMovementParams`).

### Testes ajustados por causa do trigger de guarda (RN-EST-001) — TODOS verificados passando

O trigger novo derruba QUALQUER INSERT/UPDATE cru em `stock_balance` que não "assine" `app.stock_movement_authorized` primeiro. 6 arquivos de teste pré-existentes (Sessão 2B/4A/4B) faziam INSERTs crus em `stock_balance` como fixture ou como prova de CHECK — todos corrigidos para abrir uma transação e rodar `SELECT set_config('app.stock_movement_authorized', 'true', true)` antes do INSERT cru (preserva a intenção original do teste — provar RG-004/RN-DAD-020/o próprio conteúdo — sem testar o trigger novo, que tem seu próprio teste dedicado ainda por escrever, ver §5):

- `apps/backend/src/modules/cadastro/__tests__/test-helpers.ts` — novo helper exportado `rawAuthorizedQuery(databaseService, ctx, sql, params)`.
- `apps/backend/src/modules/cadastro/__tests__/stock-balance-constraints.integration.spec.ts` (usa o helper).
- `apps/backend/src/modules/cadastro/__tests__/species-batch-validation.integration.spec.ts` (usa o helper).
- `apps/backend/src/modules/cadastro/__tests__/uom-conversion.integration.spec.ts` (usa o helper).
- `apps/backend/src/modules/cadastro/__tests__/stock-movement-append-only.integration.spec.ts` — **não precisava do helper** (guarda é só em `stock_balance`, não `stock_movement`), mas seu INSERT de setup usava `movement_type = 'RECEIVING_CREDIT'`, um placeholder pré-CHECK — corrigido para `'ENTRADA_RECEBIMENTO'` (valor real do catálogo fechado).
- `apps/backend/src/modules/recebimento/__tests__/putaway-engine.integration.spec.ts` — 2 fixtures cruas de ocupação (`db.transaction` + `set_config` inline, arquivo de outro módulo, não usa o helper de `cadastro/__tests__`).
- `apps/backend/src/modules/recebimento/__tests__/putaway-task.integration.spec.ts` — só precisou adicionar `StockMovementService` na instanciação manual do `PutawayTaskService` (novo parâmetro de construtor).

### Verificações rodadas com sucesso (saída real confirmada)

- `npx tsc --noEmit` — **limpo, 0 erros** (depois de corrigir um erro de exaustividade do `switch` em `stock-movement-effects.util.ts` — os 3 casos "mesma parcela" precisaram virar `case` explícitos dentro do switch, não um `if` antes dele, para o TS provar exaustividade).
- `npx vitest run` (suíte unit completa) — **107/107 passando** (90 herdados da 4B + 17 novos de `stock-movement-effects.util.spec.ts`).
- `npx vitest run --config vitest.config.integration.ts` nos arquivos afetados, rodado em 2 lotes:
  - Lote 1 (os 4 arquivos de `cadastro/__tests__` corrigidos): **4/4 arquivos, 11/11 testes.**
  - Lote 2 (todo `src/modules/recebimento` + os 2 specs de RN-SEG-043 em `core/workflow/__tests__`): primeira rodada achou 2 falhas reais em `putaway-engine.integration.spec.ts` (fixtures cruas de ocupação, mesmo problema do trigger novo) — corrigidas; segunda rodada: **8/8 arquivos, 48/48 testes.**
- **NÃO RODADO ainda**: a suíte de integração COMPLETA (todos os módulos: `cadastro`, `portaria`, `seguranca`, `workers`, etc.) — a sessão foi pausada exatamente no meio desse comando de checkpoint. É o próximo passo antes de qualquer outra coisa (ver §6).

---

## 3. Achados/decisões desta sessão (NÃO re-derivar, já documentadas nos comentários dos arquivos, resumidas aqui)

1. **18 movement_type, não 16.** O prompt original da missão dizia "16"; a leitura direta do DOC-05 §4.1 (14 linhas da tabela, algumas com 2 códigos cada) dá 18 códigos distintos. Confirmado por teste (`MOVEMENT_TYPES.length === 18`).
2. **Guarda de `stock_balance` é um trigger condicionado a session var, não um `REVOKE`.** Diferente do padrão já usado em `stock_movement` (REVOKE UPDATE/DELETE — a tabela é append-only, a operação proibida é FIXA). Aqui INSERT/UPDATE continuam tecnicamente possíveis (o `StockMovementService` PRECISA conseguir escrever), então o mecanismo tem que ser condicional: `set_config('app.stock_movement_authorized', 'true', true)` (LOCAL — expira sozinho no fim da transação) chamado só dentro de `StockMovementService.apply()`. `ERRCODE 42501` escolhido por analogia com o REVOKE já existente.
3. **Permissão EST.* por papel é `[LACUNA]` desta sessão** — DOC-05 §3 não nomeia o papel-alvo (diferente de partes do DOC-04 §3). Atribuição feita por analogia categórica com as migrations 0016/0043 (documentado no comentário da migration 0044).
4. **8 permissões distintas, não 7** — a tabela §3 tem 7 LINHAS, mas a linha `EST.BLOQUEAR_SALDO / EST.DESBLOQUEAR_SALDO` contém 2 códigos. Implementados os 8.
5. **Não implementado ainda**: a parte "(2 acima da alçada)" de `EST.AJUSTE_INVENTARIO` — o catálogo foi inserido com `default_steps=1` fixo; a escalada condicional para 2 passos quando acima da alçada fica documentada como `[LACUNA]` no comentário da migration 0044 (usa o mecanismo genérico de `approval_authority.max_qty/max_value` já existente, sem campo novo de "passos dinâmicos" — não é um bug, é uma limitação assumida e citada).

---

## 4. O que NÃO foi começado

- **Entregável 1, parte pendente**: os 13 eventos `estoque.*` (§4.8) em `packages/contracts/src/realtime-topics.ts`. Mapeamento já rascunhado mentalmente (não escrito): `saldo_alterado`→`INVENTORY_CHANGED`, `transferencia_criada/concluida`→`OPERATIONS_PENDING`, `reposicao_gerada`→`OPERATIONS_PENDING`, `kanban_disparado`→`OPERATIONS_PENDING`, `estoque_seguranca_violado`→`ALERTS`, `lote_a_vencer`→`ALERTS`, `lote_vencido_bloqueado`→`ALERTS`, `inventario_iniciado`→`OPERATIONS_PENDING`, `endereco_contado`→`OPERATIONS_PENDING`, `ajuste_aplicado`→`INVENTORY_CHANGED`, `inventario_concluido`→`OPERATIONS_PENDING`, `descarte_efetivado`→`ALERTS`.
- **Entregável 2, teste dedicado do trigger de guarda** — ainda não existe um teste de integração que prove "escrita direta em stock_balance fora do serviço é impossível/rejeitada" como caso de teste PRÓPRIO (só foi provado indiretamente ao corrigir os fixtures que agora precisam do `set_config`). Precisa de 1 teste explícito.
- **Entregável 2, teste do efeito real via `StockMovementService` contra Postgres de verdade** (o `stock-movement-effects.util.spec.ts` só testa a função PURA, sem banco) — falta o teste de integração parametrizado que exercita `StockMovementService.apply()` de fato para os 18 tipos e confere o saldo resultante em `stock_balance`.
- **Entregável 3 completo**: RF-EST-030 (bloqueio/desbloqueio manual com motivo tipificado) e RF-EST-031 (reclassificação para avaria com fotos + descarte via `EST.DESCARTE_SALDO`) — nenhum arquivo criado ainda. Precisa também garantir que blocked/damaged/quarantine NUNCA entrem em "Seleção de Saldo" — como a Seleção de Saldo em si é 5B, isso vira só uma nota/contrato para a 5B usar.
- **Entregável 4 completo**: job `RN-EST-014` (scheduler, alerta 90/60/30/15/0 dias + bloqueio automático idempotente) — nenhum arquivo criado. Modelo a seguir: `apps/backend/src/workers/exception-expiry.worker.impl.ts` (leitura completa já feita nesta sessão, guardada no contexto) — mesmo padrão de lock Redis via `CacheService.acquireLock/releaseLock` e registro em `main.ts` no role `scheduler`.
- **Entregável 5 completo**: RF-EST-040 (estoque de segurança, alerta só na travessia do limiar — vai precisar de uma coluna/tabela de dedup, o precedente de `CrossDockAgingWorkerImpl` NÃO tem essa dedup e foi identificado como não-reaproveitável nesse aspecto), RF-EST-041/042 (kanban + reposição, `StockSelectionPort` com implementação FIFO simples provisória marcada `[DÉBITO: 5B substitui]`) — nada criado.
- **Entregável 6 completo**: RF-EST-050 (transferência interna, reusando `PutawayEngineService.evaluateSingleLocation` — mas essa função espera um `palletId` com `pallet_content`; para transferência SEM palete formal vai precisar de um método novo tipo `evaluateSingleLocationForProduct`, ainda não escrito) e RF-EST-051/RN-EST-052 (interarmazém, `stock_transfer`/`stock_transfer_item`, RD-EST-001 — nenhuma migration escrita ainda; vinculação com `InboundOrderService` no destino como "Ordem de Recebimento vinculada" precisa de escopo decidido — ver nota abaixo).
- **`replenishment_task`** (RD-EST-002, TENANT particionada como task) — nenhuma migration escrita. Modelo a seguir: `infra/postgres/migrations/0039-recebimento-putaway-task.sql` (particionamento mensal, mesmo padrão de `ensure_putaway_task_partition`).
- **Entregável 7**: nenhum teste de integração específico do módulo `estoque` (bloqueio, expiração, kanban, transferência) foi escrito. A regressão completa (suite inteira) ainda não foi rodada nesta sessão.
- **DoD**: nada disso foi feito — `docker compose up -d --build`, `curl health/ready`, `docs/relatorios/SESSAO-5A-relatorio.md`, commit/push.

### Nota de escopo a decidir na retomada (não decidido ainda)

RF-EST-051 pede "recebimento no destino como Ordem de Recebimento vinculada (conferência obrigatória)". Fazer a integração REAL e completa com `InboundOrderService`/`CheckingService` (DOC-04) é uma escolha de escopo grande — pode valer a pena registrar como `[LACUNA]`/`[DÉBITO]` parcial (implementar o crédito/débito real via `StockMovementService`, e só REGISTRAR a pendência de vínculo pleno com o fluxo de conferência do DOC-04, em vez de reconstruir o checking completo para um TRF). Avaliar com calma na retomada, não decidir apressado.

---

## 5. Arquivos criados/modificados nesta sessão (nenhum commitado)

**Novos:**
- `infra/postgres/migrations/0044-estoque-catalogo.sql`
- `infra/postgres/migrations/0045-estoque-movimento-core.sql`
- `apps/backend/src/modules/estoque/movement/stock-movement-effects.util.ts`
- `apps/backend/src/modules/estoque/movement/stock-movement.service.ts`
- `apps/backend/src/modules/estoque/movement/__tests__/stock-movement-effects.util.spec.ts`
- `docs/relatorios/SESSAO-5A-HANDOFF-EM-ANDAMENTO.md` (este arquivo)

**Modificados:**
- `apps/backend/src/modules/estoque/estoque.module.ts`
- `apps/backend/src/modules/recebimento/putaway/putaway-task.service.ts`
- `apps/backend/src/modules/recebimento/recebimento.module.ts`
- `apps/backend/src/modules/recebimento/__tests__/putaway-task.integration.spec.ts`
- `apps/backend/src/modules/recebimento/__tests__/putaway-engine.integration.spec.ts`
- `apps/backend/src/core/workflow/__tests__/two-step-distinct-approvers.integration.spec.ts`
- `apps/backend/src/modules/cadastro/__tests__/test-helpers.ts`
- `apps/backend/src/modules/cadastro/__tests__/stock-balance-constraints.integration.spec.ts`
- `apps/backend/src/modules/cadastro/__tests__/species-batch-validation.integration.spec.ts`
- `apps/backend/src/modules/cadastro/__tests__/uom-conversion.integration.spec.ts`
- `apps/backend/src/modules/cadastro/__tests__/stock-movement-append-only.integration.spec.ts`

**Infra de teste**: `infra/docker-compose.test.yml` estava de pé (postgres-test/redis-test/minio-test healthy) no momento da pausa — pode já ter sido derrubada desde então, confirmar com `docker ps` antes de rodar testes de novo.

---

## 6. Como retomar

1. Ler este documento inteiro (feito, se você chegou até aqui).
2. `git status` — confirmar que os arquivos listados em §5 ainda estão como deixados (nenhum commit foi feito).
3. Subir a infra de teste: `docker compose -f infra/docker-compose.test.yml up -d --wait postgres-test redis-test minio-test && docker compose -f infra/docker-compose.test.yml run --rm minio-test-init`.
4. Rodar a suíte de integração COMPLETA (é exatamente onde a sessão parou): `cd apps/backend && npx vitest run --config vitest.config.integration.ts` — usar `rtk proxy` na frente do comando se o wrapper RTK estiver truncando a saída (aconteceu nesta sessão; `rtk proxy npx vitest ...` devolve a saída completa). Redirecionar para um arquivo em vez de confiar no `tail` do terminal, e usar Grep/Read no arquivo — a saída de `vitest` com todos os módulos é grande.
5. Se tudo verde: seguir para o Entregável 1 pendente (eventos `estoque.*` em `realtime-topics.ts`) e depois os Entregáveis 3–7 na ordem da missão, usando os modelos já identificados em §4 (workers de scheduler, `putaway_task` como modelo de tabela particionada, `PutawayEngineService.evaluateSingleLocation` para reuso de filtros).
6. Se algo quebrar: é quase certo que seja mais algum INSERT cru pré-existente em `stock_balance` que o grep desta sessão não pegou — procurar com `grep -rn "INSERT INTO wms.stock_balance\|UPDATE wms.stock_balance" apps/backend/src` e aplicar o mesmo padrão de `set_config('app.stock_movement_authorized', 'true', true)` dentro de uma transação.
7. Commit/push só com confirmação explícita do usuário (padrão de todas as sessões anteriores).
