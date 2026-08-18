# Relatório — Sessão 6A: Pedido e Fluxo Operacional (DOC-06 §4.1–§4.3, §4.8)

**Data**: 2026-08-18
**Escopo**: Pedido (criação, liberação com validação física e fiscal, reserva), a máquina de estados normativa do Fluxo Operacional com as regras de navegação da RG-002, ondas, e o motor de estornos/cancelamento. Picking→carregamento é a 6B.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md` (v1.4.0), `docs/DOC-06-expedicao.md`, `docs/relatorios/SESSAO-5B-relatorio.md`.

---

## 1. Resumo executivo

Implementa a **RG-002** — o requisito que originou o projeto (fluxo verde/vermelho sem salto de etapas).

`pnpm build` limpo; **unit 13/13 arquivos, 136/136 testes**; **integração 61/61 arquivos, 215/215 testes**, em 2 execuções consecutivas.

**Decisão estrutural**: a tabela normativa das 8 etapas (RN-EXP-010), o mapa de estados, o estorno por etapa (RN-EXP-070) e as janelas de cancelamento (RN-EXP-071) vivem numa função **pura** (`outbound-flow.util.ts`), testável sem banco — mesmo padrão da 4B e 5B. A guarda de ordem fica no **serviço** (`core/OperationFlowService.completeStep`), nunca no controller, para que nenhum caminho de API a contorne.

---

## 2. Entregável 0 — teste de contrato de permissões: JÁ EXISTIA

O prompt pedia "[PRIMEIRO, se ainda não existir]". Ele **já existe**: foi criado ao final da Sessão 5B, a pedido do usuário, em `apps/backend/src/core/database/__tests__/grants-contract.integration.spec.ts` (commit `738d2a5`).

E provou seu valor **duas vezes nesta sessão**: falhou na hora ao adicionar `outbound_order`/`outbound_order_item`/`wave`/`wave_order` sem declará-las, e de novo ao conceder `wms_worker` em `stock_reservation`/`outbound_order_item` para o job de expiração — em vez de o erro aparecer como `permission denied` no meio de um teste funcional, como vinha acontecendo desde a 5A.

---

## 3. A consolidação do `operation_flow` (decisão pedida pelo prompt)

O prompt determinava: *"Se o recebimento (4A) já criou algo equivalente a `operation_flow`, CONSOLIDE numa estrutura única — não crie uma segunda."*

**A 4A já criou** (migration 0034), e explicitamente como estrutura genérica: o comentário da própria migration diz *"máquina de fluxo genérica reutilizável entre módulos ... desenhado para ser reaproveitado por outros módulos operacionais (DOC-06/07)"*. **Nenhuma segunda estrutura foi criada.**

O que existia já cobria 3 das 6 regras de RN-EXP-011:

| Regra RN-EXP-011 | Estado antes da 6A | Ação nesta sessão |
|---|---|---|
| 1. DONE=verde, PENDING=vermelho | ✅ `flow_step.status` | — |
| 2. única acionável = primeira PENDING | ✅ `annotateCurrentStep` | estendida no contrato novo |
| 3. violação → `FLOW_STEP_ORDER_VIOLATION` **no serviço** | ✅ `completeStep` | — |
| 4. etapa DONE abre em consulta | ⚠️ implícito | `opens_read_only` no contrato |
| 5. exceção pendente mantém vermelha + bloqueio | ❌ ausente | **coluna `flow_step.blocking_exception_id` + guarda em `completeStep`** |
| 6. conclusão publica evento (≤2 s) | ❌ ausente | publicado na camada de expedição (ver abaixo) |

Extensões feitas no core (todas **aditivas** — o DOC-04 seguiu passando sem alteração, 46/46):
- `flow_step.blocking_exception_id` (NULLable): fluxos existentes não mudam de comportamento;
- `getFlowState()`: contrato único de leitura que o DOC-10 consumirá;
- `linkBlockingException()` / `clearBlockingException()`;
- guarda `STEP_BLOCKED_BY_EXCEPTION` dentro de `completeStep` — genérica, vale para DOC-04/06/07.

**O evento ficou na camada de expedição, não no core**: `expedicao.etapa_concluida` tem payload "pedido, etapa, nº ordem" (§4.9) — é evento de DOMÍNIO, não do fluxo genérico (o DOC-04 nunca publicou um `recebimento.etapa_concluida`). Pôr o `EventsService` no core obrigaria a mudar o construtor e os 5 testes do DOC-04 que já passavam. `OutboundFlowService.completeOrderStep` é o **ponto único** de conclusão de etapa do pedido, então o evento nunca depende de o chamador lembrar.

---

## 4. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **RF-EXP-001** criação, numeração PED, conversão RN-DAD-021 | `expedicao/order/outbound-order.service.ts` (`create`, `convertToBaseUom`), migration `0050` | `outbound-order-release.integration.spec.ts`: número `PED-`, 5 caixas × 12 = 60 UN, 8 etapas instanciadas |
| **RN-EXP-002 [INVIOLÁVEL]** validação item a item | `outbound-order.service.ts` (`release`, `loadBlockingStatus`, `loadAvailableFiscalStock`) | §6 saldo fiscal ("disponível 600") + liberação parcial + produto bloqueado sem efeito |
| **RN-EXP-003 [INVIOLÁVEL]** reserva e expiração | `outbound-order.service.ts`, `order/reservation-expiry.service.ts`, `workers/reservation-expiry.worker.impl.ts` | reserva real available→reserved com detalhamento por ITEM; expiração devolve saldo e marca `RELEASED_EXPIRED`; re-liberação funciona |
| **RN-EXP-010 [INVIOLÁVEL]** 8 etapas e estados | `order/outbound-flow.util.ts` (puro), `order/outbound-flow.service.ts` | `outbound-flow.util.spec.ts` (12 unit) + integração (ordem das 8 etapas, estado por etapa) |
| **RN-EXP-011 [INVIOLÁVEL]** 6 regras de navegação | `core/operation-flow/operation-flow.service.ts` (regras 1-5), `outbound-flow.service.ts` (regra 6) | §6 navegação sem salto; §6 violação via API; regra 5 com exceção pendente travando o fluxo |
| **RF-EXP-020** ondas | `expedicao/wave/wave.service.ts` + controller, migration `0050` | agrupa/vincula/liberação publica gatilho da 6B; só RELEASED entra; não entra em duas; `EXP.ONDA_MAX_PEDIDOS` |
| **RN-EXP-070 [INVIOLÁVEL]** estorno por etapa | `order/outbound-reversal.service.ts` (`reverseStep`, handlers) | estorno da liberação desfaz reserva integralmente; exige `EXP.ESTORNO`; exige exceção APROVADA; **proibido após GATE_OUT** |
| **RN-EXP-071** cancelamento | `outbound-reversal.service.ts` (`cancel`), `outbound-flow.util.ts` (`cancellationWindow`) | direto em RELEASED libera reservas; tardio exige `EXP.CANCELAMENTO_TARDIO` (2 passos); proibido após GATE_OUT |
| **Catálogos §3/§4.9** | migration `0050`, `packages/contracts/src/realtime-topics.ts` | consumidos por todos os testes acima; grants validados pelo contrato de permissões |

**Totais**: unit **13 arquivos / 136 testes** (+12 nesta sessão); integração **61 arquivos / 215 testes** (+21 nesta sessão).

---

## 5. Achados reais desta sessão

### 5.1 O schema proíbe `DELETE` — e estava certo

A liberação parcial precisava tirar o item pendente do pedido original. Escrevi `DELETE FROM wms.outbound_order_item` e o teste falhou com `permission denied`: `wms_app` não tem `DELETE` em tabela de negócio (RG-003, rastreabilidade — há um teste dedicado, `business-table-delete-denied.integration.spec.ts`).

A barreira apontou um erro de desenho meu, não do schema: apagar a linha destruiria o registro do que foi originalmente pedido. Trocado por `outbound_order_item.moved_to_order_id` — o item permanece, com o vínculo para onde migrou, e some das leituras do pedido por `moved_to_order_id IS NULL`.

### 5.2 Expiração de reserva NÃO desfaz a etapa do fluxo

A re-liberação após expiração quebrava com `FLOW_STEP_ORDER_VIOLATION` contra a própria etapa `PEDIDO` já concluída. A regra correta: RN-EXP-003 devolve o pedido a `RELEASED_EXPIRED` *"para nova liberação"*, mas a liberação original **de fato aconteceu** — desfazer a etapa é privilégio do **estorno** (RN-EXP-070), não da expiração. `release()` agora só conclui a etapa quando ela ainda está `PENDING`.

### 5.3 `RELEASED_EXPIRED` não pode ser estado persistido

O prompt dizia "devolvendo a `RELEASED_EXPIRED`", mas o §5.1 afirma que ele é *"substado de `RELEASED` exibido como alerta"* e ele **não aparece no diagrama de estados**. REG-GLO-004 [INVIOLÁVEL] proíbe criar estados ausentes do diagrama.

Resolução: persistido como `(status='RELEASED', reservation_expired=true)`, com CHECK garantindo que o substado só existe sobre `RELEASED`, e exposto como estado **derivado** `RELEASED_EXPIRED` na leitura (`deriveDisplayStatus`). O consumidor vê o que o prompt pedia; o dado obedece o documento. Travado por teste unitário e de integração (`persisted_status` × `status`).

### 5.4 `DISPATCH_OK` também não existe no diagrama

A linha 5 da tabela RN-EXP-010 diz "`IN_DISPATCH` concluída = `DISPATCH_OK`", mas `DISPATCH_OK` não está no §5.1 nem no glossário. Mesma regra (REG-GLO-004): adotado `IN_DISPATCH` como estado ao concluir a etapa Expedição — a distinção "concluída" já está representada pela etapa `EXPEDICAO` estar `DONE`. Registrado como `[LACUNA]` no código.

### 5.5 Dois erros de fixture que a base já conhecia

Ambos reincidentes, e ambos silenciosos:
- `queryGlobal` em tabela com RLS (`app_parameter`, `event_outbox`) afeta/lê **0 linhas sem erro** — o mesmo erro registrado no relatório da 4B;
- `cleanTestData()` **apaga `app_parameter`** entre arquivos, então testar um parâmetro exige `INSERT`, não `UPDATE` do valor semeado pela migration (memória do projeto). Sem isso o teste do limite de onda passaria testando o default.

### 5.6 Exceções de 2 passos exigem 2 aprovadores distintos

`EXP.CANCELAMENTO_TARDIO` e `EXP.ESTORNO_POS_FISCAL` são de 2 passos (§3). O helper do teste aprovava uma vez só e a exceção ficava `PENDING` no passo 2 — RN-SEG-043 exige aprovadores **distintos entre si**. O fixture passou a ter um segundo aprovador. Também descoberto que uma exceção sem `approval_authority` configurada nasce `ESCALATED` (RN-SEG-021), e a regra 5 de RN-EXP-011 precisa bloquear igual — o teste agora prova os dois estados.

---

## 6. Lacunas e débitos

**Em aberto:**

- **`[DEBITO: 6B]` handlers de estorno de PICKING/EMBALAGEM/PESAGEM/EXPEDICAO/CARREGAMENTO** — o motor, a exigência de exceção por etapa e a proibição pós-gate-out estão ativos e testados; os handlers que desfazem os efeitos dessas etapas dependem dos efeitos que a 6B vai criar. Recusam com erro explícito em vez de "passar" sem desfazer nada — RN-EXP-070 exige atomicidade, e um estorno silenciosamente vazio marcaria a etapa como desfeita sem desfazer.
- **`[DEBITO: 6B]` cascata do cancelamento tardio** — `cancel()` valida a janela e a exceção `EXP.CANCELAMENTO_TARDIO` aprovada, e então declara o débito da cascata. O cancelamento direto (`DRAFT`/`RELEASED`) está completo.
- **`[DEBITO: 6B]` geração das tarefas na liberação da onda** — a onda, seus limites e a ordem de entrada dos pedidos estão persistidos; `expedicao.onda_liberada` é o gatilho que a 6B consumirá para RF-EXP-030.
- **`[LACUNA: DOC-08]` alocação fiscal por nota** — RN-EXP-002 item 2 pede apenas SUFICIÊNCIA total, que é o que foi implementado (`qty_credited − qty_consumed`, cálculo que a migration 0014 fixou como "sempre calculado, nunca persistido"). O prompt mencionava `qty_pending_writeoff`, coluna que **não existe** nesta base — baixas em curso ainda não são um conceito modelado; quando o DOC-08 as introduzir, a subtração entra em `loadAvailableFiscalStock`.
- **`[LACUNA]` flag de "cliente controla Estoque Fiscal"** — nem DOC-06 nem DOC-02 a definem. Adotado `fiscal_mode ∈ ('EMISSAO_PROPRIA','HIBRIDO')`, por eliminação: o DOC-00 §3.1 (v1.4.0) associa `INTEGRADO_ERP` ao caso em que "o ERP da empresa responde pelo fiscal".
- **`[LACUNA]` `EXP.PESO_MANUAL`** — citada em §4.5/§4.6 mas ausente do catálogo de permissões do §3. Fora de escopo desta sessão (pesagem é 6B); registrada para a 6B decidir.
- **DOC-00 v1.4.0 (RG-016, modos de operação)** — a especificação subiu de versão durante esta sessão, introduzindo `APP.MODO_OPERACAO` (`TRES_PL`/`PROPRIO`) e a necessidade N29. **Nada nesta sessão depende do modo**: RG-016 item 1 é explícito que `PROPRIO` é o caso particular de `TRES_PL` com um tenant, sem caminho de código alternativo. A única interação foi usar o §3.1 como fundamento para a leitura de `fiscal_mode` acima. A implementação do parâmetro e da validação de segundo cliente é do DOC-02, não desta sessão.

**Fora de escopo confirmado**: picking, packing, pesagem, expedição documental, carregamento e saída (§4.4–§4.7 — Sessão 6B); alocação fiscal por nota e emissão de NF-e (DOC-08); painel e KPIs (DOC-10); telas de coletor (DOC-15); inventários (5C); e tudo do DOC-06 §8.

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  13 passed (13)
     Tests  136 passed (136)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  61 passed (61)
     Tests  215 passed (215)
Test Files  61 passed (61)
     Tests  215 passed (215)

$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-api | grep RN-SEG-012
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.

$ docker logs wms-backend-scheduler | grep "Scheduler service started"
[Bootstrap] ✓ Scheduler service started (partition-manager + exception-expiry + no-show + crossdock-aging + expiration-alert + replenishment-alert + reservation-expiry)

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-18T21:28:34.760Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version FROM wms.schema_migration WHERE version >= 48 ORDER BY version"
 48
 49
 50
```

---

## 8. Commit/push

Nenhum commit foi feito. Aguardando confirmação explícita do usuário, conforme padrão de todas as sessões anteriores.

**Nota sobre o DOC-00**: `docs/DOC-00-documento-mestre.md` está modificado na árvore de trabalho (subiu para v1.4.0 com RG-016/modos de operação, N29). Essa alteração é do usuário, não desta sessão; incluí-la ou não no commit é decisão dele.
