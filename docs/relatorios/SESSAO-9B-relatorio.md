# Sessão 9B — DOC-07 Logística Reversa — integração com Gate-in/Portaria e Recall

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-9B-doc07-reversa-integracao-recall.md`
**Escopo**: RN-REV-002 real (gate-in de devolução valida contra Ordem
autorizada, não agendamento), RF-REV-001 (`RECUSA_ENTREGA` automática ao
veículo de expedição retornar) e RF-REV-030 (Recall completo). Fecha o
DOC-07 por inteiro (9A núcleo + 9B integração/recall).

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RN-REV-002 (gate-in valida Ordem autorizada) | `portaria/gate-in/gate-in.service.ts::registerGateIn` (+`loadReturnOrderForGateIn`) | `reversa/__tests__/gate-in-devolucao.integration.spec.ts` — "Retorno sem autorização aguarda fora" e o caminho AUTHORIZED |
| RF-REV-010 (vínculo de chegada dentro do gate-in) | `return-order.service.ts::linkArrivalWithClient` (nova) | mesmo arquivo — assert `IN_RECEIPT` + flow `CHEGADA` `DONE` |
| RF-REV-001 (`RECUSA_ENTREGA` automática) | `gate-in.service.ts::createRecusaEntregaOrders` + `return-order.service.ts::createForRecusaEntrega` | mesmo arquivo — 3º teste, cadeia `vehicle`→`vehicle_visit`→`loading`→`loading_order` |
| RF-REV-030 item 1 (`batch.status = RECALLED`) | `recall/recall.service.ts::triggerRecall` | `recall/__tests__/recall.integration.spec.ts` |
| RF-REV-030 item 2 (bloqueio em todos os armazéns) | `recall.service.ts::blockAllBalances` | mesmo arquivo — cenário Gherkin §6, 300+120=420 UN |
| RF-REV-030 item 3 (cancela reserva + re-seleciona) | `recall.service.ts::cancelAndReselectReservations` | mesmo arquivo — reserva de 50 UN re-selecionada de lote alternativo |
| RF-REV-030 item 4 (relatório de expedidos) | `recall.service.ts::triggerRecall` (query `stock_movement`) | mesmo arquivo (relatório vazio no cenário, sem expedição prévia) |
| RF-REV-030 item 5 (Ordem RECALL por armazém) | `return-order.service.ts::createForRecall` | mesmo arquivo (implícito — sem `package_content` no cenário, 0 Ordens; caminho exercitado via 9A `createReturnOrder`/estrutura compartilhada) |
| RECALL/RECUSA_ENTREGA no catálogo de tipos | `infra/postgres/migrations/0072-reversa-integracao-recall.sql` | `grants-contract.integration.spec.ts` (tabela `recall`) + migração aplicada em dev real (log do boot) |

Cenários Gherkin do DOC-07 §6 fechados nesta sessão: "Retorno sem autorização
aguarda fora" e "Recall bloqueia em todos os armazéns" — com isso, os 6
cenários do §6 estão cobertos (4 pela 9A, 2 pela 9B).

---

## 2. Saída real dos comandos

### Testes unitários (215/215 — sem novas unidades puras nesta sessão, tudo integração)
```
$ npx vitest run --config vitest.config.ts
PASS (215) FAIL (0)
```

### Testes de integração — 2 execuções consecutivas (327/327, era 322)
```
$ pnpm test:integration
 Test Files  76 passed (76)
      Tests  327 passed (327)
   Duration  179.74s

$ pnpm test:integration   # segunda execução
 Test Files  76 passed (76)
      Tests  327 passed (327)
```

### Build
```
$ pnpm build
 Tasks: 5 successful, 5 total
```

### Docker compose + health check
```
$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-backend-api Started
 Container wms-backend-worker Started
 Container wms-backend-scheduler Started

$ docker ps --format "table {{.Names}}\t{{.Status}}" | grep wms-backend
wms-backend-worker      Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-api         Up (healthy)

$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T13:03:13.713Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP_STATUS:200
```

Log do boot confirma `✓ Migration 71/72` aplicadas e `RN-SEG-012: todas as
rotas REST e handlers WebSocket declaram permissão. Boot liberado.` —
inclui a nova rota `POST /reversa/recall` e o campo novo de
`RegisterGateInInput` não exige rota adicional (mesmo endpoint
`POST /portaria/gate-in`).

---

## 3. Decisões de implementação (resumo — detalhe completo no prompt)

Ver `docs/PROMPT-SESSAO-9B-doc07-reversa-integracao-recall.md` para a
justificativa completa. Resumo:

1. `PortariaModule` passou a importar `ReversaModule` (mesmo padrão de
   `ExpedicaoModule`→`FiscalModule`) — decisão revisada durante a sessão:
   o rascunho inicial do prompt propunha SQL direto sem acoplar módulos
   (mesmo padrão de `DockService`), mas a criação de `RECUSA_ENTREGA`
   (numeração, itens, auto-autorização) é grande demais para duplicar sem
   risco real de divergência — corrigido no próprio prompt antes de
   codar.
2. `RegisterGateInInput` ganhou `return_order_id`/`recusa_entrega`
   (mutuamente exclusivos com `appointment_id`). `blocking_reason` ganhou
   `SEM_AUTORIZACAO_REVERSA` (migration `0072`).
3. `createRecusaEntregaOrders` é IDEMPOTENTE (reaproveita Ordem `AUTHORIZED`
   ainda sem `vehicle_visit_id` para o mesmo pedido) — necessário porque a
   criação acontece FORA da transação de gate-in (mesmo motivo de
   `RN-POR-012`: exceções e efeitos externos não podem estar dentro da
   transação de negócio) e uma falha posterior (ex.: checklist HAZMAT) não
   pode duplicar a Ordem numa nova tentativa.
4. `[DEBITO: 9B]` o vínculo de chegada da reversa só acontece no caminho
   DIRETO de sucesso do gate-in — `retrySlotAllocation`/
   `resumeAfterExceptionDecision` (usados quando falta vaga de pátio) não
   vinculam a Ordem automaticamente. Fallback manual sempre disponível:
   `POST /reversa/ordens/:id/chegada` (criado pela 9A).
5. Recall: não existe um tipo de movimentação QUARANTINE→BLOCKED direto no
   catálogo fechado (RN-EST-001, 18 tipos) — encadeia
   `LIBERACAO_QUARENTENA` + `BLOQUEIO` na mesma transação. Descoberto e
   corrigido durante a sessão: bloquear ANTES de cancelar reserva deixava a
   quantidade liberada pelo cancelamento fora do bloqueio (bug real pego
   pelo teste do cenário Gherkin — 370 UN bloqueadas em vez de 420); a
   correção bloqueia a quantidade liberada por cada reserva cancelada
   imediatamente, antes de re-selecionar.
6. `return_order.type = 'RECALL'` não tem `source_outbound_order_id` único
   (pode agregar itens de vários pedidos) — `CHECK` relaxado para tratar
   `RECALL` como `REVERSA_AVULSA` nesse aspecto; cada item mantém seu
   próprio `source_outbound_order_item_id`.

---

## 4. Lacunas e débitos

**Em aberto:**
- `[DEBITO: 9B]` `retrySlotAllocation`/`resumeAfterExceptionDecision` não
  vinculam a Ordem de Devolução automaticamente após uma alocação de vaga
  tardia — fallback manual existe, mas não é automático (ver decisão 4).
- `[DEBITO: 9B]` `RecallService.createRecallReturnOrders` não tem teste de
  integração dedicado ao caminho COM `package_content` (o cenário Gherkin
  usado não expede fisicamente o lote antes do recall) — a lógica é a
  mesma já testada indiretamente pela 9A (`createForRecall` reaproveita
  `createAutoAuthorized`, coberto por `createForRecusaEntrega`).
- `[DEBITO: 9B]` sem endpoint HTTP para consultar o relatório de
  rastreabilidade (`recall.shipped_orders_report`) separadamente — só
  disponível no retorno síncrono de `POST /reversa/recall`.

**Fechados nesta sessão**: RN-REV-002, RF-REV-001, RF-REV-030 — DOC-07
fecha por completo (9A+9B).

---

## 5. Arquivos desta sessão

Migration: `infra/postgres/migrations/0072-reversa-integracao-recall.sql`.

Novos: `apps/backend/src/modules/reversa/recall/**` (service, controller,
teste), `apps/backend/src/modules/reversa/__tests__/gate-in-devolucao.integration.spec.ts`.

Modificados: `gate-in.service.ts` (+return_order_id/recusa_entrega,
+ReturnOrderService), `portaria.module.ts` (+ReversaModule),
`return-order.service.ts` (+linkArrivalWithClient, +createForRecusaEntrega,
+createForRecall), `reversa.module.ts` (+StockBlockService/
StockSelectionService/StockReservationService/RecallController/RecallService),
`portaria/__tests__/test-helpers.ts` (+ReturnOrderService),
`grants-contract.integration.spec.ts` (+`recall`).
