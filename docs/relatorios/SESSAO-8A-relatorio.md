# SESSÃO 8A — Fiscal: ciclo do Estoque Fiscal (RG-014)

| Metadado | Valor |
|---|---|
| Sessão | 8A (parte 1 de 2 — 8B é o motor de emissão NF-e real) |
| Módulo | DOC-08 (Fiscal) §4.1–§4.6, §4.8; DOC-00 RG-014 [INVIOLÁVEL] |
| Data | 2026-08-23/24 |
| Prompt | `docs/PROMPT-SESSAO-8A-fiscal-estoque.md` |
| Migration | `infra/postgres/migrations/0069-fiscal-estoque.sql` |

---

## 1. Escopo entregue

Modos fiscais (RN-FIS-001), NF de entrada + prazo (RN-FIS-010, reaproveitando
`wms.inbound_invoice` do DOC-04), Nota de Armazenagem + crédito do Estoque
Fiscal (RF-FIS-020/RN-FIS-021), ordem de consumo (RN-FIS-030), Nota de
Devolução de Armazenagem — montagem e consumo-na-autorização (RN-FIS-040),
recomposição por reversa isolada (RN-FIS-041), naturezas/CFOP (RN-FIS-050),
pendências documentais de descarte/ajuste (RN-FIS-070). Fora de escopo (§2.8
do prompt, não implementado): motor de emissão NF-e real (8B), gatilho
automático de RN-FIS-041 pelo DOC-07 (não existe ainda), numeração
sequencial-sem-lacunas real da NF-e.

---

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivo(s) principal(is) | Teste |
|---|---|---|
| RN-FIS-001 (imutabilidade do modo fiscal) | `apps/backend/src/modules/fiscal/fiscal-mode/fiscal-mode.service.ts` | coberto por inspeção de código + uso interno nos testes de fiscal_mode='EMISSAO_PROPRIA' (sem teste de integração dedicado à trava de imutabilidade — ver §5 débitos) |
| RN-FIS-010 (prazo, alertas 50/80/100%, bloqueio de saída) | `apps/backend/src/modules/fiscal/inbound-invoice/inbound-invoice-fiscal.service.ts`, hook em `apps/backend/src/modules/expedicao/order/outbound-order.service.ts` (`release()`), worker `apps/backend/src/workers/inbound-invoice-deadline.worker.impl.ts` | `fiscal-estoque.integration.spec.ts` — describe "RN-FIS-010 — prazo de regularização fiscal expirado" |
| RF-FIS-020/RN-FIS-021 (Nota de Armazenagem + crédito) | `apps/backend/src/modules/fiscal/storage-invoice/storage-invoice.service.ts` (+ controller) | `fiscal-estoque.integration.spec.ts` — describe "RF-FIS-020 — cobertura da Nota de Armazenagem" e describe "RN-FIS-030" (crédito exercitado via `register()` 3x) |
| RN-FIS-030 (ordem de consumo FIFO_EMISSAO/LIFO_EMISSAO/MANUAL) | `apps/backend/src/modules/fiscal/consumption/fiscal-consumption.util.ts` (puro) + `fiscal-consumption.service.ts` (I/O) | `fiscal-consumption.util.spec.ts` (6 testes puros, exemplo normativo) + `fiscal-estoque.integration.spec.ts` (exemplo normativo ponta a ponta contra Postgres) |
| RN-FIS-040 (montagem + autorização + consumo-na-autorização) | `apps/backend/src/modules/fiscal/storage-return-invoice/storage-return-invoice.service.ts` (+ controller) | `fiscal-estoque.integration.spec.ts` — describe "RN-FIS-030 — consumo FIFO_EMISSAO (exemplo normativo)" (ambos os cenários) |
| RN-FIS-041 (recomposição por reversa, método isolado) | `storage-return-invoice.service.ts::reverseConsumption()` | `fiscal-estoque.integration.spec.ts` — describe "RN-FIS-041 — reverseConsumption() isolado" |
| RN-FIS-050 (naturezas/CFOP por cliente×armazém×tipo×âmbito, fallback GLOBAL) | migration `0069` (`wms.operation_nature` + seed), `apps/backend/src/modules/fiscal/shared/operation-nature.util.ts` | exercitado indiretamente em todo teste que chama `register()`/`assemble()` (resolve a natureza a cada chamada); sem teste dedicado ao *override* por cliente (ver §5) |
| RN-FIS-070 (pendência documental de descarte/ajuste) | `apps/backend/src/modules/fiscal/write-off/write-off-pending.service.ts`, hooks em `stock-reclassification.service.ts::decideDiscard` e `inventory-count-execution.service.ts::decideAdjustment` | `fiscal-estoque.integration.spec.ts` — describe "RN-FIS-070 — descarte e ajuste negativo travam qty_pending_writeoff" (2 testes) |
| `DispatchService.confirmFiscalDocuments` (RN-FIS-040 ponto de integração DOC-06) | `apps/backend/src/modules/expedicao/dispatch/dispatch.service.ts` | exercitado indiretamente (fiscal_mode INTEGRADO_ERP inalterado, testado em `picking-packing-carregamento.integration.spec.ts`); caminho EMISSAO_PROPRIA/HIBRIDO coberto pelo `assembleAndAuthorizeForOrder` chamado por `confirmFiscalDocuments`, sem teste de integração dedicado ao pedido completo ponta a ponta nesta sessão (ver §5) |
| Catálogo de permissões `FIS.*` | migration `0069` | `grants-contract.integration.spec.ts` (tabelas novas) + boot real (`RouteAuditService`, ver §4) |
| Catálogo de exceções `FIS.PRAZO_ENTRADA_EXPIRADO`/`FIS.CONSUMO_MANUAL` | migration `0069` | exercitado por `FiscalConsumptionService`/`StorageReturnInvoiceService` (MANUAL) sem teste de integração dedicado (ver §5) |
| Contrato de permissões `wms_app`/`wms_worker` (tabelas novas) | `apps/backend/src/core/database/__tests__/grants-contract.integration.spec.ts` | o próprio teste |

---

## 3. Saída real dos comandos

### 3.1 Build

```
$ pnpm build (apps/backend)
> @wms/backend@0.0.1 build D:\WMS-New\apps\backend
> nest build
(sem erros)
```

### 3.2 Testes unitários (`pnpm test`, turbo, 8 pacotes)

```
@wms/backend:test:  Test Files  20 passed (20)
@wms/backend:test:       Tests  199 passed (199)
@wms/frontend:test:  Test Files  6 passed (6)
@wms/frontend:test:       Tests  35 passed (35)
(+ 2 outros pacotes: Test Files 2 passed (2) / Tests 19 passed (19))

 Tasks:    8 successful, 8 total
Cached:    0 cached, 8 total
  Time:    39.313s
```

199 testes unitários de backend (era 193 antes da sessão — +6 dos testes
puros de `fiscal-consumption.util.spec.ts`).

### 3.3 Testes de integração (`pnpm test:integration`, 2 execuções consecutivas)

```
$ pnpm test:integration   # execução 1
@wms/backend:test:integration:  Test Files  72 passed (72)
@wms/backend:test:integration:       Tests  309 passed (309)
@wms/backend:test:integration:    Start at  23:52:26
@wms/backend:test:integration:    Duration  166.54s (transform 2.66s, setup 8ms, collect 69.65s, tests 60.21s, environment 21ms, prepare 14.97s)

 Tasks:    6 successful, 6 total
Cached:    5 cached, 6 total
  Time:    2m50.981s

$ pnpm test:integration   # execução 2 (consecutiva, mesmo estado de banco)
@wms/backend:test:integration:  Test Files  72 passed (72)
@wms/backend:test:integration:       Tests  309 passed (309)
@wms/backend:test:integration:    Start at  23:55:35
@wms/backend:test:integration:    Duration  166.54s (transform 2.60s, setup 7ms, collect 68.85s, tests 61.24s, environment 21ms, prepare 14.73s)

 Tasks:    6 successful, 6 total
Cached:    5 cached, 6 total
  Time:    2m51.021s
```

309 testes de integração (era 302 antes da sessão — +7 do novo
`fiscal-estoque.integration.spec.ts`), zero skip, idênticos nas duas
execuções consecutivas. Único ruído nos logs: linhas `ERROR [DatabaseService]
Transaction failed` / `BadRequestException` — são as rejeições ESPERADAS dos
próprios cenários de teste (ex.: "saldo fiscal disponível: 1.000", "cobertura
restante de 300", prazo expirado), o `DatabaseService.transaction()` loga todo
`ROLLBACK` como erro por padrão, mesmo quando é o comportamento correto sendo
exercitado por `expect(...).rejects...`.

Teste novo desta sessão: `apps/backend/src/modules/fiscal/__tests__/fiscal-estoque.integration.spec.ts`
— 7 testes, todos os cenários Gherkin do §3 do prompt (exceto o de
contingência/CCe/cancelamento, que são da 8B). Mais
`apps/backend/src/modules/fiscal/consumption/__tests__/fiscal-consumption.util.spec.ts`
— 6 testes unitários puros (exemplo normativo de ordenação/alocação).

### 3.4 Docker compose + health check

```
$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-postgres Healthy
 Container wms-redis Healthy
 Container wms-minio Healthy
 Container wms-backend-api Started
 Container wms-backend-worker Started
 Container wms-backend-scheduler Started
 Container wms-frontend Started

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-24T02:46:43.771Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
```

Log de boot confirma `RouteAuditService`: `RN-SEG-012: todas as rotas REST e
handlers WebSocket declaram permissão. Boot liberado.` — nenhuma rota nova
desta sessão (`FiscalModeController`, `StorageInvoiceController`,
`StorageReturnInvoiceController`) ficou sem `@RequirePermission`.

---

## 4. Achado real durante a migração (documentado, não escondido)

A migration `0069` inicialmente falhou ao rodar contra o Postgres de
**desenvolvimento** (`docker-compose.yml`, volume persistente):

```
Error: Migration 69 failed: insert or update on table "fiscal_stock_balance"
violates foreign key constraint "fiscal_stock_balance_storage_invoice_fk"
```

Causa: `wms.fiscal_stock_balance` (migration `0014`) já tinha linha(s) com
`storage_remittance_invoice_id` solto (UUID gerado ad-hoc por
exploração/teste manual anterior — RG-014 nunca teve um ESCRITOR real antes
desta sessão, mas o volume de dev acumulou dado de teste mesmo assim). Como
`wms.fiscal_document` é criada na MESMA migration, nenhuma linha existente
pode legitimamente referenciá-la. Corrigido com um `DELETE` explícito e
restrito (não um `TRUNCATE` cego) imediatamente antes do `ADD CONSTRAINT`,
idempotente por natureza — ver comentário no bloco 5 da migration `0069`.
Rebuild + restart do `docker compose` confirmou a correção (migration 69
aplicada com sucesso, `wms.operation_nature` com as 4 linhas de seed GLOBAL).

Efeito colateral em testes PRÉ-EXISTENTES: dois arquivos já semeavam
`fiscal_stock_balance` com `storage_remittance_invoice_id` solto (UUID
literal, sem linha real em `fiscal_document`) — agora inválido com a FK real.
Corrigidos nesta sessão (criam um stub mínimo de `fiscal_document` antes):
`apps/backend/src/modules/expedicao/__tests__/outbound-order-release.integration.spec.ts`
(`seedFiscalStock`) e
`apps/backend/src/modules/cadastro/__tests__/stock-balance-constraints.integration.spec.ts`
(`seedFiscalDocumentStub`).

---

## 5. Decisões tomadas, com justificativa

1. **`FIS.ORDEM_CONSUMO` em `app_parameter` escopo `CLIENT_WAREHOUSE`, não
   coluna nova em `client_warehouse_settings`** — decisão já pré-tomada no
   prompt da sessão (não repetida aqui em detalhe); implementada em
   `FiscalConsumptionService.resolveConsumptionOrder()`: tenta a linha
   `CLIENT_WAREHOUSE` específica primeiro, cai para a linha `GLOBAL` (seed
   `FIFO_EMISSAO`) quando ausente, e cai para a constante `FIFO_EMISSAO` no
   código quando NEM a linha GLOBAL existir (defesa adicional: `app_parameter`
   é apagada entre arquivos de teste por `cleanTestData()`).

2. **NF de entrada NÃO ganha uma linha `fiscal_document` tipo `NF_ENTRADA`
   nesta sessão** — `wms.inbound_invoice` (DOC-04, migration `0036`) já
   modela o registro da NF de entrada e o prazo de regularização desde a
   Sessão 4B, com FK para `inbound_order` e `regularization_deadline`
   calculado no registro. Duplicar esse dado em `fiscal_document`
   fragmentaria a fonte única de verdade da NF de entrada. `'NF_ENTRADA'`
   permanece RESERVADO no `CHECK` de `document_type` (fechamento de catálogo
   pedido pelo prompt), sem nenhuma linha gravada com esse tipo nesta sessão.
   `InboundInvoiceFiscalService` é um serviço de CONTROLE (alertas,
   verificação de cobertura) que LÊ `wms.inbound_invoice` diretamente, não um
   escritor de `fiscal_document`.

3. **Cobertura da Nota de Armazenagem validada POR (produto × NF de entrada
   referenciada)**, não por agregado do produto inteiro — `RF-FIS-020` exige
   "referência à(s) NF de entrada" como parte da validação; modelado como
   `fiscal_document_item.reference_inbound_invoice_id` OBRIGATÓRIO (enforced
   em `StorageInvoiceService`, não em `CHECK` de banco — ver item 8) em
   itens de `NOTA_ARMAZENAGEM`. Quando uma Nota de Armazenagem cobre um
   produto vindo de MÚLTIPLAS NF de entrada (RN-FIS-021 permite
   explicitamente), o chamador submete uma linha por (produto × invoice), não
   uma coluna N:M — decisão de escopo, documentada no comentário da migration.

4. **Estados de `fiscal_document` alcançáveis nesta sessão**: `DRAFT`
   (Nota de Devolução montada), `REGISTRADA` (Nota de Armazenagem — documento
   que ENTRA já pronto) e `AUTHORIZED` — este último via o método explícito
   `StorageReturnInvoiceService.authorize()`, um SUBSTITUTO TESTÁVEL do
   retorno real da SEFAZ (bypassa `SIGNED`/`TRANSMITTED`, que dependem de
   assinatura/transmissão reais — Sessão 8B). `REJECTED`/`DENIED`/`CANCELLED`
   ficam reservados no `CHECK`, sem nenhuma transição produzida nesta sessão.
   Este design resolve a tensão entre "§2.1.1 pede DRAFT+registrado apenas" e
   "§2.6 pede um método de autorização chamável" do prompt: a autorização
   avança o estado (é o próprio propósito do método), mas não passa pelos
   estados que exigem SEFAZ de verdade.

5. **`FiscalConsumptionService`/`WriteOffPendingService` compartilham a MESMA
   ordenação de consumo** — a trava preventiva de `qty_pending_writeoff`
   (RN-FIS-070) usa `FiscalConsumptionService.selectForConsumption()` para
   decidir QUAIS notas travar, em vez de travar arbitrariamente a primeira
   linha encontrada. Não há regra explícita do DOC-08 sobre isso
   (`[LACUNA: DOC-08]`), mas usar a mesma ordem de consumo do produto é a
   leitura mais coerente (a baixa por perda "consome" lastro fiscal na mesma
   ordem que uma saída normal consumiria).

6. **`fiscal_pending_document.qty` registra a quantidade FÍSICA integral**
   descartada/ajustada, mesmo quando o crédito fiscal disponível é menor
   (capado pelo `CHECK qty_consumed + qty_pending_writeoff <= qty_credited`
   em cada linha de `fiscal_stock_balance`) — `[LACUNA: DOC-08]` não discute
   o caso de saldo fiscal insuficiente para cobrir a baixa; decisão: a
   pendência documental reflete o fato físico completo, e o `qty_locked_on_
   fiscal_balance` retornado pelo método (não persistido) permite auditar a
   diferença se necessário.

7. **`DispatchService.confirmFiscalDocuments()` idempotente por
   `fiscal_documents_authorized_at`** — chamada repetida sobre um pedido já
   confirmado devolve o pedido como está, sem tentar montar uma segunda Nota
   de Devolução (que duplicaria o consumo fiscal). Não estava no prompt
   explicitamente, mas é necessário para não violar RG-014 em retries.

8. **`reference_inbound_invoice_id` obrigatório em itens de `NOTA_ARMAZENAGEM`
   é validado em `StorageInvoiceService`, não em `CHECK`/trigger de banco** —
   um `CHECK` não alcança o `document_type` do documento pai sem um trigger
   dedicado; optado por validação de aplicação para manter o escopo da
   migration gerenciável. Documentado como decisão, não como lacuna.

9. **Formatação `pt-BR` (separador de milhar `.`) na mensagem de rejeição
   `"saldo fiscal disponível: 1.000"`** — o exemplo normativo do DOC-08 §4.4/§6
   escreve o número exatamente assim; implementado com
   `Intl.NumberFormat('pt-BR')` (ICU nativo do Node, sem dependência nova) em
   `apps/backend/src/modules/fiscal/shared/format-br-number.util.ts`, usado
   SOMENTE nesta mensagem específica (não alterada a mensagem pré-existente
   de `RN-EXP-002` em `outbound-order.service.ts`, que usa outro texto/rota
   diferente do exemplo normativo).

---

## 6. Confirmação explícita pedida no prompt (§5)

**Prazo de regularização (RN-FIS-010), ordem de consumo (RN-FIS-030) e
CFOP/naturezas (RN-FIS-050) são de fato reconfiguráveis por cliente×armazém
via cadastro, sem migration nova, para trocar o valor de um cliente
específico:**

- **Prazo**: `client_warehouse_settings.inbound_invoice_deadline_days`
  (coluna já existente, DOC-02) — um `UPDATE`/`PATCH` via
  `ClientWarehouseSettingsService.update()` já existente muda o prazo de um
  cliente×armazém específico sem migration. `FIS.PRAZO_ENTRADA_DIAS` (GLOBAL,
  seed 10) é o fallback de instalação — ver débito no item 2 de §7 sobre o
  fallback ainda não estar religado em `inbound-order.service.ts`.
- **Ordem de consumo**: uma linha `INSERT INTO wms.app_parameter (scope,
  name, value, warehouse_id, client_id) VALUES ('CLIENT_WAREHOUSE',
  'FIS.ORDEM_CONSUMO', 'LIFO_EMISSAO', <warehouse>, <client>)` — sem
  migration — muda a ordem daquele cliente×armazém especificamente;
  `FiscalConsumptionService.resolveConsumptionOrder()` lê essa linha antes do
  fallback GLOBAL.
- **CFOP/naturezas**: uma linha `INSERT INTO wms.operation_nature (tenant_id,
  warehouse_id, document_type, scope_type, cfop, ...)` — sem migration — cria
  o override daquele cliente×armazém; `resolveOperationNature()`
  (`apps/backend/src/modules/fiscal/shared/operation-nature.util.ts`) tenta
  essa linha específica antes do fallback GLOBAL (as 4 linhas seedadas na
  migration `0069`).

Nenhum dos três ficou hardcoded como constante de código — os três são
resolvidos em runtime via consulta ao banco, com fallback explícito.

---

## 7. Lacunas e débitos

1. `[LACUNA: DOC-08]` gatilho exato de ENTRADA do dado da Nota de Armazenagem
   (upload de XML / registro manual / integração DOC-13 / emissão delegada) —
   implementado apenas o registro MANUAL/já-extraído
   (`StorageInvoiceService.register()` recebe campos já parseados, sem parser
   de XML dedicado nesta sessão), mesma fronteira que o prompt aceita para as
   demais entradas fiscais desta sessão.
2. `[DEBITO: 8A]` `FIS.PRAZO_ENTRADA_DIAS` (fallback GLOBAL, seed 10 dias) NÃO
   está religado em `inbound-order.service.ts::createFromXml` — hoje esse
   método continua EXIGINDO `client_warehouse_settings.inbound_invoice_
   deadline_days` configurado (lança `DEADLINE_NOT_CONFIGURED` se nulo).
   Tocar nesse arquivo estava fora do escopo declarado desta sessão (é DOC-04,
   não DOC-08) — o parâmetro está seedado e pronto para uso quando essa
   integração for feita.
3. `[DEBITO: 8A]` Sem teste de integração dedicado para: a trava de
   imutabilidade de `FiscalModeService.changeFiscalMode()` (RN-FIS-001); o
   caminho `MANUAL` de `RN-FIS-030` com exceção `FIS.CONSUMO_MANUAL`
   aprovada; override de `operation_nature`/`FIS.ORDEM_CONSUMO` por cliente
   específico (a mecânica está testada via `fiscal-consumption.util.spec.ts`
   e a resolução de escopo é a mesma já testada em
   `core/app-parameter/__tests__/scope-resolution.integration.spec.ts`, mas
   não haviam ainda testes fiscais dedicados a essas trilhas). Comportamento
   coberto por inspeção de código, não por teste automatizado — próxima
   sessão que tocar o módulo fiscal deveria fechar isso.
4. `[DEBITO: 8A]` `DispatchService.confirmFiscalDocuments()` para
   `EMISSAO_PROPRIA`/`HIBRIDO` não tem um teste de integração ponta a ponta
   dedicado dentro do fluxo completo de expedição (pedido → picking → packing
   → pesagem → **expedição fiscal real** → carregamento → saída) — o teste de
   MARCO existente (`picking-packing-carregamento.integration.spec.ts`) usa
   `INTEGRADO_ERP` (ramo não alterado por esta sessão). A lógica de
   `confirmFiscalDocuments` para os outros dois modos está coberta
   indiretamente pelos testes de `StorageReturnInvoiceService` (que é
   exatamente o que `confirmFiscalDocuments` chama), mas não com o pedido
   real passando por todas as etapas anteriores.
5. `[LACUNA: DOC-08]` RN-FIS-010 item 4 ("operação excepcional além do prazo
   ... acionável mediante exceção `FIS.PRAZO_ENTRADA_EXPIRADO`") — o catálogo
   de exceção existe (migration `0069`), mas o ponto de integração exato
   (como um usuário aciona essa exceção para FORÇAR uma liberação bloqueada
   por prazo expirado) não foi implementado — `outbound-order.service.ts::
   release()` bloqueia incondicionalmente quando `hasExpiredUncoveredDeadline`
   é verdadeiro, sem checar se existe uma exceção aprovada. DOC-08 não detalha
   o mecanismo exato de override; documentado aqui como lacuna real, não
   escondida.
6. `[DEBITO: 8A]` Naturezas de operação (`operation_nature`) seedadas apenas
   para `NOTA_ARMAZENAGEM`/`NOTA_DEVOLUCAO_ARMAZENAGEM` — `NF_TRANSFERENCIA`
   (transferência entre armazéns do operador, DOC-08 §4.6) fica sem seed
   porque o tipo de documento correspondente (`NF_TRANSFERENCIA`) está
   reservado/não usado nesta sessão (fora do escopo declarado).

---

## 8. Eventos de domínio publicados nesta sessão

`fiscal.nota_armazenagem_registrada`, `fiscal.saldo_fiscal_creditado`,
`fiscal.emissao_solicitada`, `fiscal.nota_autorizada`,
`fiscal.consumo_efetivado`, `fiscal.consumo_estornado`,
`fiscal.pendencia_documental_criada`. Não publicados nesta sessão (dependem
do motor de emissão real, 8B): `fiscal.prazo_entrada_alerta` (nome do §4.9;
implementado como alerta do painel `PRAZO_FISCAL_EXPIRADO`, não como evento
de domínio dedicado — `[LACUNA: DOC-08]` não distingue claramente evento de
domínio × alerta de painel para este caso, e o painel já cobre o requisito
funcional "o scheduler DEVE emitir alertas"), `fiscal.prazo_entrada_expirado`
(idem), `fiscal.nf_entrada_registrada` (não aplicável — não escrevemos
`fiscal_document` para NF_ENTRADA, decisão 2 de §5), `fiscal.nota_rejeitada`,
`fiscal.nota_cancelada`, `fiscal.cce_registrada`, `fiscal.contingencia_
ativada` (todos 8B).

---

## 9. Arquivos desta sessão

Migration: `infra/postgres/migrations/0069-fiscal-estoque.sql`.

Módulo fiscal (novo): `apps/backend/src/modules/fiscal/**` (fiscal.module.ts,
fiscal-mode/, storage-invoice/, consumption/, storage-return-invoice/,
write-off/, inbound-invoice/, shared/, __tests__/).

Worker novo: `apps/backend/src/workers/inbound-invoice-deadline.worker.impl.ts`.

Hooks/integração: `stock-reclassification.service.ts`,
`inventory-count-execution.service.ts`, `outbound-order.service.ts`,
`dispatch.service.ts`, `estoque.module.ts`, `expedicao.module.ts`,
`document-numbering.service.ts`, `alert.service.ts`, `main.ts`.

Testes de contrato/ripple de assinatura de construtor (nenhuma mudança de
comportamento nos cenários pré-existentes, só injeção da dependência nova):
`grants-contract.integration.spec.ts`,
`stock-balance-constraints.integration.spec.ts`,
`campo-col2a.integration.spec.ts`,
`stock-block-reclassification.integration.spec.ts`,
`inventory-execution.integration.spec.ts`,
`outbound-flow-navigation.integration.spec.ts`,
`outbound-order-release.integration.spec.ts`,
`picking-packing-carregamento.integration.spec.ts`,
`wave-and-reservation-expiry.integration.spec.ts`,
`kpi-materialization.integration.spec.ts`,
`operations-board.integration.spec.ts`.
