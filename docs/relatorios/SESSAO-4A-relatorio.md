# Relatório — Sessão 4A: DOC-04 Recebimento e Docas (sem motor de putaway)

**Data**: 2026-08-17 (sessão iniciada e interrompida em 2026-08-16, retomada e concluída em 2026-08-17 — ver `docs/relatorios/SESSAO-4A-HANDOFF-EM-ANDAMENTO.md` para o histórico completo passo a passo desta retomada, incluindo cada bug encontrado no momento em que foi encontrado)
**Escopo**: DOC-04 completo exceto o motor de putaway (RN-REC-040/041/042 — Fase 1 filtros + Fase 2 ranqueamento — fica para a Sessão 4B). Docas, Ordem de Recebimento (ASN/XML/manual), conferência cega com recontagem, as 5 divergências (FALTA/SOBRA/AVARIA/TROCA + recusa total) com seus workflows, etiquetagem/LPN, quarentena por espécie, cross-docking.

---

## 1. Resumo executivo

Todos os entregáveis da missão (item 0 a 9 do prompt da sessão) foram implementados e testados. `pnpm build`, `pnpm test` e `pnpm test:integration` estão **verdes**: build limpo, unit **8/8 arquivos, 44/44 testes**, integração **48/48 arquivos, 121/121 testes**, ambos verificados em **2 execuções consecutivas**. `docker compose up -d --build` (dev) sobe os 3 papéis de backend (`api`/`worker`/`scheduler`) todos `healthy`, e `curl localhost:3000/health/ready` responde `200 {"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}`.

A sessão foi interrompida uma vez a pedido do usuário (registro em memória + handoff, ver `SESSAO-4A-HANDOFF-EM-ANDAMENTO.md`) com o item 0 (isolamento de infraestrutura de teste) completo mas nenhum service de negócio ainda escrito. Na retomada, **10 bugs reais foram encontrados e corrigidos** — nenhum hipotético, todos descobertos ao efetivamente rodar código contra Postgres/Redis/MinIO reais pela primeira vez (a maior parte do código da interrupção nunca tinha sido compilada nem testada). Lista completa na §5.

---

## 2. Matriz requisito → arquivo → teste

| Entregável DOC-04 | Arquivos principais | Teste(s) |
|---|---|---|
| 0. Isolamento da infra de teste | `infra/docker-compose.test.yml`, `.env.test`/`.env.test.example`, `apps/backend/test-setup.ts`, `apps/backend/src/core/database/__tests__/test-setup.helper.ts`, `apps/backend/package.json` (`pretest:integration`) | Critério do item 0: `pnpm test:integration` 2x consecutivas verdes com o compose de dev ativo — verificado repetidamente ao longo da sessão |
| 1. Catálogos (6 permissões `REC.*`, 6 `exception_type`, 11+2 eventos `recebimento.*`) | `infra/postgres/migrations/0033-recebimento-catalog.sql`, `packages/contracts/src/realtime-topics.ts` | Exercitado por todos os testes de integração de Recebimento (grants/exceções/eventos reais) |
| 2. Migrations §7 RD-REC-001..006 (+ ajustes) | `0034`–`0042` (operation_flow genérico, inbound_order/item, inbound_invoice, checking/checking_item, discrepancy, putaway_task estrutura, crossdock_link, dock_zone_distance, pallet/pallet_content↔inbound_order link) | `core/database/__tests__/rls.integration.spec.ts` (regressão RLS geral); isolamento por tenant exercitado em todos os testes de cenário abaixo |
| 3. Docas (RN-REC-001, RF-REC-002/003) | `modules/recebimento/dock/dock.service.ts`, `.controller.ts` | **Nenhum teste de integração dedicado** — código herdado da interrupção, nunca compilado até esta retomada; compila e o boot real da aplicação resolve toda a árvore de DI, mas `dockVehicle()`/`releaseDock()`/`suggestDock()` não têm cenário de teste próprio. Gap documentado — não é um dos 7 cenários Gherkin exigidos pelo §6, mas fica registrado para a próxima sessão. Ver observação sobre `ATRACACAO_REGISTRADA` na §6 deste relatório |
| 4. Ordem de Recebimento e ASN (RF-REC-010, RN-REC-011/012) | `modules/recebimento/inbound-order/inbound-order.service.ts`, `.controller.ts`, `modules/recebimento/shared/nfe-xml.util.ts` | `modules/recebimento/__tests__/inbound-order.integration.spec.ts` (9 testes: XML casado por SKU/EAN, SEM_CADASTRO, idempotência de NF-e, ASN pré-chegada, manual, produto inexistente, cancelamento, RN-REC-023/RECUSA_TOTAL) |
| 5. Fluxo Operacional (RF-REC-020, RG-002) | `core/operation-flow/operation-flow.service.ts` (genérico, reaproveitável) + instanciado por `InboundOrderService`/`CheckingService` | Verificado dentro de `inbound-order.integration.spec.ts` (CHEGADA DONE + demais PENDING na criação) e `checking.integration.spec.ts` (conclusão de DOCA/DESCARGA/CONFERENCIA) |
| 6. Conferência e divergências (RF-REC-021/024, RN-REC-022/023 [INVIOLÁVEL]) | `modules/recebimento/checking/checking.service.ts`, `.controller.ts` | `modules/recebimento/__tests__/checking.integration.spec.ts` (7 testes: sem divergência, FALTA completo com recontagem+decisão, SOBRA com destino, AVARIA com/sem foto, RF-REC-024 fechar/rejeitar, `forced_same_conferente`) |
| 6b. `REC.RECUSA_TOTAL` (RN-REC-023, 2 aprovadores) | `InboundOrderService.requestTotalRefusal`/`applyTotalRefusalDecision` | Incluído em `inbound-order.integration.spec.ts` (2 aprovadores distintos, RN-SEG-043) |
| 7. Etiquetagem e quarentena (RF-REC-030, RN-REC-031) | `modules/recebimento/labeling/labeling.service.ts`, `.controller.ts` | `modules/recebimento/__tests__/labeling.integration.spec.ts` (5 testes: palete simples+LPN+progresso, quantidade excedente, palete misto permitido/negado, quarentena nasce/libera, estado inválido) |
| 8. Cross-docking (RN-REC-050, RF-REC-051, RNF-REC-052) | `modules/recebimento/crossdock/crossdock.service.ts`, `.controller.ts`, `workers/crossdock-aging.worker.impl.ts` | `modules/recebimento/__tests__/crossdock.integration.spec.ts` (5 testes: pula o picking, elegibilidade antes/depois da conferência, limite de quantidade, cancelamento, alerta RNF-REC-052) |
| 9. Testes dos cenários §6 + regressão | ver acima | **7/7 cenários em escopo cobertos** (2 de putaway ficam de fora, confirmado fora de escopo) — ver lista abaixo |

**7 cenários Gherkin DOC-04 §6 em escopo — todos com cobertura equivalente**:
1. Conferência cega com divergência de falta → `checking.integration.spec.ts`
2. Falta aprovada ajusta a ordem → mesmo teste acima (fluxo completo)
3. Sobra recebida como bloqueada → `checking.integration.spec.ts`
4. Avaria exige foto → `checking.integration.spec.ts`
5. Medicamento entra em quarentena → `labeling.integration.spec.ts` (nasce QUARANTINE → libera RELEASED; a asserção do MOTOR de putaway do cenário original — "deve sugerir apenas endereços QUARANTINE" — não é replicada, depende de RN-REC-040, explicitamente 4B)
6. Cross-docking pula o picking → `crossdock.integration.spec.ts` (paletização em zona CROSS_DOCKING; "saldo com reserva"/"Pedido pula Picking" ficam `[LACUNA: DOC-05/DOC-06]`, documentado no próprio teste)
7. Cancelamento do pedido desfaz o cross-docking → `crossdock.integration.spec.ts` (reserva desfeita; geração de tarefas de putaway normal fica `[DÉBITO: 4B]`)

**Totais finais**: unitário backend **8/8 arquivos, 44/44 testes** · integração **48/48 arquivos, 121/121 testes, 100% verde, 2 execuções consecutivas**.

---

## 3. Migrations desta sessão (0033–0042)

| # | Arquivo | Conteúdo |
|---|---|---|
| 0033 | `0033-recebimento-catalog.sql` | 6 permissões `REC.*` + grants; 6 `exception_type`; `app_parameter` (`REC.PERMITE_PALETE_MISTO`, `REC.QUARENTENA_ESPECIES`, `REC.CROSSDOCK_TEMPO_MAX_H`) |
| 0034 | `0034-operation-flow.sql` | `wms.operation_flow` + `wms.flow_step` (TENANT, RLS) — núcleo genérico reutilizável (DOC-00 §4.5), não específico de recebimento |
| 0035 | `0035-recebimento-inbound-order.sql` | `inbound_order` + `inbound_order_item` (TENANT, RLS) — máquina de estados §5.1 completa |
| 0036 | `0036-recebimento-inbound-invoice.sql` | `inbound_invoice` (TENANT, RLS) |
| 0037 | `0037-recebimento-checking.sql` | `checking` + `checking_item` (TENANT, RLS) — contagem por `round` (sem teto de 2, ver §5 item 6), `forced_same_conferente` |
| 0038 | `0038-recebimento-discrepancy.sql` | `discrepancy` (TENANT, RLS) — CHECK de foto obrigatória para AVARIA via `cardinality()` (ver §5 item 5) |
| 0039 | `0039-recebimento-putaway-task.sql` | `putaway_task` (TENANT, RLS, particionada RNF-ARQ-090) — ESTRUTURA APENAS, geração é 4B |
| 0040 | `0040-recebimento-crossdock-link.sql` | `crossdock_link` (TENANT, RLS) |
| 0041 | `0041-recebimento-dock-zone-distance.sql` | `dock_zone_distance` (GLOBAL, sem RLS) — matriz `REC.MAPA_DISTANCIA_DOCA_ZONA` |
| 0042 | `0042-recebimento-pallet-order-link.sql` | `ALTER TABLE` em `wms.pallet`/`wms.pallet_content` (migration 0012, **já commitada** na Sessão 2B) — adiciona `inbound_order_id`/`inbound_order_item_id`, necessário para RF-REC-030 rastrear "quantidade restante a paletizar" |

Todas aplicadas e verificadas via `pnpm test:integration` (test-setup.ts roda o runner de migrations do zero a cada execução) e via o boot real dos 3 containers de dev (`MigrationRunner` de produção, com o fix de concorrência da §5 item 10).

---

## 4. Catálogo de permissões, exceções e eventos

**6 permissões `REC.*`** (DOC-04 §3): `ATRACAR`, `LIBERAR_DOCA` (WAREHOUSE); `CONFERIR`, `RECONTAR`, `ENCERRAR_CONFERENCIA` (CLIENT_WAREHOUSE); `LIBERAR_QUARENTENA`, `CANCELAR_RECEBIMENTO` (CLIENT_WAREHOUSE, sensíveis).

**Concessões aos papéis semente**: `LIDER_TURNO` → `ATRACAR`/`LIBERAR_DOCA`/`ENCERRAR_CONFERENCIA`; `CONFERENTE` → `CONFERIR`/`RECONTAR`; `CLIENTE_OPERACAO` → `CONFERIR`; `GESTOR_ARMAZEM` → `LIBERAR_QUARENTENA`/`CANCELAR_RECEBIMENTO` (sensíveis, sem papel "Qualidade" dedicado — DOC-04 §3 não nomeia um papel semente específico, mesmo padrão já registrado no relatório da Sessão 3).

**6 `exception_type`**: `REC.DIVERGENCIA_FALTA`/`SOBRA`/`AVARIA`/`TROCA` (1 passo, 24h), `REC.PRODUTO_SEM_CADASTRO` (2 passos, 24h), `REC.RECUSA_TOTAL` (2 passos, 8h).

**11 eventos `recebimento.*`** do catálogo §4.7, todos mapeados em `realtime-topics.ts`. **2 eventos adicionais**, mesmo precedente já estabelecido no relatório da Sessão 4 (`portaria.vaga_indisponivel` — requisito explícito sem evento correspondente nos 11 catalogados): `recebimento.crossdock_tempo_excedido` (RNF-REC-052) e `recebimento.recusa_total_aplicada` (RN-REC-023).

**Permissão sem código dedicado no catálogo de 6**: vínculo de cross-docking (RN-REC-050, "vínculo manual por LIDER_TURNO") e recusa total (RN-REC-023) reaproveitam `REC.CONFERIR`/`REC.CANCELAR_RECEBIMENTO` respectivamente, por proximidade semântica — DOC-04 §3 não define códigos próprios para essas ações. Documentado no código de cada controller.

---

## 5. Bugs REAIS encontrados e corrigidos (nenhum hipotético — todos travavam um teste ou um boot real)

1. **`partition-manager.integration.spec.ts`**: lista `MANAGED_TABLES` hardcoded desatualizada desde que `putaway_task` entrou em `PARTITIONED_TABLES` do worker real — teste esperava 2 tabelas, o worker já gerenciava 3.
2. **`infra/docker-compose.test.yml`**: `mc config host add` descontinuado nas imagens recentes de `minio/mc`; o script mascarava a falha com `; exit 0` — o bucket `wms-test` nunca existia de fato. Corrigido para `mc alias set`.
3. **`docker compose up -d --wait`** falha DETERMINISTICAMENTE quando o job one-shot `minio-test-init` já existiu antes (recria e sai rápido demais para o watcher de eventos do `--wait` observar "running"/"healthy"). Corrigido: `pretest:integration` faz `--wait` só nos 3 serviços de vida longa e roda o init via `docker compose run --rm`.
4. **`nfe-xml.util.ts`** (parser de NF-e): `fast-xml-parser` sem `parseTagValue: false` convertia campos textuais-mas-numéricos (CNPJ, SKU, EAN, NCM) para `Number`, derrubando zeros à esquerda silenciosamente — bug real de corretude de dado fiscal.
5. **`discrepancy_avaria_requires_photo`** (CHECK constraint): usava `array_length(photo_keys,1) >= 1`; para array VAZIO isso retorna `NULL`, e `NULL >= 1` não viola um CHECK (só `FALSE` viola) — a exigência de foto para AVARIA nunca era de fato aplicada. Corrigido com `cardinality()`.
6. **`LabelingService` (código desta sessão, corrigido antes de qualquer commit)**: consulta de espécie do produto usava `queryGlobal()` numa JOIN com `wms.product` (RLS TENANT) — sem contexto de tenant a policy nega tudo silenciosamente, então a quarentena de RN-REC-031 nunca era aplicada.
7. **`BatchService.update()` (Sessão 2B, já commitado)**: sempre passava `warehouseId: null` para `auditService.record()` — DOC-12 RD-SEG-030 `[INVIOLÁVEL]` exige `audit_log.warehouse_id` NOT NULL para toda ação exceto LOGIN/LOGOUT. Qualquer chamada real (`PATCH /cadastro/batches/:id` já existia como endpoint HTTP) sempre falhava. Corrigido: `warehouseId` virou parâmetro obrigatório.
8. **`LpnService`/`DEFAULT_GS1_PREFIX`** `[DÉBITO: DOC-02]`: todo armazém sem `GS1_PREFIX` próprio usa o mesmo prefixo padrão — o "1º palete" de QUALQUER armazém nessa situação colide em `pallet_lpn_unique` (GLOBAL) com o de outro armazém também sem prefixo. Não corrigido no service (fora de escopo, é DOC-02) — contornado nos testes com `GS1_PREFIX` próprio por armazém de teste, exatamente como uma implantação real deveria operar. **Risco real de produção documentado**.
9. **`wms.location.location_type` usa `'CROSS_DOCK'`, `wms.zone.zone_type` usa `'CROSS_DOCKING'`** — nomenclatura diferente para o mesmo conceito entre as duas tabelas (DOC-02, já commitado). Armadilha de nomenclatura, não bug de lógica — documentada para não repetir o erro.
10. **`MigrationRunner` (RNF-ARQ-090, código committed desde a Sessão 1) sem serialização entre instâncias concorrentes**: `docker compose up -d --build` sobe `backend-api`/`backend-worker`/`backend-scheduler` ao mesmo tempo, todos rodando `runPending()` contra o mesmo Postgres — a migration 39 (bootstrap de partição de `putaway_task`) não é atômica entre transações concorrentes, e 2 dos 3 containers quebraram na 1ª tentativa real desta sessão com `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. Corrigido com `pg_advisory_lock` de sessão em volta de `runPending()`. Verificado: 2 ciclos de `up --build`/`restart`, todos os 3 containers `healthy` em ambos.

---

## 6. Lacunas e débitos (citados no código onde se aplicam, resumidos aqui)

- **`[DÉBITO: Sessão 4B]`** Motor de putaway (RN-REC-040/041/042) — explicitamente fora de escopo. `putaway_task` só tem estrutura. `LABELING -> PUTAWAY_IN_PROGRESS` (§5.1) não é transicionado por nenhum service desta sessão — depende de "tarefas geradas", que só o motor de 4B produz.
- **`[DÉBITO: Sessão 4B+]`** Vínculo tardio de Ordem pré-chegada (ASN antes do gate-in, RF-REC-010(a)/(b)) a um `vehicle_visit` — se nenhum vínculo é encontrado na criação, a Ordem fica sem `inbound_invoice` para sempre nesta sessão; reenviar o mesmo XML depois falharia incorretamente com `NFE_ALREADY_REGISTERED`.
- **`[LACUNA: DOC-05]`** Nenhum crédito de `stock_balance` é feito por nenhum service desta sessão (FALTA/SOBRA/AVARIA aprovadas, cross-docking) — DOC-04 §1 delega saldo ao DOC-05 explicitamente.
- **`[LACUNA: DOC-06]`** `crossdock_link.outbound_order_reference` é texto livre, sem `outbound_order` real — "Pedido pula Picking" não tem Pedido real para aplicar.
- **`[LACUNA: DOC-08/DOC-11]`** Carta de divergência em PDF, notificação formal ao cliente, job de impressão de etiqueta (driver ZPL) — nenhum implementado; eventos de domínio publicados servem de sinal para pipelines futuros.
- **`[DÉBITO]`** RN-REC-023 "a visita segue para gate-out" (efeito de `REC.RECUSA_TOTAL` sobre `vehicle_visit`, DOC-03) não é acionado automaticamente — fronteira entre módulos respeitada (nenhum service de `recebimento/` importa services de `portaria/` via DI).
- **`[DÉBITO: DOC-02]`** `LpnService`/`DEFAULT_GS1_PREFIX` — ver §5 item 8.
- **Observação de código, não corrigida**: `DockService.dockVehicle()` atualiza `wms.vehicle_visit.status` via SQL cru em vez de `VehicleVisitService.transitionWithClient()` — pula a validação de que a visita estava em `EM_DESLOCAMENTO_DOCA` antes de atracar. Não corrigido por estar fora do escopo desta retomada (código herdado, sem teste próprio ainda).
- **Cobertura de teste**: `DockService` (RN-REC-001, RF-REC-002/003) não tem teste de integração dedicado — não bloqueia o DoD (não é um dos 7 cenários §6) mas é uma lacuna de cobertura real.
- **Observação não relacionada ao DOC-04**: `wms-frontend` falha ao subir no compose de dev (`ERR_PNPM_NO_SCRIPT_OR_SERVER`) — problema de empacotamento pré-existente, nada tocado nesta sessão (DOC-04 é só backend), fora do escopo do DoD (que exige apenas o backend + health/ready).

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> @wms/backend@0.0.1 build
> nest build
(sem erros)

$ pnpm test        (dentro de apps/backend)
Test Files  8 passed (8)
     Tests  44 passed (44)

$ pnpm test:integration   (dentro de apps/backend, 2 execuções consecutivas)
Test Files  48 passed (48)
     Tests  121 passed (121)
Test Files  48 passed (48)
     Tests  121 passed (121)

$ docker compose -f infra/docker-compose.yml up -d --build
...
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-17T22:53:30.652Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
```

`git commit && git push`: **não executado** — aguardando confirmação explícita do usuário antes de qualquer commit, por instrução permanente de sessão (ações que afetam o repositório compartilhado exigem confirmação, mesmo já autorizadas em documentos de escopo).
