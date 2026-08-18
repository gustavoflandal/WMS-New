# Relatório — Sessão 5B: Seleção de Saldo (DOC-05 §4.2)

**Data**: 2026-08-18
**Escopo**: RN-EST-010 (universo de candidatos), RN-EST-011 (ordenação por política de giro), RN-EST-012 (shelf life mínimo), RN-EST-013 (quebra de política), reserva a partir da seleção e substituição da seleção provisória da 5A.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-5A-relatorio.md`.

---

## 1. Resumo executivo

Os 7 entregáveis foram implementados e testados. `pnpm build` limpo; **unit 12/12 arquivos, 124/124 testes**; **integração 57/57 arquivos, 188/188 testes**, em 2 execuções consecutivas.

**Decisão estrutural**: mesma da 4B e pelo mesmo motivo — a regra que decide QUAL saldo sai é uma função **pura**, sem I/O (`stock-selection.util.ts`), e a camada de dados só carrega insumos. Os dois exemplos normativos do §4.2 (80/70 de S1/S2; 25,2% × 41,9%) passaram em **teste unitário antes de qualquer query ser escrita**, e estão travados como regressão permanente em dois níveis (unitário sobre a função pura + integração ponta a ponta contra Postgres).

**A "data de entrada do saldo" é entrada do comparador, não algo que ele busca** — a derivação (que exige I/O) vive isolada em `StockSelectionService.loadCandidateRows()` e está documentada em §3.

---

## 2. Nota de divergência prompt × código (não é lacuna)

O prompt da 5B instruiu "substituir a `StockSelectionPort` provisória da 5A **sem alterar a interface**". Essa interface **não existia**: o prompt da 5A pedia uma porta com implementação provisória, mas a 5A implementou a heurística *inline* em `KanbanService.checkKanban()`, marcada `[DÉBITO: 5B substitui]` (registrado no relatório 5A §4).

Não é `[LACUNA]` — a especificação (RN-EST-010..013) está completa; foi divergência entre o prompt e o estado real do código. Encaminhamento:

- A porta foi **criada agora** (`selection/stock-selection.port.ts`), com contrato tipado nos dois sentidos, porque três consumidores vão usá-la: reposição/kanban (já consome), picking (DOC-06) e inventário (5C). Uma porta explícita evita que cada consumidor invente sua própria forma de chamar.
- A assinatura pública de `KanbanService.checkKanban()` foi preservada — o worker que a chama não mudou.
- **`[DÉBITO: 5B substitui]` da 5A: FECHADO.**

---

## 3. A derivação da "data de entrada do saldo" (RN-EST-011)

É a base de FIFO e LIFO, então não pode ser ambígua. Definição adotada, implementada em `StockSelectionService.loadCandidateRows()`:

> **data de entrada de um saldo** = `MIN(stock_movement.occurred_at)` entre os movimentos que **creditaram exatamente aquela combinação de saldo** — mesmo `tenant_id`, `warehouse_id`, `product_id`, `batch_id`, `location_id_to` = endereço do saldo e `pallet_id_to` = palete do saldo — filtrados por `balance_bucket_to IS NOT NULL` (houve crédito).

Três decisões que a tornam determinística:

1. **É o `MIN`, não o último**: RN-EST-011 diz literalmente "primeiro `stock_movement` de entrada". Um saldo que recebeu três créditos tem como data de entrada a do primeiro.
2. **Comparação de lote/palete com `IS NOT DISTINCT FROM`**: ambos são NULLable e `NULL = NULL` é `NULL` em SQL — a mesma classe de problema do bug de UPSERT corrigido na migration 0046 da 5A. Sem isso, saldo sem lote nunca casaria com seu próprio movimento de entrada.
3. **Fallback `stock_balance.created_at`** quando não existe movimento de entrada (saldo de carga inicial, ou fixtures anteriores ao motor de movimentação da 5A). É determinístico e monotônico com a entrada real. **Nunca `now()`** — que tornaria a ordenação FIFO/LIFO instável entre duas execuções da mesma seleção.

Índice de suporte criado na migration 0049 (`idx_stock_movement_entry_lookup`, parcial sobre créditos), no pai particionado — o Postgres propaga índice para as partições (diferente de `GRANT`, que não propaga; ver 5A §3.2).

---

## 4. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **RN-EST-010 [INVIOLÁVEL]** universo de candidatos | `selection/stock-selection.service.ts` (`loadCandidateRows`, `applyLogicalWarehouseContainment`) | `stock-selection.integration.spec.ts`: parcelas blocked/quarantine/damaged/reserved/in_transit nunca candidatas; endereço INVENTORY/BLOCKED/INACTIVE fora; lote não-RELEASED fora; RG-015 |
| **RN-EST-011 [INVIOLÁVEL]** ordenação por política | `selection/stock-selection.util.ts` (regra pura: `POLICY_CHAINS`, `orderCandidatesByPolicy`, `allocateDemand`) | `stock-selection.util.spec.ts` (17 unit, cadeia de cada política + exemplo normativo) + `stock-selection.integration.spec.ts` (FEFO normativo, FIFO, LIFO, JIT, RG-006) |
| **§4.2 exemplo normativo FEFO** (80 de S1 + 70 de S2, S3 intocado) | idem | unit (`EXEMPLO NORMATIVO §4.2`) **e** integração (`§6 EXEMPLO NORMATIVO`) — valor esperado imutável |
| **RN-EST-012 [INVIOLÁVEL]** shelf life mínimo | `stock-selection.util.ts` (`meetsMinimumShelfLife`, aritmética inteira exata), `stock-selection.service.ts` (`loadShelfLifeParameters`) | unit (exemplo normativo 25,2% × 41,9% + corte exato no limiar + percentual decimal) + integração (exclusão real + contraprova de finalidade interna) |
| **RN-EST-011 / RN-DAD-010** LIFO_PHYSICAL | `stock-selection.util.ts` (`restrictToAccessiblePallets`), `selection/physical-channel.util.ts` | unit (2 casos) + integração (drive-in real: fundo do canal não é candidato mesmo sendo o mais antigo) |
| **RN-EST-013** quebra de política | `selection/stock-reservation.service.ts` (`assertPolicyBreakAuthorized`, `assertShelfLifeBreakHasClientAttachment`), `stock-reservation.controller.ts`, migration `0049` (`attachment_keys`) | `stock-reservation.integration.spec.ts`: sem exceção → erro; exceção PENDENTE → erro; aprovada sem permissão → Forbidden; permissão + aprovada → efetiva com `policy_break=true`; quebra por shelf life sem anexo → erro, com anexo → efetiva |
| **Entregável 5** — substituição da seleção provisória | `replenishment/kanban.service.ts` (consome a porta), porta em `selection/stock-selection.port.ts` | `stock-reservation.integration.spec.ts`: kanban escolhe o lote de validade mais curta (FEFO), **não** o endereço de maior saldo (que era a heurística da 5A) |
| **Entregável 6** — reserva a partir da seleção | `selection/stock-reservation.service.ts`, migration `0049` (`wms.stock_reservation`) | reserva multi-saldo com detalhamento persistido; demanda maior que o disponível é erro determinístico sem efeito parcial; **concorrência**: 2×60 sobre 100 → 60+40, nunca 60+60 |

**Totais**: unit **12 arquivos / 124 testes** (+17 nesta sessão); integração **57 arquivos / 188 testes** (+17 nesta sessão).

---

## 5. Achados reais desta sessão

### 5.1 `min_shelf_life_default_pct` não existe em `wms.client`

RN-EST-012 fala em "`min_shelf_life_pct` resolvido (produto → **cliente**)". A coluna de padrão do cliente existe em `wms.client_warehouse_settings` (migration 0009), **não** em `wms.client`. A cadeia implementada é `product.min_shelf_life_pct` → `client_warehouse_settings.min_shelf_life_default_pct` — mesma precedência (específico → padrão) que RG-006 usa para a política de giro. Descoberto pelo teste de integração (a query falhava com `column c.min_shelf_life_default_pct does not exist`).

### 5.2 Grants `wms_worker` — de novo, e pelo mesmo motivo

O kanban roda cross-tenant (`transactionAsWorker`) e passou a consumir a seleção, que lê tabelas que o worker nunca havia tocado: `zone`, `storage_equipment`, `client_warehouse_settings`, `logical_warehouse` e a função `SECURITY DEFINER` `logical_warehouse_location_owners` (que só tinha `EXECUTE` para `wms_app`). Todos concedidos na migration 0049, apenas `SELECT`/`EXECUTE`. É a terceira sessão seguida em que adicionar um consumidor no worker exige grants novos — o teste de integração é o que pega, `tsc` nunca pegaria.

### 5.3 A leitura literal de "endereço `ACTIVE` (ou `PICKING`)" é internamente contraditória

RN-EST-010 admitiria, ao pé da letra, um `OR` entre status e tipo. Adotada a leitura como restrição de **status** (`ACTIVE`), com o parêntese esclarecendo que endereços de picking também entram — e **nenhum** filtro por tipo. Três razões, registradas no código:

1. `PICKING` não existe no enum de `location.status` (DOC-02: ACTIVE/BLOCKED/INVENTORY/INACTIVE), só em `location_type`;
2. o `OR` literal admitiria endereço `BLOCKED`/`INVENTORY` desde que fosse do tipo PICKING, contradizendo RN-EST-061 (congelamento em contagem);
3. restringir o tipo a (STORAGE, PICKING) tornaria a política **JIT inalcançável**, pois ela ordena "saldo em zona `CROSS_DOCKING` primeiro" e esses endereços não são de nenhum dos dois tipos.

Conteúdo impróprio já é barrado pela **parcela**: quarentena e avaria vivem em `qty_quarantine`/`qty_damaged`, nunca em `qty_available`. Registrado como `[LACUNA]` em `loadCandidateRows`.

### 5.4 Aritmética do shelf life em inteiros, não em ponto flutuante

`min_shelf_life_pct` é `NUMERIC(5,2)` e chega do pg como string. `Number("30.50") * 100` pode produzir `3049.9999999999995` e mudar uma decisão de corte no limite exato — inaceitável para uma regra `[INVIOLÁVEL]`. A comparação foi reescrita como identidade inteira exata: `restantes × 100 × 100 ≥ (pct em centésimos) × shelf_life_days`, com o percentual convertido por manipulação de string (`parsePercentToCentiPercent`). Travado por teste no limiar fracionário (30% de 365 = 109,5 dias: 109 reprova, 110 aprova).

### 5.5 Migration 0004 não é reaplicável (achado lateral, sem impacto)

Ao rodar o protocolo de verificação em banco descartável, reaplicar **todas** as migrations do zero falhou na `0004-app-parameter.sql` (`policy "app_parameter_visibility" already exists` — a migration dropa 4 políticas com nomes antigos, mas não a que ela mesma cria). Não afeta produção: o `MigrationRunner` controla por `schema_migration.version` e nunca reaplica. Registrado aqui como observação; corrigir exigiria alterar migration já commitada e em produção, fora do escopo desta sessão.

### 5.6 Verificação da migration 0049 (protocolo de banco descartável)

A 0049 não corrige dados, mas **adiciona coluna a uma tabela que já tem linhas** (`operational_exception`), então foi verificada pelo mesmo protocolo: banco descartável → todas as migrations 0001-0049 → inserida uma `operational_exception` pré-existente → **reaplicada a 0049 duas vezes** dentro de transação única (replicando `MigrationRunner.runMigration`). Resultado: sem erro nas duas reaplicações, linha pré-existente preservada com `attachment_keys = '{}'`.

---

## 6. Lacunas e débitos

**Em aberto:**

- **`[LACUNA]` permissão para reserva/consulta regular** — DOC-05 §3 não define código de permissão para "reservar" nem para consultar uma simulação de seleção; o catálogo EST.* cobre transferência, bloqueio, inventário e descarte. Por isso a **única rota HTTP** desta sessão é a de quebra de política (`EST.QUEBRA_POLITICA_GIRO`, que existe no catálogo). A seleção/reserva regular é consumida internamente (kanban agora, picking do DOC-06 depois). Quando o DOC-06 definir a permissão de picking, a rota regular nasce lá.
- **`[LACUNA]` posição de saldo SEM `expiration_date` na ordenação por validade** — DOC-05 não define. Adotado NULLS LAST (o saldo com validade conhecida sai primeiro), que é o conservador e o único coerente com o propósito do FEFO. Travado por teste unitário.
- **`[LACUNA]` "palete acessível" em canal sem palete formal** — RN-EST-011 fala em palete, mas um canal LIFO pode conter saldo com `pallet_id` nulo. Adotado: a unidade de acessibilidade é a data de entrada dentro do canal (com ou sem palete, só o mais recente é alcançável), que é a leitura física direta de LIFO.
- **`[LACUNA]` fronteira do "canal"** — herdada da 4B (equipamento + rua + módulo + nível). Agora com **definição única** compartilhada entre os dois motores (`selection/physical-channel.util.ts`), em vez de duplicada: a 4B só deixa entrar lote homogêneo em canal LIFO_PHYSICAL justamente para que a 5B possa retirar de lá sem violar a política de giro — se as definições divergissem, a garantia de uma não cobriria a premissa da outra.
- **`[DÉBITO: DOC-06]` fracionamento da reposição kanban em múltiplas origens** — a seleção já devolve a lista completa de alocações, mas `wms.replenishment_task` (RD-EST-002) modela UMA origem por tarefa. Gerar N tarefas exigiria definir como o dedupe de RF-EST-041 ("proibido gerar nova tarefa enquanto houver reposição aberta do mesmo produto×endereço") trata o conjunto — regra que o DOC-05 não define. Sessão-alvo: DOC-06, quando o picking exercitar reposições fracionadas de verdade.
- **`[DÉBITO: DOC-06]` consumo da reserva no picking** — `wms.stock_reservation` nasce `ACTIVE` e o detalhamento saldo→demanda está persistido, mas nada ainda a transiciona para `CONSUMED`/`CANCELLED`: quem consome é o picking (DOC-06). Os estados existem no CHECK da tabela desde já para que o DOC-06 não precise alterar schema.
- **`[DÉBITO: 5A, ainda aberto]` RF-EST-040/041 "todo evento de baixa"** — inalterado por esta sessão; o gatilho continua sendo só o job horário. A reserva agora é um ponto de extensão natural para isso quando o DOC-06 existir.

**Fechados nesta sessão:**

- ~~`[DÉBITO: 5B substitui]` seleção de origem do kanban por política de giro~~ — **FECHADO**: `KanbanService` consome a Seleção de Saldo real pela porta, provado por teste que a origem escolhida é o lote de validade mais curta (FEFO) e não o de maior saldo.

**Fora de escopo confirmado**: inventários (§4.7 — Sessão 5C), pedidos/picking/packing (DOC-06), Alocação Fiscal por nota de armazenagem (DOC-08 — a seleção desta sessão é FÍSICA), telas de coletor (DOC-15) e tudo do DOC-05 §8.

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  12 passed (12)
     Tests  124 passed (124)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  57 passed (57)
     Tests  188 passed (188)
Test Files  57 passed (57)
     Tests  188 passed (188)

$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-api | grep RN-SEG-012
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.

$ curl -s -w "\nHTTP %{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-18T15:26:04.044Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version FROM wms.schema_migration WHERE version >= 44 ORDER BY version"
 44
 45
 46
 47
 48
 49
```

**Verificação da migration 0049 em banco descartável** (protocolo fixado após a 5A — ver §5.6):

```
$ # banco descartável + migrations 0001-0049 + linha pré-existente em operational_exception
$ # reaplicação da 0049 (2ª e 3ª vez), cada uma dentro de BEGIN/COMMIT como o MigrationRunner faz
NOTICE:  relation "idx_stock_movement_entry_lookup" already exists, skipping
COMMIT                                    # 2ª aplicação: sem erro
COMMIT                                    # 3ª aplicação: sem erro

$ SELECT exception_type, status, attachment_keys FROM wms.operational_exception;
 exception_type  | status  | attachment_keys
-----------------+---------+-----------------
 EST.QUEBRA_FEFO | PENDING | {}             # linha pré-existente preservada
```

---

## 8. Commit/push

Nenhum commit foi feito. Aguardando confirmação explícita do usuário, conforme padrão de todas as sessões anteriores.
