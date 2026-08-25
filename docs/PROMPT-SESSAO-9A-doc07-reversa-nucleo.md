# PROMPT — Sessão 9A: DOC-07 Logística Reversa, núcleo (Ordem de Devolução, Triagem, Destinação, gancho fiscal)

**Carregar**: DOC-00 (RG-001/002/003/006/009/013, catálogo RN-EST-001, glossário) + DOC-07 completo + `docs/relatorios/SESSAO-8B-relatorio.md` (fiscal, `reverseConsumption()`) + `docs/relatorios/ROTEIRO-DESENVOLVIMENTO.md` Posição 3.

## Por que 9A/9B (módulo grande vira A/B)

O roteiro estimava DOC-07 como "1 sessão, econômico" assumindo reuso direto de
`DockService`/`GateInService` do DOC-03/04. Levantamento de código (não de
spec) mostrou que isso não é verdade:

- `DockService.dockVehicle()` é hardcoded para `wms.inbound_order`
  (`dock.service.ts:110-120`) — não existe um "assignDock genérico por
  entidade". Reaproveitar sem alterar o código testado do DOC-04 exige que a
  reversa tenha seu próprio (pequeno) equivalente, não uma chamada direta.
- `GateInService.registerGateIn()` valida contra `wms.appointment`
  (agendamento) — RN-REV-002 exige validar contra `return_order` autorizada,
  uma dimensão de validação nova, não coberta pelo gate-in atual. Ligar isso
  de verdade (abrir `REV.SEM_AUTORIZACAO` automaticamente no gate-in) é uma
  mudança real num arquivo core, testado, de alto tráfego — não cabe
  "encaixar" no fim de uma sessão já carregada com a lógica de triagem.
- RF-REV-001 (`RECUSA_ENTREGA` criada automaticamente quando o veículo que
  saiu volta) não tem nenhum hook parcial pronto (`vehicle_visit` não guarda
  vínculo a uma visita anterior).
- RF-REV-030 (Recall) tem efeitos em cascata (bloqueio multi-armazém,
  cancelamento de reserva com re-seleção, relatório de rastreabilidade) que
  merecem sessão própria.

**Divisão**:
- **9A (esta sessão)**: tudo que é negócio novo e autocontido — Ordem de
  Devolução (criação/autorização/negação), validação contra o pedido de
  origem (RN-REV-003), vínculo de chegada MANUAL (endpoint dedicado, sem
  tocar `GateInService`), doca/descarga mínimos próprios da reversa, Triagem
  completa (matriz RN-REV-021, inclusive vencido/medicamento), Destinação com
  efeito de saldo real (RN-REV-022) e gancho fiscal real (RN-REV-023,
  `StorageReturnInvoiceService.reverseConsumption()`).
- **9B (próxima)**: integração real com `GateInService` (devolução sem
  agendamento, `REV.SEM_AUTORIZACAO` automático), `RECUSA_ENTREGA` automática,
  Recall (RF-REV-030), endpoint HTTP de upload de foto (hoje nenhum módulo
  tem — `checking.controller.ts` já assume `photo_keys` prontos no corpo, e
  9A segue a mesma convenção).

Isto NÃO é [LACUNA] (a spec é clara) nem [DEBITO] por dificuldade descartada
— é uma divisão de escopo documentada, no mesmo padrão de 7A/7B e 8A/8B.

## Decisões de implementação (9A)

1. **Tipos de Ordem em 9A**: `DEVOLUCAO_CLIENTE_FINAL`, `AVARIA_TRANSPORTE`,
   `REVERSA_AVULSA`. `RECUSA_ENTREGA` e `RECALL` só entram no `CHECK` da
   migration 9B (padrão já usado pelo projeto: "tipo não implementado não
   aparece", ver `operations-board.service.ts:9-15`).
2. **RN-REV-003 (quantidade expedida)**: não existe hoje nenhuma coluna
   "quantidade expedida" em `outbound_order_item` (`qty_packed` nunca é
   escrita). A quantidade real que saiu é `SUM(wms.package_content.qty)` por
   `outbound_order_item_id`, do(s) pacote(s) do pedido de origem — é o único
   dado imutável e realmente escrito na expedição (RG-003, INSERT-only).
   "Acumulado entre devoluções do mesmo pedido" = soma de
   `return_order_item.qty_authorized` de outras Ordens de Devolução não
   `DENIED`/`CANCELLED` do mesmo `source_outbound_order_item_id`.
3. **Vínculo de chegada**: `ReturnReceiptService.linkArrival(returnOrderId,
   vehicleVisitId, ...)` — chamado manualmente (porteiro/conferente) depois
   de um gate-in comum do DOC-03 já ter ocorrido. Valida
   `vehicle_visit.warehouse_id` e que a visita está em curso, marca
   `return_order.vehicle_visit_id`, cria o Fluxo Operacional com "CHEGADA" já
   `DONE` (mesmo padrão de `inbound-order.service.ts:516-526`).
4. **Doca/Descarga**: `ReturnReceiptService.assignDock()`/
   `completeUnloading()` fazem a MESMA mecânica de
   `wms.dock`/`wms.vehicle_visit` que `DockService` já faz para recebimento,
   mas escrevendo em `return_order` (não em `inbound_order`) — código próprio
   e pequeno, não uma chamada ao `DockService` existente (evita risco de
   regressão no DOC-04). `return_order.status` permanece `IN_RECEIPT` durante
   as duas etapas; só avança para `IN_TRIAGE` ao concluir a descarga.
5. **RN-REV-021 (matriz)**: `meetsMinimumShelfLife()`
   (`stock-selection.util.ts:82-119`) é reaproveitada só para o cálculo de
   dias restantes; a classificação de 3 vias (vencido / abaixo do mínimo /
   dentro do mínimo) e a exceção `MEDICAMENTO` (força `QUARENTENA`
   independente do estado físico) são novas, em
   `disposition-matrix.util.ts`, puras e testadas isoladamente. Vencido →
   `REINTEGRAR` é bloqueio absoluto, sem exceção possível (nenhum catálogo de
   exceção cobre isso — é regra de código, não workflow).
6. **RN-REV-022 (efeito de saldo)**: `StockMovementService.apply()` com
   `movementType: 'ENTRADA_REVERSA'` e `bucketToOverride` por destinação
   (`AVAILABLE`/`QUARANTINE`/`DAMAGED`/`BLOCKED`). O local de crédito é a
   PRIMEIRA location da zona correspondente no armazém (mesmo padrão de
   busca zona→location do putaway) — **não** aciona o motor de putaway
   dirigido (RN-REC-040) para `REINTEGRAR`; fica como `[DEBITO: 9A]`
   (mesmo tipo de corte que `checking.service.ts:647-649` já assumiu para
   avaria do DOC-04).
7. **RN-REV-023 (gancho fiscal)**: só roda quando
   `client_warehouse_settings.fiscal_mode IN ('EMISSAO_PROPRIA','HIBRIDO')`
   E a Ordem tem `source_outbound_order_id`. Busca
   `wms.fiscal_allocation WHERE outbound_order_id = X AND product_id = Y AND
   status = 'CONSUMIDA' ORDER BY created_at` e chama
   `reverseConsumption()` em ordem (mesmo padrão de drawdown usado por
   `storage-return-invoice.service.ts:456-464`) até cobrir a quantidade
   triada. `INTEGRADO_ERP` ou sem pedido de origem (`REVERSA_AVULSA`):
   dispensado, marcado satisfeito diretamente. `return_order.status` só vai
   para `COMPLETED` quando todo item tiver `disposition_confirmed` E o
   gancho fiscal tiver rodado (`fiscal_treatment_done`).
8. **Fotos**: mesma convenção de `wms.discrepancy.photo_keys` — `TEXT[]` +
   CHECK de obrigatoriedade quando `physical_state != 'INTEGRO'`, chaves
   assumidas já existentes no storage (sem endpoint de upload novo, mesma
   omissão que `checking.controller.ts` já tem — upload multipart fica para
   quando algum módulo precisar de fato, não é escopo do DOC-07).

## Critérios de aceite

Cenários Gherkin do DOC-07 §6 cobertos por 9A: "Quantidade devolvida não
excede a expedida", "Vencido jamais reintegra", "Medicamento reintegra
somente via quarentena", "Destinação só conclui com fiscal registrado".
"Retorno sem autorização aguarda fora" e "Recall bloqueia em todos os
armazéns" ficam para 9B (dependem de `GateInService`/Recall).

DoD padrão do CLAUDE.md: build + testes unitários + integração (2 execuções)
+ docker compose + health check + relatório com matriz requisito→arquivo→teste.
