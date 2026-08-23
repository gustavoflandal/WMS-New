# Sessão COL-2B — Telas de Execução Offline T2–T6 (Frontend)

Prompt executado: `docs/PROMPT-SESSAO-COL2B-telas-execucao-offline.md`.

Sem conflito de stack a reportar (Next.js 14 + Tailwind + `@wms/ui` + `idb`,
dentro de `apps/frontend/`, conforme DOC-00 §2.2).

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RF-ARQ-051 Pacote de Turno em IndexedDB (schema único, versão 2) | `lib/field/field-db.ts` | build + uso real em `shift-package-store.ts` |
| RF-ARQ-051 persistência/merge do pacote (nunca descarta progresso local) | `lib/field/shift-package-store.ts` | `pnpm build` (tipagem) — sem teste de integração dedicado, ver §5 |
| RF-ARQ-052 fila local (IndexedDB, FIFO) | `lib/field/sync-queue-store.ts`, `confirm-task.ts` | idem |
| RF-COL-021 `[obrigatório]` retomada exata do passo | `shift-package-store.ts::updateTaskProgress` + leitura em cada tela (`task.progress`) | `putaway/[taskId]/__tests__/page.spec.tsx` |
| RF-COL-041 sincronização oportunista ao evento `online` | `lib/field/field-status-context.tsx` | verificado por leitura de código — sem teste automatizado do evento `online` em si, ver §5 |
| RN-ARQ-053 as 4 decisões aplicadas localmente à tarefa/fila | `lib/field/sync-engine.ts` | verificado por leitura de código — a lógica do servidor já é testada em `campo-col2a.integration.spec.ts` (COL-2A); este arquivo só consome o resultado |
| RNF-ARQ-054 bloqueio client-side por limite de fila/tempo | `lib/field/queue-gate.ts` | `queue-gate.spec.ts` (6 testes, função pura) |
| RNF-COL-050 bloqueio client-side por versão mínima | `field-status-context.tsx` + `layout.tsx` (captura `versionBlocked` de `registerDevice`) | verificado por leitura de código |
| RNF-COL-020 estado permanente no topo (operador, armazém, conexão, fila) | `app/field/layout.tsx::FieldShell` | build + inspeção visual (sem Chrome real no ambiente, ver §5) |
| T2 Putaway (dupla leitura LPN→endereço, RF-REC-042) | `app/field/putaway/[taskId]/page.tsx` | `page.spec.tsx` (4 testes) |
| T3 Picking (endereço→produto→quantidade, RN-EXP-032) | `app/field/picking/[taskId]/page.tsx` | build (tipagem) |
| T4 Conferência (produto→quantidade, RF-REC-021) | `app/field/conferencia/[taskId]/page.tsx` | build (tipagem) |
| T5 Contagem — RN-COL-061/063/064 `[INVIOLÁVEL]` | `app/field/contagem/[taskId]/page.tsx` | `page.spec.tsx` (7 testes) — o mais crítico da sessão |
| T6 Reposição (dupla leitura origem→destino, RF-EST-042) | `app/field/reposicao/[taskId]/page.tsx` | build (tipagem) |
| T6 Transferência ad-hoc (RF-EST-050) | — | **não implementada**, `[DÉBITO]` explícito no código e em §5 |
| T1 navega para a tela certa por tipo de tarefa | `app/field/page.tsx` | build (tipagem) |
| T8 estende com fila local + decisão em linguagem simples (RN-COL-040) + botão manual | `app/field/sincronizacao/page.tsx` | build (tipagem) |
| RF-COL-013 feedback <100ms (flash + vibração) | `lib/field/use-scan-feedback.ts` | build (tipagem) |
| Contrato do Pacote de Turno estendido (checkingId, endereço de origem, saldo nunca enviado) | `apps/backend/.../shift-package.service.ts` (ajuste desta sessão) | `campo-col2a.integration.spec.ts` (302/302 continuam passando) |

## 2. Comandos executados e saída real (verificação independente desta sessão principal)

```
$ cd apps/frontend && pnpm exec tsc --noEmit
TypeScript: No errors found

$ pnpm build
▲ Next.js 14.2.35
✓ Compiled successfully
✓ Generating static pages (12/12)

Route (app)                              Size     First Load JS
├ ○ /field                               4.67 kB        91.9 kB
├ ƒ /field/conferencia/[taskId]          3.73 kB         108 kB
├ ○ /field/consulta                      4.48 kB        91.7 kB
├ ƒ /field/contagem/[taskId]             6.04 kB         110 kB
├ ƒ /field/picking/[taskId]              5.32 kB         109 kB
├ ƒ /field/putaway/[taskId]              5.19 kB         109 kB
├ ƒ /field/reposicao/[taskId]            4.93 kB         109 kB
├ ○ /field/sincronizacao                 3.79 kB        95.3 kB
(demais rotas inalteradas)

$ pnpm test
 ✓ src/health.spec.ts (1 test)
 ✓ src/lib/field/__tests__/queue-gate.spec.ts (6 tests)
 ✓ src/lib/field/__tests__/scanner.spec.ts (12 tests)
 ✓ src/lib/field/__tests__/use-wedge-scanner.spec.ts (5 tests)
 ✓ src/app/field/putaway/[taskId]/__tests__/page.spec.tsx (4 tests)
 ✓ src/app/field/contagem/[taskId]/__tests__/page.spec.tsx (7 tests)

 Test Files  6 passed (6)
      Tests  35 passed (35)
```

Backend (regressão do ajuste em `shift-package.service.ts`, ver §3):

```
$ cd apps/backend && pnpm exec tsc --noEmit -p tsconfig.json
TypeScript: No errors found

$ pnpm test:integration
 ✓ src/modules/campo/__tests__/campo-col2a.integration.spec.ts (15 tests)
 Test Files  71 passed (71)
      Tests  302 passed (302)
```

### Docker (DoD)

```
$ docker compose -f infra/docker-compose.yml up -d --build frontend
 Container wms-frontend Started

$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/login
200
$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/putaway/x
200
$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/picking/x
200
$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/conferencia/x
200
$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/contagem/x
200
$ curl -s -o /dev/null -w "%{http_code}" localhost:3002/field/reposicao/x
200

$ curl -s localhost:3000/health/ready
{"status":"ok","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
HTTP 200
```

## 3. Ajuste no contrato do Pacote de Turno (COL-2A), descoberto ao construir o consumidor

Ao desenhar as telas T4/T5/T6, ficou claro que `ShiftPackageService` (entregue
pela COL-2A) tinha 3 lacunas que impediam a execução real:

1. **T4 Conferência não tinha `checkingId`** — `CheckingService.countFirstRound`/
   `recount` exigem o id da sessão `wms.checking`, que a query de conferência
   do Pacote de Turno não selecionava. Adicionado `c.id AS checking_id` (já
   joinado) e o campo `checkingId` em `ShiftPackageTask`.
2. **T6 Reposição só tinha o endereço de DESTINO** — a dupla leitura de
   RF-EST-042 exige mostrar ORIGEM primeiro. Adicionado
   `location_id_origin`/`locationCodeOrigin`.
3. **RN-COL-061 `[INVIOLÁVEL]` reforçado em profundidade** — o campo `qty`
   (que mapeia `system_qty` para CONTAGEM_INVENTARIO) agora é **sempre
   `null`** para esse `taskType` na origem (backend), não só "a tela não
   deveria mostrar" — defesa em profundidade: o dado nem sai do servidor.

Os 3 ajustes foram feitos em `apps/backend/src/modules/campo/shift-package/shift-package.service.ts`
(mesmo arquivo da COL-2A, sem migration nova — só query e mapeamento) e
verificados contra a suíte de integração da COL-2A: **302/302 continuam
passando**, incluindo o teste `d) RF-ARQ-051` que já cobria `ShiftPackageService.build()`.

## 4. Decisões tomadas e justificativa

- **Arquitetura de dados centralizada em `field-db.ts`** — uma única conexão
  IndexedDB (`wms_field`, versão 2) para TODOS os stores (`device` herdado da
  COL-1, `tasks`/`sync_queue`/`shift_package_meta`/`sync_meta` novos). Duas
  chamadas concorrentes de `openDB()` com versões diferentes por módulos
  distintos arriscam `VersionError`/bloqueio mútuo — `device-id.ts` (COL-1)
  foi refatorado para delegar a `getFieldDb()` em vez de manter sua própria
  conexão em paralelo.
- **`confirmTask()` como ponto ÚNICO de confirmação** (T2-T6) — grava a
  operação na fila local e marca a tarefa como `QUEUED` ANTES de qualquer
  tentativa de rede (offline-first genuíno: a tela mostra sucesso
  imediatamente, sem esperar round-trip), depois dispara sincronização
  oportunista em background. Nenhuma tela chama a API diretamente.
- **`sync-engine.ts` reconcilia a decisão do servidor de volta à tarefa
  local**: `APLICADA`/`DESCARTADA_DUPLICIDADE` → tarefa `DONE`;
  `REJEITADA_TAREFA_INVALIDA`/`REJEITADA_REGRA` → tarefa volta a `PENDING`
  (reaparece na lista executável — o operador pode reexecutar se foi engano
  próprio, ou a supervisão intervém). Decisão de UX não detalhada no prompt;
  documentada aqui como escolha explícita, não acidente.
- **RNF-ARQ-054 (limite de fila): limiar em `pendingCount >= 500`**, não
  `> 500` — o Gherkin do DOC-01 §6 é explícito ("com 500 já pendentes, a
  501ª tentativa é bloqueada"), testado literalmente em `queue-gate.spec.ts`.
- **RNF-ARQ-054 (8h): só se aplica depois da primeira sincronização
  bem-sucedida** — `lastSyncSuccessAt` nulo (dispositivo novo) não bloqueia
  por tempo, só por tamanho; a regra fala em "desde a sincronização
  bem-sucedida", que pressupõe ter havido uma.
- **T5 Contagem: lista local é estado do componente, nunca lida do
  servidor** — `LocalTask.qty` já vem `null` do backend para este
  `taskType` (ver §3) e a tela nunca referencia esse campo. `[INVIOLÁVEL]`
  RN-COL-061 verificado por teste de componente dedicado (7 cenários,
  incluindo regex negativa contra qualquer menção a saldo/sistema/divergência
  em todo estado renderizado).
- **T5 RN-COL-063: "Declarar endereço vazio" só habilitado com lista vazia,
  "Encerrar endereço" só habilitado com lista não-vazia** — os dois botões
  são mutuamente exclusivos por construção (não por validação condicional
  frágil), e a declaração de vazio exige uma confirmação extra explícita.
- **T6 Transferência ad-hoc (RF-EST-050) não implementada** — o payload
  `TRANSFERENCIA` exige IDs resolvidos de produto/endereço (não códigos
  escaneados), e não existe rota no backend que devolva o `locationId`
  isolado a partir de um código lido (`/campo/consulta` devolve saldo, não
  o id). Abrir uma rota nova no backend ficaria fora do escopo desta sessão
  de FRONTEND — preferido o débito documentado a inventar uma rota sem
  verificação. Reposição dirigida (o caso comum, já vem com tarefa
  pré-aprovisionada) está completa.

## 5. Lacunas e débitos

- **`[DÉBITO]` T6 Transferência ad-hoc (RF-EST-050)** — ver §4. Sessão-alvo:
  futura sessão de DOC-15/estoque que também resolva a rota de busca de
  `locationId`/`productId` por código escaneado no backend.
- **`[LACUNA]` "Zona/estação" do RNF-COL-020** — não existe campo
  correspondente em `MyContext` nem em nenhuma API já implementada; o
  cabeçalho mostra operador (`userId`, sem nome amigável disponível),
  armazém, conexão e fila — não zona/estação, porque inventar um campo que a
  API não fornece violaria a proibição de `[LACUNA]` como atalho.
- **`[LACUNA]` T3 Picking sem catálogo de `reasonCode`** — motivo de
  divergência de quantidade vai só em texto livre (`reasonText`); não há
  catálogo de códigos acessível ao frontend nesta sessão.
- **`[LACUNA]` T4 Conferência sem validação condicional de lote/validade
  (RN-DAD-020)** — nem a tarefa local nem a API atual informam se a espécie
  do produto exige lote/validade; o próprio backend (`checking.service.ts`)
  também não valida isso neste ponto, então a lacuna é simétrica
  cliente/servidor, não uma reprovação client-side ausente.
- **`[LACUNA]` T5 sem conversão de embalagem exibida ("2 CX12 = 24 UN",
  RN-DAD-021)** — fator de conversão do produto não está disponível em
  `LocalTask` nem em nenhuma API implementada para esta tarefa; a tela pede
  quantidade direta em UN.
- **`[LACUNA]` T5 RN-COL-064 é só aviso preventivo** — o cliente não tem
  como saber com certeza quem fez a 1ª rodada de um endereço (isso é
  decisão do servidor); o aviso informa a possibilidade, não impede a
  tentativa (o servidor decide de fato via `RECOUNT_REQUIRES_DIFFERENT_CONFERENTE`,
  já implementado em `checking.service.ts`).
- **`[DÉBITO]` Sem screenshots reais das 5 telas** — não há Playwright/
  Puppeteer instalado no monorepo, e o ambiente de execução não tem um
  navegador headless com harness de automação (login real + IndexedDB
  populado exigiriam construir esse harness do zero, ou seedar usuário +
  tarefas reais no banco só para captura visual). Verificado por outra via:
  as 5 rotas respondem HTTP 200 no container reconstruído
  (`docker compose up -d --build frontend`), o código das 5 telas foi lido e
  revisado integralmente nesta sessão principal (não só aceito por relato do
  agente), e a tela mais crítica (T5) tem 7 testes de componente cobrindo
  cada estado renderizado. Prefere-se este débito explícito a fabricar
  imagens.
- **`[LACUNA]` Sem teste automatizado do evento `online` do navegador
  (RF-COL-041)** e sem teste de integração dedicado para
  `shift-package-store.ts`/`sync-queue-store.ts`/`sync-engine.ts` em si
  (só verificados por leitura de código + build limpo + o teste de
  componente de T2/T5, que exercitam `confirmTask`/`updateTaskProgress`
  através de mocks). A lógica de decisão do servidor que esses módulos
  consomem já está coberta pelos 302 testes de integração da COL-2A.

## 6. Arquivos desta sessão

**Backend — alterado**: `apps/backend/src/modules/campo/shift-package/shift-package.service.ts`
(ver §3 — sem migration nova).

**Frontend — infra de dados (novo)**:
`lib/field/field-db.ts`, `lib/field/shift-package-store.ts`,
`lib/field/sync-queue-store.ts`, `lib/field/sync-meta-store.ts`,
`lib/field/queue-gate.ts` (+ `__tests__/queue-gate.spec.ts`),
`lib/field/sync-engine.ts`, `lib/field/field-status-context.tsx`,
`lib/field/confirm-task.ts`, `lib/field/use-scan-feedback.ts`.

**Frontend — infra de dados (alterado)**: `lib/field/device-id.ts` (delega a
`field-db.ts`), `lib/field/field-api.ts` (`shiftPackage`/`sincronizar` +
tipos DTO novos).

**Frontend — telas (novo)**:
`app/field/putaway/[taskId]/page.tsx` (+ `__tests__/page.spec.tsx`),
`app/field/picking/[taskId]/page.tsx`,
`app/field/conferencia/[taskId]/page.tsx`,
`app/field/contagem/[taskId]/page.tsx` (+ `__tests__/page.spec.tsx`, 7 testes),
`app/field/reposicao/[taskId]/page.tsx`,
`app/field/_components/task-not-found.tsx`,
`app/field/_components/execution-blocked-banner.tsx`.

**Frontend — telas (alterado)**: `app/field/layout.tsx` (`FieldStatusProvider`,
estado permanente, Pacote de Turno), `app/field/page.tsx` (T1, navegação por
tipo), `app/field/sincronizacao/page.tsx` (T8, fila local + botão manual).

**Prompt**: `docs/PROMPT-SESSAO-COL2B-telas-execucao-offline.md`.

## 7. Próximo passo

Com COL-2A + COL-2B, o DOC-15 fica fechado (catálogo de 8 telas, offline-first,
PIN, resolução de conflitos), exceto os débitos explícitos acima (T6
Transferência ad-hoc, Modo Quiosque/MDM e voice picking — estes dois últimos
fora de escopo permanente desde o prompt original). Próximo módulo pendente
conforme `docs/relatorios/MARCO-estado-do-sistema.md`/`ROTEIRO-DESENVOLVIMENTO.md`.
