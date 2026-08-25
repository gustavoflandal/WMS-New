# Sessão 10B — DOC-17 Parte B (fatia 1): Formulário de Campo

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-10B-doc17-formulario-campo.md`
**Escopo**: DOC-17 §7 completo (RF-TEL-020 a RF-TEL-024, RN-TEL-021,
RN-TEL-023) — emissão, cancelamento e reemissão de Formulário de Campo, com
a operação Putaway (T-P1) ligada de ponta a ponta a `wms.putaway_task`.
Transcrição (§8) e Execução por Tela (§6) ficam para sessões seguintes (ver
justificativa no prompt).

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RD-TEL-001/002 — schema `field_form`/`field_form_line`, §9.1 máquina de estados | `infra/postgres/migrations/0075-doc17-formulario-campo.sql` | `field-form.integration.spec.ts` (schema exercitado por todos os 7 testes) |
| RF-TEL-020 — emissão, número `FRM-<ARMAZÉM>-<SEQ8>`, PDF com Code 128 obrigatório | `field-form.service.ts`, `field-form-pdf.service.ts`, `code128.util.ts` | `code128.util.spec.ts` (8 testes, vetor "DCODE" verificado externamente) + integração ("Emissão... reserva as tarefas") |
| RN-TEL-021 — reserva na emissão, exclusão da fila, devolução no cancelamento/expiração | `putaway-task.service.ts` (`loadLockableTasks`/`lockForFieldForm`/`releaseFieldFormLock`), `field-form.service.ts` | integração: "Emissão reserva as tarefas", "Cancelamento devolve...", "Expiração..." |
| RF-TEL-022 — conteúdo por tipo (6 tipos, catálogo fechado) | `field-form-content.util.ts` | `field-form-content.util.spec.ts` (9 testes) |
| RN-TEL-023 [INVIOLÁVEL] — cegueira no papel (Contagem sem saldo, Conferência cega sem produto esperado) | `field-form-content.util.ts::buildContagemLineContent/buildConferenciaLineContent` | `field-form-content.util.spec.ts` (testes dedicados de cegueira) |
| RF-TEL-024 — reemissão RE1/RE2..., cancelamento com motivo | `field-form.service.ts::reissue/cancel` | integração: "Reemissão...", "cancelamento sem motivo é rejeitado" |
| Permissões `TEL.FORMULARIO_EMITIR/REEMITIR/CANCELAR` | `infra/postgres/migrations/0075-...sql` | `route-audit.spec.ts` (toda rota declarada) + `grants-contract.integration.spec.ts` |

## 2. Decisões de implementação (ver prompt para a justificativa completa)

1. Só Putaway (T-P1) está ligado de ponta a ponta a `wms.putaway_task` nesta
   sessão — os outros 5 tipos do catálogo RF-TEL-022 têm a função de
   conteúdo pronta e testada isoladamente, mas sem hook de reserva real
   (`[DEBITO: 10B]`).
2. `field_form`/`field_form_line` são polimórficas (`task_entity`/
   `task_entity_id`), mesmo padrão de `operation_flow`.
3. Numeração reaproveita `DocumentNumberingService` (`FIELD_FORM` → `FRM`) —
   foi necessário alargar o `CHECK` de `wms.document_sequence`
   (`document_sequence_type_check`) para incluir `FIELD_FORM`, mesmo padrão
   já usado pela migration 0069 para `FISCAL_DOCUMENT`.
4. PDF via `pdf-lib` (mesmo padrão de `DanfeService`, DOC-08/8B). Código de
   barras Code 128 implementado do zero (`code128.util.ts`) porque não havia
   biblioteca de barcode no projeto — tabela de larguras e checksum
   verificados contra um vetor de referência externo ("DCODE" → símbolos
   `[104,36,35,47,36,37,62,106]`, checksum recalculado manualmente: 680 mod
   103 = 62) antes de confiar na tabela transcrita de memória.
5. Entrega do PDF só por download (`GET /formularios-campo/:id/pdf`) — RF-TEL-020
   permite "impresso... ou baixado"; o caminho `PeripheralJobService.
   createJob('PRINT_PDF')` exige um dispositivo Edge Agent já registrado e
   uma tela de seleção de impressora fora do escopo desta sessão
   (`[DEBITO: 10B]`).
6. Reemissão usa `<número original>-RE<n>` (não um novo número da sequência
   RN-DAD-040) — mantém a linhagem rastreável no próprio número impresso,
   mesma marca `RE1`/`RE2` já usada pelas etiquetas (RF-PER-021, DOC-11).
7. Expiração é verificação **lazy** (na leitura do formulário), não um
   scheduler novo — mesmo padrão já usado para expiração de agendamento de
   pátio (DOC-03).
8. `EM_FORMULARIO` (RN-TEL-021) é implementado como `putaway_task.
   field_form_id IS NOT NULL` sobre o status já existente da tarefa, não um
   novo valor de enum — preserva a máquina de estados original do módulo.

## 3. Bugs reais encontrados e corrigidos durante a sessão

- **`import { Response } from 'express'` quebra o boot em produção.**
  `tsc`/vitest (esbuild) toleram o import nomeado, mas o Node real (ESM) não
  — `SyntaxError: Named export 'Response' not found`. Só apareceu no
  `docker compose up --build` (não no `pnpm build`/`pnpm test`), confirmando
  por que o DoD exige o container real como gate separado. Mesmo pitfall já
  registrado na memória da Sessão 8 ("express `import type` vs value
  import"). Corrigido para `import type { Response } from 'express'` em
  `field-form.controller.ts`, mesmo padrão de `dashboard.controller.ts`.
- **Colisão de LPN sob suíte de integração completa em paralelo.** O
  primeiro `pnpm test:integration` completo (não o arquivo isolado) falhou
  em `lpn-generation.integration.spec.ts` com
  `duplicate key value violates unique constraint "pallet_lpn_unique"`.
  Causa: meu novo `field-form.integration.spec.ts` criava paletes sem
  configurar um `GS1_PREFIX` próprio para o armazém de teste — como
  `LpnService` cai no `DEFAULT_GS1_PREFIX` ('2900000') igual para qualquer
  armazém sem prefixo configurado, e `document_sequence` reinicia em 1 para
  cada armazém novo, dois armazéns de teste diferentes (o meu e o de
  `lpn-generation.integration.spec.ts`) geravam o **mesmo LPN global**.
  Toda tabela de teste que já cria paletes (`crossdock`/`labeling`/
  `putaway-engine`/`putaway-task.integration.spec.ts`) já configura um
  `GS1_PREFIX` próprio exatamente por essa razão, com comentário citando
  isso como débito de DOC-02 — meu arquivo quebrou essa convenção
  estabelecida. Corrigido configurando `GS1_PREFIX = '7420003'` (não usado
  por nenhum outro arquivo) no `beforeAll`. Verificado com `git stash` que
  a árvore sem minhas mudanças não reproduzia o problema — confirmando que
  a causa era mesmo meu arquivo novo, não uma flakiness pré-existente.

## 4. Saída real dos comandos

```
$ pnpm build
 Tasks:    5 successful, 5 total

$ pnpm test
@wms/backend:test:  Test Files 24 passed (24) | Tests 232 passed (232)
@wms/ui:test:       Test Files 3 passed (3)   | Tests 22 passed (22)
@wms/frontend:test: Test Files 7 passed (7)   | Tests 37 passed (37)
 Tasks:    8 successful, 8 total

$ pnpm test:integration   (execução 1/2)
@wms/backend:test:integration: Test Files 78 passed (78) | Tests 337 passed (337)
 Tasks:    6 successful, 6 total
  Time:    3m26.31s

$ pnpm test:integration   (execução 2/2)
@wms/backend:test:integration: Test Files 78 passed (78) | Tests 337 passed (337)
 Tasks:    6 successful, 6 total
  Time:    3m14.9s

$ docker compose -f infra/docker-compose.yml up -d --build
...
 Container wms-backend-api Started
 Container wms-backend-worker Started
 Container wms-backend-scheduler Started
 Container wms-frontend Started

$ curl localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T18:17:00.355Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ docker exec wms-postgres psql -U postgres -d wms_db -c "SELECT version, description FROM wms.schema_migration WHERE version = 75;"
 version |                            description
---------+--------------------------------------------------------------------
      75 | DOC-17 10B: Formulario de Campo (field_form/field_form_line), ...

$ curl -X POST localhost:3000/formularios-campo/putaway -d '{}' -H "Content-Type: application/json" -o /dev/null -w "%{http_code}"
401   # rota corretamente protegida pelo PermissionGuard (não 404)
```

Backend: 215 → 232 testes unitários (+17: 8 Code128, 9 field-form-content).
Integração: 330 → 337 (+7: field-form.integration.spec.ts).

## 5. Sem tela de frontend nesta sessão

DOC-17 §7 (Formulário de Campo) ainda não tem consumo no frontend — a
emissão/cancelamento/reemissão hoje só existem como API. As telas reais
(emitir formulário a partir da fila de tarefas, tela de transcrição) fazem
parte da Execução por Tela (§6) e Transcrição (§8), sessões seguintes. Por
isso esta sessão não gera `docs/relatorios/screenshots/sessao-10b/` — não
há UI nova para capturar (mesmo padrão já usado nas sessões backend-only
9A/10A: screenshots só quando a sessão toca telas do frontend).

## 6. Lacunas e débitos

**Em aberto (declarados no prompt, não fecham nesta sessão):**
- `[DEBITO: 10B]` reserva real de tarefa (RN-TEL-021) implementada só para
  Putaway; Picking/Conferência/Contagem/Reposição-Transferência/
  Carregamento têm a função de conteúdo pronta e testada, mas sem tabela de
  tarefa real vinculada.
- `[DEBITO: 10B]` entrega do PDF só por download — sem integração com
  `PeripheralJobService.createJob('PRINT_PDF')` (exigiria tela de seleção
  de impressora Edge Agent).
- `[DEBITO: 10B]` expiração é lazy (na leitura) — sem scheduler dedicado
  para expirar formulários nunca mais consultados.
- Transcrição (§8) inteira: RF-TEL-030, RN-TEL-031 (idempotência),
  RN-TEL-032 (segregação de funções), RN-TEL-033 (validade/divergência),
  RF-TEL-034 (dupla digitação) — sessão seguinte.
- Execução por Tela (§6) inteira: RN-TEL-010 (modo de execução por
  armazém), RN-TEL-011 (paridade), RN-TEL-012 (controles compensatórios),
  RF-TEL-013 (as 8 telas T-P1..T-P8), coluna `execution_channel`
  (RD-TEL-004) — sessão seguinte; `execution_channel` só faz sentido
  desenhado junto com quem grava `WEB`/`PAPEL`/`SYNC` (Transcrição e
  Execução por Tela), por isso não foi criado nesta sessão.
- Nenhum teste de contrato de permissões cobre `TEL.EXECUCAO_TELA`,
  `TEL.TRANSCREVER*`, `TEL.MODO_EXECUCAO_CONFIGURAR` — ainda não têm
  chamador (mesmo cuidado da 10A).

**Fechado nesta sessão**: RF-TEL-020 a RF-TEL-024, RN-TEL-021, RN-TEL-023
(Formulário de Campo completo para Putaway); os 3 cenários Gherkin do
DOC-17 §10 aplicáveis a Formulário de Campo ("Emissão... reserva as
tarefas", "Cancelamento devolve as tarefas", "Formulário de inventário não
imprime saldo" — este último via `buildContagemLineContent`, testado
isoladamente já que Contagem não tem hook de reserva real ainda).
