# PROMPT — Sessão 9B: DOC-07 Logística Reversa — integração com Gate-in/Portaria e Recall

**Carregar**: DOC-00 (RG-001/002/003/006/009) + DOC-07 completo + DOC-03 §4.2
(gate-in) + `docs/relatorios/SESSAO-9A-relatorio.md` +
`docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md` (decisões herdadas).

## Escopo

O que ficou pendente da 9A (ver seu prompt, §"Por que 9A/9B"):

1. **RN-REV-002 real**: gate-in de devolução valida contra `return_order`
   autorizada (não contra `appointment`); sem autorização, abre
   `REV.SEM_AUTORIZACAO` e a visita fica `AGUARDANDO_AUTORIZACAO` — mesmo
   padrão "aguarda fora" que `SEM_AGENDAMENTO` já usa.
2. **RF-REV-001 `RECUSA_ENTREGA` automática**: veículo de expedição que
   retorna (mesma placa, visita de saída `ENCERRADA` mais recente) tem a(s)
   Ordem(ns) de Devolução criada(s) e autorizada(s) automaticamente,
   referenciando o(s) pedido(s) daquela visita.
3. **RF-REV-030 Recall** completo: bloqueio de saldo em todos os armazéns,
   cancelamento de reserva não separada com re-seleção, relatório de pedidos
   já expedidos, criação de Ordem(ns) de Devolução tipo `RECALL`.

## Decisões de implementação

1. **Acoplamento Portaria→Reversa**: ao contrário da 9A (`DockService` não
   importa `InboundOrderService` — troca aceitável para uma operação
   pequena, 1 UPDATE + 1 flow step), a criação automática de
   `RECUSA_ENTREGA` é substancial (numeração, itens, auto-autorização) —
   duplicar isso inteiro dentro de `GateInService` seria pior do que
   acoplar. `PortariaModule` passa a importar `ReversaModule`
   (`ReturnOrderService`), MESMO padrão já usado por `ExpedicaoModule`
   importando `FiscalModule` para `StorageReturnInvoiceService` (uma
   integração de domínio cruzado nova, não uma dependência interna
   DOC-03/04). `ReturnOrderService` ganha `linkArrivalWithClient()`
   (variante transacional de `linkArrival`, mesmo padrão
   `xWithClient` de `VehicleVisitService`) e `createForRecusaEntrega()`.
2. **`RegisterGateInInput` ganha dois campos opcionais, mutuamente
   exclusivos com o fluxo de agendamento normal**:
   - `return_order_id?: string` — devolução com Ordem já autorizada
     (`DEVOLUCAO_CLIENTE_FINAL`/`AVARIA_TRANSPORTE`/`REVERSA_AVULSA`/
     `RECALL`). Pula toda a lógica de `appointment`; valida
     `return_order.status === 'AUTHORIZED'`; sem isso,
     `blockingReason = 'SEM_AUTORIZACAO_REVERSA'` (novo valor, migration
     estende o CHECK de `vehicle_visit.blocking_reason`) +
     `REV.SEM_AUTORIZACAO`.
   - `recusa_entrega?: boolean` — motorista declara recusa sem Ordem prévia.
     O serviço busca a visita `OUTBOUND`/`ENCERRADA` mais recente da mesma
     placa (`ORDER BY gate_out_at DESC`), os pedidos daquela visita (cadeia
     `loading.vehicle_visit_id` → `loading_order.outbound_order_id` — não
     existe hoje nenhum FK direto `outbound_order→vehicle_visit`), e cria +
     autoriza automaticamente uma `return_order` tipo `RECUSA_ENTREGA` POR
     PEDIDO encontrado (podem ser vários — `loading_order` é N:N), com os
     itens = todos os itens do pedido, `qty_authorized` = quantidade
     expedida (`SUM(package_content.qty)`, mesma fonte da 9A). Sem nenhum
     pedido encontrado: `BadRequestException` (não há o que recusar).
3. **RN-REV-021 continua intocada** — a Triagem decide o que realmente está
   danificado/vencido/íntegro na descarga; a Ordem automática só fixa o
   TETO (`qty_authorized`) do que pode ser recebido.
4. **Recall (`RecallService`, módulo `reversa`)**:
   - `batch.status = 'RECALLED'` via `BatchService.update()` já existente
     (sem FSM dedicada — mesmo estado do código já aceito pela 9A/sessões
     anteriores, não é regressão desta sessão consertar).
   - Bloqueio de saldo: `wms.stock_balance` tem RLS só por `tenant_id` (sem
     `warehouse_id`) — uma query cross-armazém dentro do tenant é válida;
     o efeito em si (via `StockMovementService.apply`, `movementType:
     'BLOQUEIO'`, `blockReasonCode: 'ORDEM_CLIENTE'`) precisa de uma
     transação POR ARMAZÉM (o contexto de tenant exige `warehouse_id`
     explícito).
   - Cancelamento de reserva + re-seleção: mesmo trio já usado por
     `picking-task.service.ts::applyShortDecision` (`UPDATE status =
     'CANCELLED'` + `StockMovementService.apply(LIBERACAO_RESERVA)` +
     `StockReservationService.reserveInTransaction`), aplicado só a
     `stock_reservation.status = 'ACTIVE'` do lote — chamado DEPOIS do
     bloqueio de saldo (para a re-seleção não poder escolher o próprio saldo
     recém-bloqueado).
   - Relatório de expedidos: `SELECT DISTINCT document_ref_id FROM
     wms.stock_movement WHERE batch_id = $1 AND movement_type =
     'SAIDA_EXPEDICAO' AND document_ref_type = 'OUTBOUND_ORDER'` — não
     existe consulta pronta, construída nesta sessão.
   - Ordens de Devolução tipo `RECALL`: uma POR ARMAZÉM com saldo do lote já
     expedido, `source_outbound_order_id = NULL` (RECALL não tem uma única
     origem — pode agregar itens de vários pedidos; `CHECK` de
     `return_order` relaxado para aceitar `RECALL` sem origem, igual
     `REVERSA_AVULSA`), itens com `source_outbound_order_item_id` POR ITEM
     (granularidade que a 9A já modelou), `qty_authorized` = soma de
     `package_content.qty` daquele item para aquele lote. Criado direto via
     `ReturnOrderService.createForRecall()` (bypassa a validação RN-REV-003
     do `createReturnOrder()` normal — não faz sentido validar "quantidade
     expedida" contra si mesma).
5. **Permissão `REV.RECALL`** (catálogo já previsto na 9A, não implementado):
   `CLIENT_WAREHOUSE`, sensível, papéis `CLIENTE_OPERACAO`/`GESTOR_ARMAZEM`
   (DOC-07 §3: "Cliente... recall"; RN-REV-030 permite "interno com a
   anuência anexada", mesmo padrão de RN-REV-002).
6. **Exceção `REV.SEM_AUTORIZACAO`** (catálogo já previsto, cadastrado só
   agora que tem chamador real): 8h, motivo obrigatório — mesmos valores do
   texto original do DOC-07 §3.

## Critérios de aceite

Cenários Gherkin do DOC-07 §6 que faltavam: "Retorno sem autorização aguarda
fora" e "Recall bloqueia em todos os armazéns" — ambos cobertos nesta sessão.
Isso fecha os 6 cenários do §6 (os outros 4 já fechados pela 9A).

DoD padrão do CLAUDE.md.
