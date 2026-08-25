# Sessão 10A — DOC-17 Parte A: Detalhe de Etapa (drill-down)

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-10A-doc17-detalhe-etapa.md`
**Escopo**: RF-TEL-001 a RF-TEL-004 — contrato único de detalhe de etapa do
Fluxo Operacional, com os 4 modos de RN-TEL-002 (Consulta/Execução/
Previsão/Bloqueada) e o catálogo de conteúdo por etapa (RF-TEL-003).

Deixado para a **Sessão 10B** (Parte B, ver prompt §"Fora do escopo"):
Formulário de Campo (emissão/impressão/PDF), Transcrição (dupla digitação,
idempotência por linha, segregação de funções), as 8 telas de execução
(T-P1..T-P8), `execution_channel`, `TEL.MODO_EXECUCAO`, e o consumo do novo
endpoint pelo frontend (`FlowTrail.tsx` continua tratando etapa futura como
inerte — ver §5 abaixo).

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RF-TEL-001 (contrato único) | `telas/step-detail/step-detail.service.ts::getStepDetail` + `telas/step-detail/step-detail.controller.ts` | `telas/__tests__/step-detail.integration.spec.ts` (todos os 3 testes) |
| RN-TEL-002 (4 modos) | `step-detail.service.ts::resolveMode` (deriva 100% de `OperationFlowService.getFlowState`) | "Etapa futura abre em modo previsão" (PREVISAO) e "Etapa concluída..." (CONSULTA); BLOQUEADA não tem teste de integração dedicado — `[DEBITO: 10A]` |
| RF-TEL-003 (conteúdo por etapa, 16 combinações reais) | `telas/step-detail/step-content.resolvers.ts` | PEDIDO/PICKING/EMBALAGEM/PESAGEM exercitados pelos testes; as demais 12 combinações (CHEGADA/DOCA/DESCARGA×2 entidades, CONFERENCIA, DIVERGENCIAS, ETIQUETAGEM, PUTAWAY, EXPEDICAO, CARREGAMENTO, SAIDA, TRIAGEM, DESTINACAO) implementadas mas sem teste de integração dedicado nesta sessão — `[DEBITO: 10A]`, código revisado manualmente contra o schema real de cada tabela |
| RF-TEL-004 (navegação, document_number) | `step-detail.service.ts::loadDocumentNumber` | implícito em todos os testes (campo presente no retorno) |
| Ações consultivas (§2) | `step-detail.service.ts::resolveActions` | "Etapa concluída..." (ESTORNAR só para `outbound_order`) e "Etapa futura..." (`actions: []`) |
| RF-PAI-020 (portal não vê executante) | `step-detail.service.ts` parâmetro `hideExecutors` | "RF-PAI-020: hideExecutors oculta..." |
| Achado: `return_order` fora da UNION do painel | `paineis/operacoes/operations-board.service.ts` | `operations-board.integration.spec.ts` (suíte existente, não quebrou) |
| Achado: GRANT faltante em `wms_worker` | `infra/postgres/migrations/0074-return-order-worker-grant.sql` | `grants-contract.integration.spec.ts` |

---

## 2. Saída real dos comandos

### Testes unitários (215/215 — sem novas unidades puras nesta sessão)
```
$ npx vitest run --config vitest.config.ts
PASS (215) FAIL (0)
```

### Testes de integração — 2 execuções consecutivas (330/330, era 327)
```
$ pnpm test:integration
 Test Files  77 passed (77)
      Tests  330 passed (330)

$ pnpm test:integration   # segunda execução
 Test Files  77 passed (77)
      Tests  330 passed (330)
```

Primeira tentativa (antes da correção de grant) falhou com 6 testes —
`permission denied for table return_order` em
`operations-board.integration.spec.ts`, porque a query cross-tenant do
painel roda como `wms_worker` e essa role nunca tinha recebido `SELECT` em
`wms.return_order` (correto até então — nenhum job cross-tenant a lia).
Corrigido com a migration `0074`.

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
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)

$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T13:42:10.298Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP_STATUS:200
```

Log do boot confirma `Mapped {/fluxo-operacional/:entity/:entityId/steps/:stepCode/detail, GET}`
e `RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão.
Boot liberado.`

---

## 3. Decisões de implementação (resumo — detalhe completo no prompt)

1. `StepDetailController`/`TelasModule` (camada de negócio) em vez de
   estender `core/operation-flow` — um módulo `core` não pode depender de
   `recebimento`/`expedicao`/`reversa` (inverteria a direção de dependência
   já estabelecida em todo o projeto).
2. Leitura por SQL direto contra as tabelas de cada módulo (mesmo padrão de
   `putaway-engine.service.ts` lendo `location`/`zone` fora do seu domínio)
   — sem injetar os services de escrita de outros módulos.
3. Modo da etapa deriva 100% de `OperationFlowService.getFlowState()` — zero
   lógica de ordem/bloqueio duplicada.
4. "Ações disponíveis" é CONSULTIVO, não autoritativo — mesmo espírito da
   resolução da RG-002 no próprio DOC-17 §2. `ESTORNAR` só é oferecido para
   `outbound_order` (única entidade com `OutboundReversalService`
   confirmado) — oferecer a mesma dica para `inbound_order`/`return_order`
   seria uma promessa de UI sem serviço real por trás.
5. `return_order` entrou na UNION de `operations-board.service.ts`
   (comentário estava desatualizado desde a 9A) — achado corrigido junto
   com o GRANT que faltava para `wms_worker`.
6. "Contagem (inventário)" do catálogo RF-TEL-003 **não** está no dispatch:
   `inventory_count` ainda não abre `wms.operation_flow` (achado
   pré-existente, já documentado em `operations-board.service.ts`, não uma
   lacuna desta sessão) — expor um resolver para uma entidade sem flow
   seria código morto.

---

## 4. Achados de código (não documentados no prompt original)

- `operations-board.service.ts` tinha comentário desatualizado dizendo
  "reversa não abre operation_flow ainda" — falso desde a 9A. Corrigido o
  comentário e a UNION.
- `wms_worker` nunca recebeu `GRANT SELECT` em `wms.return_order` — correto
  até esta sessão (nenhum job cross-tenant a lia); a UNION do painel é o
  primeiro consumidor cross-tenant real. Migration `0074`.
- Permissões reais confirmadas por grep antes de usar (não inventadas):
  `REC.CONFERIR` (não existe `REC.CONFERENCIA_EXECUTAR`), `REC.EXECUTAR_
  PUTAWAY` (não `REC.PUTAWAY_EXECUTAR`) — labeling reaproveita `REC.CONFERIR`,
  não tem permissão própria.

---

## 5. Lacunas e débitos

**Em aberto:**
- `[DEBITO: 10A]` modo **Bloqueada por exceção** (RN-TEL-002) sem teste de
  integração dedicado — implementado (deriva de `step.is_blocked`), mas os
  testes desta sessão só exercitam Consulta e Previsão.
- `[DEBITO: 10A]` 12 das 16 combinações de conteúdo por etapa
  (`step-content.resolvers.ts`) não têm teste de integração dedicado — só
  revisão manual contra o schema real. Risco baixo (SELECTs simples, sem
  lógica de negócio), mas não é o mesmo padrão de rigor do resto do projeto.
- `[LACUNA: DOC-05]` "Contagem (inventário)" do catálogo RF-TEL-003 não pode
  ser exposta por este contrato até o inventário abrir `operation_flow`
  (pré-requisito de DOC-05, fora do escopo do DOC-17).
- `[DEBITO: 10A]` frontend não consome o novo endpoint ainda —
  `packages/ui/src/components/FlowTrail.tsx` continua tratando clique em
  etapa futura como inerte (sem navegação), e não existe nenhuma tela de
  detalhe por etapa. Mesmo padrão de DOC-06/DOC-07 (backend primeiro,
  frontend em sessão dedicada).
- Parte B do DOC-17 inteira (Formulário de Campo, Transcrição, 8 telas de
  execução, `execution_channel`) — ver prompt desta sessão.

**Fechados nesta sessão**: RF-TEL-001 a RF-TEL-004 (Parte A completa); os 2
cenários Gherkin do DOC-17 §10 aplicáveis à Parte A.

---

## 6. Arquivos desta sessão

Migrations: `infra/postgres/migrations/0073-telas-detalhe-etapa.sql`,
`infra/postgres/migrations/0074-return-order-worker-grant.sql`.

Novos: `apps/backend/src/modules/telas/**` (`telas.module.ts`,
`step-detail/step-detail.service.ts`, `step-detail/step-detail.controller.ts`,
`step-detail/step-content.resolvers.ts`,
`__tests__/step-detail.integration.spec.ts`).

Modificados: `app.module.ts` (+`TelasModule`),
`paineis/operacoes/operations-board.service.ts` (+`return_order` na UNION,
comentário corrigido), `grants-contract.integration.spec.ts`
(+`wms_worker: S` em `return_order`).
