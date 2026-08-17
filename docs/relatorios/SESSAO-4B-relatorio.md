# Relatório — Sessão 4B: Motor de Putaway (DOC-04 §4.5)

**Data**: 2026-08-17 (revisado no mesmo dia com **2 emendas aprovadas** — ver §1)
**Escopo**: Motor de Putaway (RN-REC-040 Fases 1 e 2, RN-REC-041 override), execução das tarefas de armazenagem (RF-REC-042) e conclusão do recebimento (RF-REC-043). Fecha o DOC-04.
**Contexto autorizado**: DOC-00, DOC-04, `SESSAO-4A-relatorio.md`, e apenas §4.3/§5.2 do DOC-05.

---

## 1. Resumo executivo

Todos os 6 entregáveis foram implementados e testados. `pnpm build` limpo; **unit 10/10 arquivos, 89/89 testes**; **integração 50/50 arquivos, 141/141 testes**, ambos em **2 execuções consecutivas**. `docker compose up -d --build` sobe os 3 papéis `healthy`, `curl localhost:3000/health/ready` responde `200`, e o `RouteAuditService` liberou o boot (RN-SEG-012: todas as rotas declaram permissão).

**Emendas aprovadas (2026-08-17), ambas aplicadas**:
1. **Veredito ternário confirmado como interpretação oficial** — `L` definitivo, `O` superável com `EST.PUTAWAY_OVERRIDE` + motivo + auditoria. Registrado como comentário normativo no cabeçalho do filtro 3 (`putaway-filters.util.ts`), citando RN-REC-040 + RG-005 + RN-EST-021. Ver §3.
2. **"FIFO_PHYSICAL preferencial" implementado como desempate técnico**, não como 7º critério — o catálogo da Fase 2 permanece fechado em 6. Débito **fechado**. Ver §3.1.

Os dois cenários Gherkin de putaway do §6 passam, incluindo o **exemplo normativo E2/E1/E3** — implementado como teste de regressão permanente em DOIS níveis: unitário sobre o comparador puro e integração ponta a ponta pelo motor real. O valor esperado não foi ajustado em nenhum momento.

**Decisão estrutural da sessão**: a regra [INVIOLÁVEL] foi extraída para dois utils PUROS (`putaway-filters.util.ts`, `putaway-ranking.util.ts`), sem I/O. O service só carrega dados e orquestra. Isso torna os 6 filtros e o ranqueamento auditáveis e testáveis linha a linha (38 testes unitários) sem depender de fixture de banco para provar que um endereço ilegal é rejeitado.

---

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivos principais | Teste(s) |
|---|---|---|
| **RN-REC-040 Fase 1** (6 filtros invioláveis, ordem fixa) | `modules/recebimento/putaway/putaway-filters.util.ts` (regra pura), `putaway-engine.service.ts` (carga de dados) | `putaway/__tests__/putaway-filters.util.spec.ts` (29 unit, 1 por filtro isolado + ordem fixa) + `__tests__/putaway-engine.integration.spec.ts` (10 integração) |
| **RN-REC-040 Fase 2** (ranqueamento em cascata, catálogo fechado de 6) | `putaway/putaway-ranking.util.ts` | `putaway/__tests__/putaway-ranking.util.spec.ts` (16 unit, inclui exemplo normativo + desempate técnico) + integração `§6 EXEMPLO NORMATIVO` |
| **RN-DAD-010 preferencial** (desempate técnico FIFO_PHYSICAL > RANDOM > LIFO_PHYSICAL) | `putaway/putaway-ranking.util.ts` (`ROTATION_FRIENDLINESS`, `appliesPhysicalRotationTieBreak`) | 7 unit + 2 integração (flowrack vs porta-paletes com código invertido; contraprova com produto LIFO) |
| **RN-REC-041** (override do operador) | `putaway/putaway-task.service.ts` (`executeTask`), `putaway-engine.service.ts` (`evaluateSingleLocation`) | `__tests__/putaway-task.integration.spec.ts`: override com permissão+motivo aceito e auditado `OVERRIDE`; override sem motivo rejeitado; **override sobre reprovação de Fase 1 rejeitado** |
| **RF-REC-042** (geração, fila, atribuição, dupla leitura, saldo, movimento, offline) | `putaway/putaway-task.service.ts`, `putaway.controller.ts`, migration `0043` (`putaway_operation`) | `putaway-task.integration.spec.ts`: caminho completo, dupla leitura divergente, LPN divergente, idempotência por `operation_id` |
| **RF-REC-043** (conclusão da ordem) | `putaway-task.service.ts` (`completeOrderIfAllStored`) | `putaway-task.integration.spec.ts`: ordem `COMPLETED`, 7 etapas do fluxo `DONE`, doca `FREE`, evento `recebimento.concluido` |
| **RF-REC-051** (cancelamento de cross-dock → putaway padrão) — fecha `[DÉBITO: 4B]` da 4A | `crossdock/crossdock.service.ts` (`cancelLink`) | `putaway-task.integration.spec.ts`: tarefa gerada, palete sai da zona CROSS_DOCKING, motor designa endereço de armazenagem |
| **RF-REC-020** (etapa dinâmica "Divergências") — gap da 4A, ver §5 | `checking/checking.service.ts` | `putaway-task.integration.spec.ts`: etapa intercalada entre CONFERENCIA e ETIQUETAGEM |
| **RG-015** (contenção de Armazém Lógico, cross-tenant) | `putaway-filters.util.ts` filtro 2, migration `0043` (`logical_warehouse_location_owners`) | unit (3 casos) + integração `RG-015: endereço do cliente B...` |
| **RN-EST-020/021/022** (classes e matriz de segregação) | migration `0043` §7 (classes reais), `putaway-filters.util.ts` filtro 3 | unit (7 casos, incluindo L vs O e precedência) + integração INFLAMAVEL/§6 |

**Totais**: unit **10 arquivos / 89 testes**; integração **50 arquivos / 141 testes**.

---

## 3. Como cada um dos 6 filtros foi implementado e testado

Todos em `putaway-filters.util.ts`, na **ordem fixa** do documento; a avaliação para no PRIMEIRO filtro que reprova, e o motivo devolvido cita filtro + código do endereço (exigência de diagnóstico).

| # | Filtro (RN-REC-040) | Implementação | Prova |
|---|---|---|---|
| 1 | `location.status = ACTIVE` | Rejeita status ≠ ACTIVE. **Estende** para `zone.status` — endereço ativo em zona BLOCKED/INACTIVE é inutilizável (`[LACUNA]` documentada: o filtro cita só `location.status`). | unit: 3 status + zona bloqueada; integração: override em endereço INACTIVE rejeitado |
| 2 | Contenção do Armazém Lógico (RG-015) | Duas regras: endereço de armazém lógico de **outro** tenant é sempre `REJECTED_LEGAL` (item 2, "não admite override por nenhum papel"); tenant COM armazém lógico ativo só recebe endereços vinculados a ele (item 1). Exige leitura **cross-tenant** — a RLS de `logical_warehouse_location` esconde de A justamente o vínculo de B, então sem a função `SECURITY DEFINER` da migration 0043 o filtro seria um **no-op silencioso**. | unit: 3 casos; integração: cliente B, com asserção de que o override também não vence |
| 3 | Compatibilidade de espécie (RG-005 + RN-EST-020/021/022) | 4 camadas: `zone.allowed_species`; regras adicionais invioláveis por tipo de zona (INFLAMAVEIS→CLASSIFIED_FLAMMABLE, QUIMICA→CONTROLLED, refrigerados→COLD/FROZEN com faixa, FARMA→zona que declara MEDICAMENTO); RN-EST-022 (coabitação de **endereço**, sempre legal); matriz RN-EST-021 (coabitação de **zona**, transcrita célula a célula), com **precedência de L sobre O**. | unit: 7 casos incluindo célula L, célula O e precedência; integração: cenário §6 INFLAMAVEL + aprovação em zona classificada |
| 4 | Quarentena (RN-REC-031) | Lote `QUARANTINE` → somente `zone_type = QUARANTINE`. | unit: 2 casos; integração: toda sugestão em zona QUARANTINE |
| 5 | Capacidades sobre ocupação **atual** | Peso, volume e paletes **acumulam** sobre a ocupação real; altura **não acumula** (é dimensão, não soma). Ocupação lida **cross-tenant** (`location_physical_occupancy`): num 3PL o endereço físico é compartilhado, e contar só o próprio tenant subestimaria a ocupação. | unit: 5 casos; integração: dois endereços de capacidade nominal idêntica, um cheio e um vago |
| 6 | Coerência física × giro (RN-DAD-010) | `access_policy` (coluna gerada de `storage_equipment`): `LIFO_PHYSICAL` só aceita produto FEFO/FIFO se o **canal** for de lote homogêneo. Canal definido como equipamento + aisle + module + level (`[LACUNA]`: o documento não define a fronteira física de "canal"). A metade **preferencial** da regra é tratada na Fase 2 — ver §3.1. | unit: 5 casos; integração: drive-in real, lote diferente reprovado / mesmo lote aprovado |

**Veredito ternário — INTERPRETAÇÃO NORMATIVA APROVADA** (emenda de 2026-08-17). `RN-REC-040` diz que reprovado "não pode ser aceito por override", mas `RG-005` e `RN-EST-021` (ambas [INVIOLÁVEL]) dizem que incompatibilidade **operacional** (`O`) admite override com permissão + motivo. Resolução oficial: `L` e todos os demais filtros → `REJECTED_LEGAL`, reprovação **definitiva** que nada supera (nem override, nem API, nem importação); `O` → `REJECTED_OPERATIONAL`, **nunca sugerido nem alternativo**, alcançável só por escolha explícita com `EST.PUTAWAY_OVERRIDE` + motivo + auditoria `action = OVERRIDE`. O enunciado completo, com as três fontes, está registrado como comentário normativo no cabeçalho do **filtro 3** em `putaway-filters.util.ts` — onde a distinção nasce.

### 3.1 RN-DAD-010, metade preferencial — desempate técnico da Fase 2

`"FIFO_PHYSICAL preferencial para FEFO/FIFO"` foi implementado (emenda de 2026-08-17) **sem** abrir um 7º critério: o catálogo da Fase 2 permanece **FECHADO em 6**. É um **desempate técnico**, aplicado na seguinte ordem de decisão:

1. critérios configurados em `REC.CRITERIOS_PUTAWAY`, em cascata;
2. **desempate técnico de rotação física** — `FIFO_PHYSICAL > RANDOM > LIFO_PHYSICAL` (`access_policy`, DOC-02 §5.2), aplicado **apenas** a produtos de política `FEFO` ou `FIFO`;
3. desempate final: menor `location.code` (RN-REC-040, literal).

Por estar em (2), **nunca sobrepõe** a decisão de um critério configurado — só decide o que a configuração do armazém deixou empatado. Produtos `LIFO`/`JIT` não aplicam o desempate. Palete misto aplica se **ao menos um** produto for FEFO/FIFO (mesmo critério do filtro 6).

`[LACUNA]`: a emenda nomeia três políticas; `AUTOMATED` (CARROSSEL) e endereço **sem** equipamento (piso/blocado, `storage_equipment_id` NULL) recebem o rank **neutro** de `RANDOM` — nenhum impõe restrição física de rotação, e posicioná-los antes ou depois das nomeadas seria invenção.

**Testes**: 7 unitários (`putaway-ranking.util.spec.ts`) incluindo a regressão de que o **exemplo normativo §4.5 permanece E2/E1/E3** com o desempate ligado; 2 de integração (`putaway-engine.integration.spec.ts`) com equipamentos reais — flowrack vs porta-paletes com o porta-paletes tendo o **menor código** (para que só o desempate técnico possa explicar a vitória do flowrack), e o contraprova com produto LIFO onde vence o menor código.

---

## 4. Migration desta sessão (0043)

| Item | Conteúdo |
|---|---|
| Permissão | `REC.EXECUTAR_PUTAWAY` (CLIENT_WAREHOUSE) + grants a `OPERADOR_EMPILHADEIRA`/`LIDER_TURNO`/`GESTOR_ARMAZEM`. `[LACUNA]`: §3 nomeia o ator e a interação mas o catálogo de 6 REC.* não tem código para executar tarefa — mesmo precedente de `POR.FILA_CONSULTAR` (Sessão 4) |
| `putaway_task` | `priority`, `location_id_executed`, `override_reason`, `assigned_at`, `started_at`, `completed_at`, `crossdock_link_id` + índices de fila |
| `putaway_operation` | Idempotência RNF-ARQ-050. Tabela **própria** porque `putaway_task` é particionada e um UNIQUE nela teria que incluir a chave de partição, o que não daria unicidade global de `operation_id` |
| `REC.CRITERIOS_PUTAWAY` | Ordem do exemplo normativo como default (`[LACUNA]`: o documento não define ordem padrão, só o catálogo e um exemplo) |
| `logical_warehouse_location_owners()` | `SECURITY DEFINER` — RG-015 item 2 cross-tenant. Expõe só (endereço → tenant dono) |
| `location_physical_occupancy()` | `SECURITY DEFINER` — RN-EST-022 + filtro 5 cross-tenant. Expõe só agregados físicos + classes + lotes; nenhum dado comercial de outro cliente |
| `product_species.segregation_class` | **Valores reais de RN-EST-020** (FARMA/ALIMENTAR/INFLAMAVEIS/QUIMICA/NEUTRA) + CHECK. Fecha débito explícito da migration 0011 |

---

## 5. Achados reais desta sessão

1. **`product_species.segregation_class` estava provisório** — a migration 0011 (Sessão 2B) semeou a classe com o **próprio código da espécie** e registrou por escrito que aguardava o DOC-05. Sem a atualização, o filtro 3 compararia contra classes inexistentes na matriz RN-EST-021 e **nunca reprovaria nada** — um filtro [INVIOLÁVEL] silenciosamente inerte. Corrigido na migration 0043 §7.

2. **`insertDynamicStep` era código morto** — RF-REC-020 exige a etapa "Divergências" intercalada entre Conferência e Etiquetagem "quando existirem", e o método existia desde a 4A mas **nunca era chamado**. Isso bloqueava esta sessão: com RG-002 [INVIOLÁVEL] proibindo pular etapas, concluir ETIQUETAGEM sem a etapa dinâmica seria pular uma etapa devida. Corrigido em `CheckingService`: a etapa nasce no registro da primeira divergência e é concluída em `closeChecking()`, logo após CONFERENCIA — **não** quando a última divergência é resolvida, porque nesse instante a primeira etapa pendente ainda é CONFERENCIA e completá-la fora de ordem dispararia `FLOW_STEP_ORDER_VIOLATION`.

3. **Duas leituras cross-tenant eram obrigatórias, não opcionais** — `logical_warehouse_location` e `stock_balance` têm RLS por tenant, mas RG-015 item 2 e RN-EST-022 falam do **endereço físico** ("todas as espécies presentes"), que num armazém 3PL compartilhado (AD-001) pode ter conteúdo de outro cliente. Implementadas via `SECURITY DEFINER` com exposição mínima. Sem elas, o motor deixaria FARMA do cliente A entrar em endereço que já tem INFLAMAVEIS do cliente B — exatamente a "mercadoria em local ilegal" que a missão alerta.

4. **`ON CONFLICT DO NOTHING` em `app_parameter` nunca dispara** — a tabela (migration 0004) não tem UNIQUE em (scope, name), então o padrão usado na migration 0033 duplicaria a linha a cada reexecução. Verificado rodando a migration 3x. A migration 0043 usa `WHERE NOT EXISTS`. **A 0033 não foi alterada** (commitada e roda uma vez só em produção) — registrado aqui como observação.

5. **Bug meu, corrigido antes do commit**: o helper `setCriteria` do teste usava `queryGlobal()` para apagar `app_parameter`, que tem RLS — apagava 0 linhas em silêncio e deixava o parâmetro antigo acumulado. Mesma classe de erro que apareceu duas vezes na Sessão 4A; vale como padrão a vigiar.

6. **Um teste "falhando" que era o motor acertando**: o teste de LIFO_PHYSICAL recebeu `REJECTED_OPERATIONAL` em vez de `REJECTED_LEGAL` porque a zona compartilhada do fixture já acumulara saldo NEUTRA de testes anteriores, e a matriz RN-EST-021 (NEUTRA na zona × ALIMENTAR entrando = `O`) reprova no filtro 3 **antes** de o filtro 6 ser alcançado. O motor estava correto; o fixture é que precisava de zona dedicada para isolar o filtro sob teste.

---

## 6. Lacunas e débitos

- ~~**`[DÉBITO]` "FIFO_PHYSICAL preferencial para FEFO/FIFO" (RN-DAD-010)**~~ — **FECHADO** pela emenda de 2026-08-17: implementado como **desempate técnico** da Fase 2 (após os critérios configurados, antes do `location.code`), sem abrir um 7º critério — o catálogo segue fechado em 6. Ver §3.1.
- **`[DÉBITO]` transbordo RG-015 item 3** — endereço fora do armazém lógico é simplesmente reprovado; o fluxo de aprovação com `EST.LOGICAL_WAREHOUSE_OVERFLOW` é do DOC-05, fora de escopo.
- **`[LACUNA]` altura do palete montado** — nem DOC-04 nem DOC-02 definem como calcular a altura física de um palete formado (dependeria de ballast × layers, que RF-REC-030 trata como sugestão). Usada a maior altura unitária entre os produtos como proxy conservador.
- **`[LACUNA]` `allowed_species` vazio** — interpretado como "zona sem restrição própria"; o inverso tornaria toda zona sem configuração inutilizável.
- **`[LACUNA]` faixa de temperatura por produto** — DOC-02 não a tem, então "faixa compatível" só pôde ser verificado como "a zona declara uma faixa".
- **`[LACUNA]` REFRIGERADO/CONGELADO × COLD/FROZEN** — o documento lista o par como conjunto, sem exigir pareamento 1:1; implementada a leitura literal.
- **`[LACUNA]` `batch.status` → parcela do saldo** — DOC-04 não tabela o mapeamento e §4.4 do DOC-05 está fora do contexto autorizado. Adotado: QUARANTINE→`qty_quarantine`, BLOCKED/RECALLED→`qty_blocked`, RELEASED→`qty_available`.
- **`[LACUNA]` CLASSE_ABC × giro** — o documento cita "abc_class do endereço × giro" sem definir o mapeamento; implementada a ordenação A→B→C, que é a única que o próprio exemplo normativo comprova.
- **`[LACUNA]` fronteira do "canal"** — definido como equipamento + aisle + module + level (a lane clássica de drive-in).
- **Cobertura**: `DockService` (RN-REC-001, RF-REC-002/003) segue sem teste de integração dedicado — pendência herdada da 4A, fora do escopo desta sessão.
- **Fora de escopo confirmado**: seleção de saldo para saída (5B), inventário (5C), telas de coletor (DOC-15), expedição (DOC-06), task interleaving/re-slotting.

---

## 7. Definition of Done — saída real

```
$ pnpm --filter @wms/backend build
> nest build
(sem erros)

$ pnpm test                        # apps/backend
Test Files  10 passed (10)
     Tests  89 passed (89)

$ pnpm test:integration            # apps/backend, 2 execuções consecutivas
Test Files  50 passed (50)
     Tests  141 passed (141)
Test Files  50 passed (50)
     Tests  141 passed (141)

$ docker compose -f infra/docker-compose.yml up -d --build backend-api backend-worker backend-scheduler
wms-backend-api        Up (healthy)
wms-backend-worker     Up (healthy)
wms-backend-scheduler  Up (healthy)

$ docker logs wms-backend-api | grep RN-SEG-012
[RouteAuditService] RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-17T23:38:28.075Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version FROM wms.schema_migration WHERE version >= 42"
 42
 43
```
