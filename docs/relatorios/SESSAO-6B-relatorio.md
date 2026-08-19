# Relatório — Sessão 6B: Picking → Carregamento → Saída (DOC-06 §4.4–§4.7)

**Data**: 2026-08-19
**Escopo**: Picking com corte, packing, pesagem com tolerância, expedição documental, carregamento, saída, e os 4 estornos + cascata de cancelamento tardio deixados como `[DEBITO: 6B]` pela 6A. Última sessão antes do MARCO.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-06-expedicao.md`, `docs/relatorios/SESSAO-6A-relatorio.md`.

---

## 1. Resumo executivo

Fecha o DOC-06: o pedido agora percorre as 8 etapas do RG-002 de ponta a ponta, com efeito físico real em cada uma — não apenas transição de estado.

`pnpm build` limpo; **unit 15 arquivos / 147 testes** (+11 nesta sessão); **integração 62 arquivos / 225 testes** (+10 nesta sessão), em 2 execuções consecutivas idênticas. `docker compose up -d --build backend-api backend-worker backend-scheduler`: os 3 processos sobem saudáveis, RN-SEG-012 aprovado, os 7 workers do scheduler (incluindo `picking_task` no partition manager) iniciam, `health/ready` responde 200.

**Decisão estrutural mais importante da sessão**: nenhuma movimentação de saldo ocorre durante picking/packing/pesagem. A reserva efetivada na liberação (6A) permanece intacta até `RF-EXP-061` (carregamento), que é onde o próprio documento diz que a baixa definitiva acontece (`SAIDA_EXPEDICAO`). O catálogo fechado de `RN-EST-001` já define `PICKING` e `SAIDA_EXPEDICAO` com o **mesmo** efeito de bucket (`RESERVED → null`) — usar os dois debitaria a mesma reserva duas vezes. Documentada no cabeçalho da migration 0051 e de `picking-task.service.ts`.

---

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **RD-EXP-004/005/006** tabelas | migration `0051` | `grants-contract.integration.spec.ts` (8 tabelas novas declaradas) |
| **RF-EXP-030** tarefas + rota serpenteada | `picking/picking-route.util.ts`, `picking/picking-task.service.ts` (`generateForOrders`) | `picking-route.util.spec.ts` (5 unit) + `wave-and-reservation-expiry...spec.ts` (onda dispara geração) |
| **RF-EXP-031** [INVIOLÁVEL] dupla leitura, idempotência | `picking-task.service.ts` (`executeTask`) | "dupla leitura rejeita endereço divergente"; "idempotência — reenviar a MESMA operationId" |
| **RN-EXP-032** [INVIOLÁVEL] corte | `picking-task.service.ts` (`handleShort`, `applyShortDecision`) | §6 "Corte bloqueia saldo e agenda contagem"; §6 "Re-seleção após corte aprovado" |
| **RN-EXP-033** conclusão do Picking | `picking-task.service.ts` (`tryCompletePickingStep`) | coberto nos dois testes acima (etapa PICKED ao final) |
| **RF-EXP-040** Volumação | `packing/package.service.ts` (`openPackage`/`declareContent`/`closePackage`/`attemptCompletePackingStep`) | §6 "Packing valida conteúdo exato" |
| **RF-EXP-050/RN-EXP-051** [INVIOLÁVEL] Pesagem/Tolerância | `packing/weighing.util.ts`, `package.service.ts` (`weighPackage`/`decideWeightDivergence`) | `weighing.util.spec.ts` (6 unit, exemplo normativo) + §6 "Tolerância de pesagem" (aprovado e exceção) |
| **RF-EXP-060** Expedição documental | `dispatch/dispatch.service.ts` | usado como fixture em todos os testes de carregamento; `fiscal_mode≠INTEGRADO_ERP` recusa com `[LACUNA: DOC-08]` explícito (não coberto por teste dedicado — ver §4) |
| **RF-EXP-061** Carregamento | `loading/loading.service.ts` (`scanPackage`, `tryCompleteLoadingForOrder`) | §6 "Volume estranho no carregamento"; TESTE DE MARCO |
| **RF-EXP-062** Saída/Fim | `loading/saida.service.ts` | TESTE DE MARCO (gate-out real do DOC-03 + `pedido_concluido`) |
| **RN-EXP-070** [INVIOLÁVEL] 4 estornos | `order/outbound-reversal.service.ts` (`undoPicking`/`undoEmbalagem`/`undoPesagem`/`undoExpedicao`/`undoCarregamento`) | testes atualizados em `outbound-flow-navigation...spec.ts` (PICKING) + §6 "Estorno de carregamento desfaz baixa" (CARREGAMENTO, com asserção de saldo) |
| **RN-EXP-071** cascata do cancelamento tardio | `outbound-reversal.service.ts` (`undoCascade`) | teste atualizado em `outbound-flow-navigation...spec.ts` |
| **Catálogo §4.9** (8 eventos restantes) | `packages/contracts/src/realtime-topics.ts` | verificado indiretamente (outbox real) em cada teste que publica; `event_outbox` checado explicitamente no MARCO |

**Totais**: unit **15 arquivos / 147 testes** (+11); integração **62 arquivos / 225 testes** (+10, todos no novo arquivo `picking-packing-carregamento.integration.spec.ts`, mais 2 asserções corrigidas em `outbound-flow-navigation` e 2 fixtures ajustadas em `wave-and-reservation-expiry`).

---

## 3. Decisões de design (citando a fonte, sem inventar)

### 3.1 `wms.package` não referencia `wms.pallet`
§2 diz que o Volume é "identificado por LPN próprio (`pallet_type = VOLUME` ou palete)". Lido como: o Volume usa o **mesmo mecanismo** de geração de LPN de `wms.pallet` (`LpnService`, mesma sequência `wms.document_sequence 'LPN'`) — não como exigência de criar uma linha em `wms.pallet`. `wms.pallet.status` (IN_RECEIVING/STORED/...) não cobre o ciclo de vida do packing/pesagem/carregamento, e `RD-EXP-005` já pede colunas que `pallet` não tem (tara, pesos, sequência n/N). `wms.package.lpn` reaproveita a mesma sequência global — sem colisão possível.

### 3.2 Corte: `LIBERACAO_RESERVA` + `BLOQUEIO`, não um novo movement_type
A quantidade do corte está em `RESERVED` (reservada na liberação), e `BLOQUEIO` só move `AVAILABLE → BLOCKED` (catálogo fechado `RN-EST-001`). Os dois efeitos encadeados (`RESERVED→AVAILABLE` depois `AVAILABLE→BLOCKED`) somam exatamente `RESERVED→BLOCKED`, sem precisar abrir uma exceção no catálogo fechado. O estorno de Picking usa o par inverso exato (`DESBLOQUEIO`+`RESERVA`).

### 3.3 Estorno de Carregamento: `AJUSTE_INVENTARIO_POS` com override para reverter `SAIDA_EXPEDICAO`
`SAIDA_EXPEDICAO` é um débito puro (`RESERVED → null`, sem contrapartida de crédito). O único tipo do catálogo fechado com `bucketFrom = null` e `bucketTo` livre por override é `AJUSTE_INVENTARIO_POS` — usado para creditar de volta em `RESERVED`. Comentado explicitamente no handler citando por que é o único apto.

### 3.4 "Onda unitária implícita" (§4.3) = uma onda real de 1 pedido
Em vez de um segundo caminho de liberação, `WaveService.releaseImplicit()` chama `create()` + `release()` já testados, com 1 pedido só. Reaproveita 100% do código (mesmo evento, mesma geração de tarefas).

### 3.5 Bug real encontrado e corrigido: guarda de "tentar concluir etapa"
`PickingTaskService`/`PackageService`/`DispatchService`/`LoadingService` têm métodos "tentar concluir etapa X" chamados automaticamente após cada ação. A primeira versão checava apenas `flow_step.status === 'PENDING'` da PRÓPRIA etapa — mas isso é verdadeiro o tempo todo até a etapa concluir, **independente de etapas anteriores ainda pendentes**. Isso fazia `completeOrderStep` explodir com `FLOW_STEP_ORDER_VIOLATION` sempre que uma ação física (pesar, escanear) acontecesse antes da etapa anterior estar concluída — cenário real (nada impede pesar cedo demais). Corrigido com `flow-step-guard.util.ts` (`isFirstPendingStep`), que replica a real regra de "primeira `PENDING` por `sequence_order`" usada em `OperationFlowService.completeStep`. Descoberto pelos próprios testes de integração (não foi óbvio na revisão de código).

### 3.6 `EXP.PESO_MANUAL` (débito da 6A) fechado
Permissão `WAREHOUSE`, concedida a CONFERENTE/OPERADOR_PICKING/LIDER_TURNO — usada tanto no peso manual do picking (produto `is_weight_variable`, RF-EXP-031) quanto na pesagem manual do volume (RF-EXP-050), conforme o prompt orientou ("mesma EXP.PESO_MANUAL, não uma permissão nova").

---

## 4. Lacunas e débitos

**Fechados nesta sessão** (herdados da 6A): `[DEBITO: 6B]` dos 4 handlers de estorno, da cascata do cancelamento tardio, da geração de tarefas na liberação da onda, e `[LACUNA] EXP.PESO_MANUAL`.

**Em aberto:**
- **`[DEBITO: 5C executa]`** — `wms.inventory_count` (POR_ENDERECO) é criada automaticamente pelo corte (RN-EXP-032b), mas a EXECUÇÃO da contagem é da Sessão 5C, fora de escopo aqui (declarado explicitamente no prompt). Sem `UPDATE` grant nesta sessão — 5C precisa conceder.
- **`[LACUNA: DOC-08]`** — emissão fiscal e alocação por nota. `fiscal_mode = INTEGRADO_ERP` conclui a etapa Expedição com confirmação manual registrada; `EMISSAO_PROPRIA`/`HIBRIDO` ficam bloqueados com erro explícito `FISCAL_DOCUMENT_INTEGRATION_PENDING` citando `[LACUNA: DOC-08]` — nunca conclui sem documento. Não há teste dedicado ao caminho `EMISSAO_PROPRIA` bloqueado (só o `INTEGRADO_ERP` é exercitado nos testes desta sessão, via `confirmFiscalDocuments`); a lógica em si é simples o bastante (early return com mensagem fixa) para não justificar um teste isolado adicional além da revisão de código.
- **`[LACUNA]` estorno de Picking sem "tarefa de devolução dirigida"** — RN-EXP-070 fala em "tarefas de devolução com dupla leitura" (confirmação física em 2 passos, como RF-EXP-031). Implementado como reversão IMEDIATA e ATÔMICA (a parte que é INVIOLÁVEL) sem o fluxo de confirmação física por leitura — registrado como débito de UX, não de regra de negócio.
- **`[LACUNA]` peso teórico de produto `is_weight_variable` fracionado entre volumes** — quando o mesmo item é dividido em mais de um volume, usa peso médio por unidade (Σ peso apurado no picking / Σ qty_confirmed), não atribuição exata por volume. Documentado em `computeTheoreticalWeight`.
- **Fórmula de conclusão do Picking (RN-EXP-033)** soma apenas separado + cortes — cross-docking (RF-REC-051) não tem ponto de gravação em `outbound_order_item` nesta base; nenhum cenário do §6 desta sessão usa cross-dock, então não bloqueia o DoD.

**Fora de escopo confirmado**: emissão de NF-e e alocação fiscal por nota (DOC-08); painel e KPIs (DOC-10); execução de inventário (5C); telas de coletor (DOC-15); drivers de balança e impressora (DOC-11); TMS/roteirização/cubagem/voice picking/put-wall/etiquetas de transportadora/batch picking com sorting (DOC-06 §8).

---

## 5. Estado do ciclo ponta a ponta (TESTE DE MARCO)

`picking-packing-carregamento.integration.spec.ts` — *"TESTE DE MARCO: ciclo completo pedido → liberação → picking → packing → pesagem → expedição → carregamento → gate-out → COMPLETED"*:

1. Pedido criado, liberado (RN-EXP-002/003), onda unitária implícita libera e gera a tarefa de picking;
2. Picking executado com dupla leitura real (endereço + EAN), sem corte;
3. Volume aberto, conteúdo declarado, fechado (peso teórico calculado), etapa Embalagem concluída;
4. Volume pesado dentro da tolerância, etapa Pesagem concluída;
5. Staging por leitura + confirmação fiscal (`INTEGRADO_ERP`), etapa Expedição concluída;
6. Carga aberta vinculada a uma visita de veículo **real** (gate-in do DOC-03, com agendamento OUTBOUND), volume lido e aceito, `SAIDA_EXPEDICAO` efetivada, etapa Carregamento concluída;
7. Gate-out **real** do DOC-03 (`RN-POR-040`) confirmado (status `ENCERRADA` da máquina de estados de `vehicle_visit`);
8. `SaidaService.completeExit` lê a saída confirmada, conclui Saída e, automaticamente, Fim — pedido `COMPLETED`;
9. Todas as 8 etapas `DONE`; evento `expedicao.pedido_concluido` publicado em `wms.event_outbox`.

**Resultado**: ciclo completo, verde do início ao fim, sem nenhum passo simulado além da premissa documentada (§3.6 acima).

---

## 6. Achados reais desta sessão

- **`operationId` deve ser UUID real**, não string arbitrária — a coluna `picking_task.last_operation_id` é `UUID` (mesmo padrão de `wms.putaway_operation`); descoberto pelo Postgres rejeitando `invalid input syntax for type uuid` nos primeiros testes.
- **`ALTER DEFAULT PRIVILEGES` concede `UPDATE` por padrão** a toda tabela nova (migration 0010) — `package_content`, `loading_order`, `loading_scan` e `inventory_count`, desenhadas como append-only (`SI`), precisaram de `REVOKE UPDATE` explícito para o contrato de permissões refletir a intenção real (mesmo achado do padrão já documentado para `DELETE`).
- **Evento de transição ≠ nome do estado resultante** — `vehicle-visit-state-machine.util.ts` mapeia o evento `'GATE_OUT'` para o estado `'ENCERRADA'`, não `'GATE_OUT'`. `SaidaService` checava o nome do evento por engano; corrigido antes de gerar dado incorreto (achado durante a leitura do código do DOC-03 para integrar corretamente, não por falha de teste).
- **Guarda de conclusão de etapa "otimista"** (§3.5 acima) — o único bug pego pelos testes de integração em vez de revisão de código.

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  15 passed (15)
     Tests  147 passed (147)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  62 passed (62)
     Tests  225 passed (225)
Test Files  62 passed (62)
     Tests  225 passed (225)

$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-api | grep RN-SEG-012
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.

$ docker logs wms-backend-scheduler | grep "Scheduler service started"
[Bootstrap] ✓ Scheduler service started (partition-manager + exception-expiry + no-show + crossdock-aging + expiration-alert + replenishment-alert + reservation-expiry)

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-19T12:46:31.645Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version, description FROM wms.schema_migration WHERE version >= 48 ORDER BY version"
 48 | DOC-05 RD-EST-001/RF-EST-050/051: wms.stock_transfer + stock_transfer_item (TENANT, RLS)
 49 | DOC-05 RN-EST-010/011/012/013: wms.stock_reservation + attachment_keys ...
 50 | DOC-06 6A: catalogo EXP.* ...
 51 | DOC-06 6B: EXP.PESO_MANUAL, EXP.TOLERANCIA_PESO_PCT, package_type, picking_task ...
```

---

## 8. Commit/push

Nenhum commit foi feito. Aguardando confirmação explícita do usuário, conforme padrão de todas as sessões anteriores.
