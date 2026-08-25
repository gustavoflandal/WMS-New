# Sessão 9A — DOC-07 Logística Reversa, núcleo

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md`
**Escopo**: Ordem de Devolução (criação/autorização/negação/cancelamento),
validação contra o pedido de origem (RN-REV-003), vínculo manual de chegada +
doca/descarga mínimos, Triagem completa (RF-REV-020, matriz RN-REV-021),
Destinação com efeito de saldo real (RN-REV-022) e gancho fiscal real
(RN-REV-023, `StorageReturnInvoiceService.reverseConsumption()`).

Deixado para a **Sessão 9B** (ver `docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md`
§"Por que 9A/9B"): integração real com `GateInService` (devolução sem
agendamento, `REV.SEM_AUTORIZACAO` automático), `RECUSA_ENTREGA` automática
(veículo de expedição que retorna), Recall (RF-REV-030), endpoint HTTP de
upload de foto.

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RF-REV-001 (tipos de Ordem, exceto RECUSA_ENTREGA/RECALL) | `return-order/return-order.service.ts::createReturnOrder` | `__tests__/return-order.integration.spec.ts` (todos os 4 cenários) |
| RN-REV-002 (autorização prévia, manual) | `return-order/return-order.service.ts::authorize/deny` | coberto indiretamente (todo cenário chama `authorize`) — `[DEBITO: 9A]` sem teste unitário isolado de `deny`/`cancel` |
| RN-REV-003 (validação contra origem) | `return-order.service.ts::validateAndInsertItem` | "Cenário: Quantidade devolvida não excede a expedida" |
| RF-REV-010 (Fluxo Operacional CHEGADA→DOCA→DESCARGA→TRIAGEM→DESTINACAO→FIM) | `return-order.service.ts::linkArrival/assignDock/completeUnloading` | exercitado por `bringToTriage()` em todos os cenários |
| `return_order` máquina de estados (§5.1) | `return-order/return-order-state-machine.util.ts` | `__tests__/return-order-state-machine.util.spec.ts` (6 testes) |
| RF-REV-020 (registro de triagem, fotos obrigatórias) | `triage/return-triage.service.ts::registerTriage` | todos os cenários; CHECK de banco (`triage_record_photo_required_check`) não testado isoladamente — `[DEBITO: 9A]` |
| RN-REV-021 (matriz de destinação, MEDICAMENTO, vencido) | `triage/disposition-matrix.util.ts` | `__tests__/disposition-matrix.util.spec.ts` (10 testes) + cenários "Vencido jamais reintegra" e "Medicamento reintegra somente via quarentena" |
| RN-REV-022 (efeito de saldo por destinação) | `return-triage.service.ts::confirmDisposition` + `resolveCreditLocation` | "Medicamento..." (QUARANTINE) e "Destinação só conclui..." (AVAILABLE) — AVARIA/DESCARTE/RETORNO_CLIENTE não exercitados em integração, só a função pura testada — `[DEBITO: 9A]` |
| RN-REV-023 (gancho fiscal, conclusão gated) | `return-triage.service.ts::recomposeFiscal/tryCompleteOrder` | "Cenário: Destinação só conclui com fiscal registrado" |

---

## 2. Saída real dos comandos

### Testes unitários (215/215, era 199)
```
$ npx vitest run --config vitest.config.ts
PASS (215) FAIL (0)
```

### Testes de integração — 2 execuções consecutivas (322/322, era 318)
```
$ pnpm test:integration
 Test Files  74 passed (74)
      Tests  322 passed (322)
   Duration  179.31s

$ pnpm test:integration   # segunda execução
 Test Files  74 passed (74)
      Tests  322 passed (322)
   Duration  177.86s
```

### Build
```
$ pnpm build
@wms/backend:build: > nest build
@wms/frontend:build: ✓ Compiled successfully
 Tasks: 5 successful, 5 total
```

### Docker compose + health check
```
$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-backend-api Started
 Container wms-backend-worker Started
 Container wms-backend-scheduler Started
 Container wms-frontend Started

$ docker ps --format "table {{.Names}}\t{{.Status}}" | grep wms-backend
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)

$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T12:05:52.164Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP_STATUS:200
```

Log do boot confirma `RN-SEG-012: todas as rotas REST e handlers WebSocket
declaram permissão. Boot liberado.` (inclui as 10 rotas novas de
`ReturnOrderController`) e `✓ Migration 71: reversa nucleo` aplicada com
sucesso no Postgres de desenvolvimento (não só no de teste).

---

## 3. Decisões de implementação (resumo — detalhe completo no prompt)

Ver `docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md` §"Decisões de
implementação" para a justificativa completa de cada uma. Resumo:

1. Só `DEVOLUCAO_CLIENTE_FINAL`/`AVARIA_TRANSPORTE`/`REVERSA_AVULSA` no
   `CHECK` de `return_order.type` nesta sessão.
2. "Quantidade expedida" (RN-REV-003) = `SUM(package_content.qty)` por
   `outbound_order_item_id` — não existe coluna dedicada na base.
3. Chegada vinculada **manualmente** (`linkArrival`), não via `GateInService`
   — decisão explícita para não arriscar regressão no DOC-03 dentro do
   orçamento desta sessão.
4. Doca/Descarga: mecânica própria (`assignDock`/`completeUnloading`),
   escrevendo em `return_order`/`vehicle_visit`/`dock`, sem chamar
   `DockService` (hardcoded para `inbound_order`).
5. Matriz de destinação (`disposition-matrix.util.ts`): função pura, com
   bloqueio absoluto de reintegração (`shelf_life_blocks_reintegration`,
   coluna gravada na triagem — não recomputada na destinação, para não
   arriscar divergência lote/produto entre as duas chamadas).
6. Efeito de saldo credita na primeira location da zona `RETURNS`/
   `QUARANTINE`/`DAMAGED` do armazém — **sem** acionar o motor de putaway
   dirigido (RN-REC-040) para `REINTEGRAR`. `[DEBITO: 9A]`.
7. Gancho fiscal: reversão real via `fiscal_allocation` (FIFO por
   `created_at`), gated por `fiscal_mode` (dispensado em `INTEGRADO_ERP`/
   `REVERSA_AVULSA`); `ConflictException` explícita se a quantidade devolvida
   exceder o que foi fiscalmente consumido (nunca engolida em silêncio).
8. Fotos: mesma convenção de `wms.discrepancy.photo_keys` (array + CHECK de
   obrigatoriedade) — sem endpoint de upload novo (nenhum módulo tem um
   hoje; `checking.controller.ts` já assume o mesmo).

---

## 4. Achados de código (não documentados no prompt original)

- `DockService.dockVehicle()` é hardcoded para `wms.inbound_order`
  (`dock.service.ts:110-120`) — não existe "assignDock genérico por
  entidade" reaproveitável. Confirmado por leitura de código, não por
  suposição — motivou a decisão 4.
- `qty_packed` (`outbound_order_item`) nunca é escrito em lugar nenhum da
  base — não é uma fonte válida de "quantidade expedida" (usar
  `package_content.qty`, decisão 2).
- `wms.fiscal_allocation.outbound_order_id` (migration 0069) já existe e é
  exatamente o vínculo que RN-REV-023 precisa — a 8A/8B já tinham deixado
  isso pronto, mesmo sem gatilho (comentário explícito em
  `storage-return-invoice.service.ts:10-12`: "DOC-07/Logística Reversa ainda
  não existe — decisão de escopo explícita, não [LACUNA]").

---

## 5. Lacunas e débitos

**Em aberto:**

- `[DEBITO: 9A]` `REV.SEM_AUTORIZACAO` (gate-in automático), `RECUSA_ENTREGA`
  automática, Recall (RF-REV-030) — 9B, ver prompt §"Por que 9A/9B".
- `[DEBITO: 9A]` `REINTEGRAR` não aciona o motor de putaway dirigido
  (RN-REC-040) — credita direto na zona `RETURNS`, sem tarefa de putaway.
- `[DEBITO: 9A]` `AVARIA`/`DESCARTE`/`RETORNO_CLIENTE` não têm cenário de
  integração dedicado (só a função pura `disposition-matrix.util.ts` e os 2
  cenários que usam `QUARENTENA`/`REINTEGRAR`).
- `[DEBITO: 9A]` sem teste de integração isolado para `deny()`/`cancel()`
  nem para o fluxo `REV.ITEM_NAO_EXPEDIDO` (item fora do pedido de
  origem → exceção → `decide()` → reenvio com `approvedExceptionId`) —
  implementado, não exercitado por teste automatizado nesta sessão.
- `[DEBITO: 9A]` `RETORNO_CLIENTE` credita em `blocked` mas não existe ainda
  o "pedido de saída tipo retorno" (RN-REV-022) que consumiria esse saldo —
  mesmo corte que RF-EST-051 (DOC-05) já tem para transferência inter-armazém.
- `[LACUNA: DOC-07]` upload de foto: nenhum módulo do projeto tem endpoint
  HTTP de upload multipart hoje — `photo_keys` são assumidas já existentes no
  storage (mesma convenção de `checking.controller.ts`).

**Fechados nesta sessão**: os 4 cenários Gherkin do DOC-07 §6 aplicáveis ao
núcleo (ver matriz §1).

---

## 6. Arquivos desta sessão

Migration: `infra/postgres/migrations/0071-reversa-nucleo.sql`.

Módulo novo: `apps/backend/src/modules/reversa/**` (`return-order/` —
service, controller, state machine util + teste; `triage/` — service,
disposition-matrix util + teste; `reversa.module.ts`;
`__tests__/return-order.integration.spec.ts`).

Modificados: `app.module.ts` (+`ReversaModule`),
`grants-contract.integration.spec.ts` (+`return_order`,
`return_order_item`, `triage_record`).

Docs: `docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md` (prompt desta sessão),
`docs/relatorios/ESTADO-E-ROTEIRO.md` e
`docs/relatorios/MARCO-estado-do-sistema.md` (fechamento do DOC-08/8B,
pendente desde a sessão anterior, e abertura da 9A/9B).
