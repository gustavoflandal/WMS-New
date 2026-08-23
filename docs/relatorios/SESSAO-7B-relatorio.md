# Relatório — Sessão 7B: DOC-10 Frontend (Painel, Trilha, Alertas, Chat, Dashboard)

**Data**: 2026-08-22/23
**Escopo**: componente da trilha de etapas (RF-PAI-005, O CORAÇÃO), Painel de Operações (RF-PAI-001..004), centro de alertas e chat (RF-PAI-010/030), dashboard (RF-PAI-040/043), qualidade de interface (RG-013), testes de componente.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-10-paineis-dashboards-tempo-real.md`, `docs/relatorios/SESSAO-7A-relatorio.md`.

---

## 1. Resumo executivo

Os 6 entregáveis da 7B foram implementados e **verificados por execução real contra um navegador de verdade**, não só por `curl`/testes de componente isolados — a verificação manual ponta a ponta (login real → painel → cartão → trilha → dashboard → alertas → chat) encontrou e corrigiu **6 bugs reais de integração** que nenhum teste existente (unit, integração de service, ou `curl`) detectava, porque todos dependiam de comportamento específico de navegador (CORS) ou de como o `PermissionGuard` deriva contexto de uma rota HTTP real (não de uma chamada de service direta). Ver §3.

- `pnpm build`: limpo (5 pacotes, incluindo `@wms/frontend`).
- `pnpm test`: **200/200** (180 backend + 19 `@wms/ui` + 1 frontend).
- `pnpm test:integration`: **267/267**, em **2 execuções consecutivas idênticas** (rodadas de propósito perto da meia-noite local, para provar que o achado de RF-flakiness de §3.6 está mesmo fechado).
- `docker compose up -d --build`: os 3 papéis de backend + o container `frontend` (porta 3001, ver nota abaixo) saudáveis.
- `curl localhost:3000/health/ready`: `{"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}`.
- Navegação manual real (Chrome headless via CDP, não simulação): login → painel → clique no cartão → trilha (verde+vermelho) → dashboard → alertas → chat. Screenshots em `docs/relatorios/screenshots/sessao-7b/`.

**Nota sobre o container `frontend`**: a porta 3001 estava ocupada por um container de OUTRO projeto (`vagalume-backend`) no início da sessão — parado com autorização explícita do usuário (é responsabilidade do outro projeto reiniciá-lo, não desta sessão). Com a porta livre, o container subiu mas **não funcionava** por dois bugs de infraestrutura pré-existentes, achados e corrigidos nesta sessão (§3.1, §3.2).

---

## 2. Achados reais — 6 bugs de integração só visíveis com navegador real

Todos os itens abaixo passavam em `curl` e em todos os testes de service existentes; nenhum era visível sem simular exatamente o que um navegador faz (preflight CORS) ou o que o `PermissionGuard` faz com uma requisição HTTP real (`request.query`/`request.params`/`request.body`).

### 2.1 `main.ts` nunca chamava `app.enableCors()` — API inteira inacessível a partir de QUALQUER frontend em navegador

`RealtimeGateway` já configurava CORS para WebSocket há sessões; a API REST nunca teve o equivalente. Sem isso, todo `fetch` do frontend (origem `:3001`) contra a API (origem `:3000`) falha silenciosamente no preflight (`net::ERR_FAILED`, `PreflightMissingAllowOriginHeader`) — `curl` nunca mostra isso porque não executa preflight. Corrigido em `apps/backend/src/main.ts`, com uma armadilha adicional: a primeira tentativa chamou `enableCors()` DEPOIS de `app.init()` (que já registra todas as rotas) — o middleware CORS ficava depois do handler 404 padrão do Express no stack e nunca era alcançado. Fix definitivo: `enableCors()` movido para ANTES de `app.init()`.

**Blast radius**: este bug afetava TODO o frontend, não só a 7B — nenhuma sessão futura que dependesse de um navegador real contra a API teria funcionado sem ele.

### 2.2 `Dockerfile.frontend`: `CMD ["pnpm", "start"]` não existia como script na raiz do monorepo

O `CMD` rodava `pnpm start` em `/app` (raiz), mas o `package.json` raiz não tem script `start` (só `turbo run <task>`). Corrigido para `CMD ["pnpm", "--filter", "@wms/frontend", "start"]`. Um segundo bug encadeado: `apps/frontend/package.json`'s `start` script era `next start` (porta 3000 por padrão), mas o container expõe/mapeia 3001 — corrigido para `next start -p 3001` (mesma porta do `dev`).

### 2.3 `OperationFlowController.getFlowState()` (7B) e `OperationsBoardController.getPreference()` (7A): `PermissionGuard` nunca recebia `warehouse_id`

`PermissionGuard.canActivate()` deriva o contexto WAREHOUSE de `request.query.warehouse_id` (ou `params`/`body`) para checar `hasPermission()`. Nenhuma das duas rotas tinha esse campo em lugar nenhum da requisição — `hasPermission()` nunca casava a atribuição de um usuário WAREHOUSE-scope real (só passava para quem é irrestrito, o caso raro), e a rota negava (`403 missing permission`) para o caso comum. Achado com um usuário `GESTOR_ARMAZEM` real (não irrestrito) — os testes de service existentes chamam os services diretamente, nunca via `PermissionGuard`. Corrigido adicionando `warehouse_id` como query param obrigatório em ambos os endpoints (mesmo padrão já usado por `listCards`/`savePreference`); o frontend (trilha, painel) passa o `warehouseId` do contexto de autenticação.

### 2.4 `AlertService.list()`: coluna `warehouse_id`/`tenant_id`/`status`/`severity` ambígua quando chamado com `userId`

`wms.alert_read` também tem `warehouse_id`/`tenant_id` (duplicados para a própria RLS dela, migration 0055). A cláusula `WHERE` de `list()` usava essas colunas SEM prefixo de tabela — `curl` nunca disparava porque nenhum teste de integração existente chamava `list()` com `userId` (só o controller real faz isso, para o `LEFT JOIN alert_read` que resolve `is_read`). `GET /paineis/alertas` retornava 500 para toda requisição real. Corrigido qualificando todas as condições com `a.`; adicionado teste de regressão (`alert.integration.spec.ts`, "list() com userId (LEFT JOIN alert_read) não quebra por coluna ambígua").

### 2.5 `ChatService.listMessages()`: sem nome do remetente

Retornava só `sender_user_id` (UUID) — a tela não tinha como mostrar quem enviou cada mensagem (nenhum endpoint de diretório de usuários existe nesta sessão). Adicionado `LEFT JOIN wms.user` (mesmo padrão de `OperationFlowService.getFlowState()`'s `updated_by_name`), retornando `sender_name`.

### 2.6 `windowCoveringNow()` — bug de meia-noite, mais espalhado do que a Sessão 7A havia registrado

A Sessão 7A já tinha achado e documentado esse bug em UM arquivo (`inbound-order.integration.spec.ts`). Rodando a suíte de integração perto da meia-noite local durante a verificação desta sessão, o MESMO formato de bug reapareceu em **7 outros arquivos** (`picking-packing-carregamento`, e 6 de `portaria/__tests__/`) — cada um tinha sua PRÓPRIA cópia quase-idêntica da lógica "janela de tempo em torno de agora", todas perdendo a data ao formatar só a hora (`toTimeString().slice(0,8)`). Corrigido na raiz: extraído `buildTimeWindow()`, único helper compartilhado em `portaria/__tests__/test-helpers.ts`, usado pelos 9 arquivos (removendo as ~9 cópias quase-duplicadas). Ver `[[wms-midnight-flaky-window-config-test]]` (memória atualizada).

---

## 3. Matriz requisito → arquivo → teste

| Requisito | Arquivo(s) | Teste |
|---|---|---|
| RF-PAI-005 — Trilha de etapas [O CORAÇÃO] | `packages/ui/src/components/FlowTrail.tsx` | `FlowTrail.spec.tsx` (11 testes: estados DONE/acionável/futura-inerte/bloqueada, aviso de etapa posterior, navegação por teclado, `aria-current`/`aria-disabled`, contraste AA via tokens) |
| RF-PAI-001/002 — Cartão do Painel | `packages/ui/src/components/OperationCard.tsx` | `OperationCard.spec.tsx` (8 testes: documento/cliente/etapa/tempo, badges de atraso e exceção, clique) |
| RF-PAI-001/002 — Tela do Painel | `apps/frontend/src/app/(internal)/painel/page.tsx` | Verificação manual (screenshot `02-painel.png`); filtros combináveis, ordenação atrasados-primeiro (`sortCards`) |
| RD-PAI-005 — Preferências persistidas (endpoint 7A, não storage) | `painel/page.tsx` (GET/POST `/paineis/operacoes/preferencias`) | Verificado por `curl` real: salvar `{onlyLate:true, text:"PED"}`, reabrir a tela, filtro carregado do servidor (screenshot `02-painel.png` reflete o estado salvo) |
| RF-PAI-003 — Tempo real ≤2s, sem reordenação brusca, indicador de modo degradado | `apps/frontend/src/lib/use-realtime.ts`, `painel/page.tsx` | Ver §4.1 (decisão de arquitetura: polling 2s como estratégia PADRÃO no Painel, não fallback) |
| RF-PAI-010 — Centro de alertas (badge, severidade, marcar lido, navegar à origem) | `apps/frontend/src/app/(internal)/alertas/page.tsx`, `(internal)/layout.tsx` (badge no header) | Verificação manual (screenshot `05-alertas.png`); regressão de backend em `alert.integration.spec.ts` (§2.4) |
| RF-PAI-030/RN-PAI-031 — Chat (sala armazém-turno, zero ação operacional) | `apps/frontend/src/app/(internal)/chat/page.tsx` | Verificação manual (screenshot `06-chat.png`); prova estrutural de RN-PAI-031 já feita na 7A (`ChatService` não injeta service de negócio algum) |
| RF-PAI-040/043 — Dashboard (4 grupos, período+cliente, valor+7d+tendência+série, CSV, top-5) | `apps/frontend/src/app/(internal)/dashboard/[group]/page.tsx`, `apps/frontend/src/lib/kpi-catalog.ts` | Verificação manual (screenshot `04-dashboard.png`, grupo Expedição com 5 KPIs, tendência e média de 7 dias reais) |
| RG-013 — Só `@wms/ui`, só Lucide, AA, responsivo, feedback <100ms, erro legível | Todo o frontend | `@wms/ui` único import de componente em todas as telas; `ApiError.message` (nunca stack trace) exibido em `role="alert"` |
| Contrato único de leitura de etapas (não duplicar a 6A) | `apps/backend/src/core/operation-flow/operation-flow.controller.ts` (novo endpoint HTTP sobre o `OperationFlowService.getFlowState()` já existente), `trilha/[entity]/[entityId]/page.tsx` | `rbac-resolution.integration.spec.ts` (indireto, via `getMyContext`); verificação manual — trilha real com PEDIDO verde + PICKING vermelho (screenshot `03-trilha.png`) |
| Autenticação (pré-requisito não coberto por nenhuma sessão anterior) | `apps/backend/src/core/rbac/rbac.service.ts` (`getMyContext`), `auth.controller.ts` (`GET /auth/me`), `apps/frontend/src/lib/auth-context.tsx`, `login/page.tsx` | `rbac-resolution.integration.spec.ts` (+2 testes: resolve armazéns/clientes com nome legível; sem atribuições retorna listas vazias) |

---

## 4. Decisões de arquitetura registradas

### 4.1 Painel de Operações: polling de 2s como estratégia PADRÃO, não WebSocket

RF-PAI-003 pede "assinatura via WebSocket". A ponte Pub/Sub (`realtime-fanout.worker.impl.ts`, corrigida no checkpoint da Sessão 7) publica em `rt:{tenant_id}:{warehouse_id}:{topico}` — **um único `tenant_id` por conexão WebSocket**. O Painel é deliberadamente CROSS-CLIENTE (RN-SEG-011 — um `GESTOR_ARMAZEM` vê pedidos de vários clientes do mesmo armazém numa única tela); não existe um único `tenant_id` para uma conexão WS assinar que cubra "todos os clientes que este usuário pode ver". Esta é a MESMA tensão arquitetural já documentada em `RbacService` (`[ACHADO ARQUITETURAL]`: RLS compara a um único `tenant_id`, nunca a uma lista) — não resolvida aqui, [DÉBITO] herdado, não desta sessão.

Decisão: `useRealtime()` com `skipWebSocket: true` no Painel — o modo "degradado" (polling a cada 2s, dentro do limite de RF-PAI-003) é a estratégia PADRÃO desta tela, não um fallback de falha; o indicador visual mostra "Atualização automática (2s)" (não "erro"), honesto sobre o que está de fato acontecendo. A Trilha e o Chat, que têm um `tenant_id` inequívoco (o fluxo pertence a UM cliente; a sala armazém-turno tem `tenant_id` `NULL`, que mapeia para o segmento `global` do gateway), usam WebSocket real.

"Sem reordenação brusca": a lista de cartões só é substituída depois que a nova busca termina (nunca esvaziada durante o refetch); React reconcilia por `key={flowId}`.

### 4.2 Descoberta de armazém/cliente pós-login: `GET /auth/me` (novo)

O JWT (RF-SEG-003) carrega só `{sub, assignments_hash, area}` — de propósito, para não invalidar o token a cada mudança de atribuição. Nenhuma sessão anterior havia enfrentado a pergunta "como o frontend descobre em quais armazéns o usuário logado pode operar" (as sessões de backend testam services diretamente, sem esse problema). Não existia nenhum endpoint de "minhas atribuições" com nome legível de armazém/cliente. Adicionado `RbacService.getMyContext(userId)` (reaproveita `getActiveAssignments()` já existente, resolve nomes via `wms.warehouse`/`wms.client`) e `GET /auth/me` no `AuthController`, gated só por `@Authenticated()` (não uma permissão específica — toda pessoa autenticada pode ver as próprias atribuições). `wms.client` tem RLS por tenant; a resolução de nomes é cross-tenant por natureza (as atribuições vêm de vários clientes), então usa `transactionAsWorker()` — mesmo padrão já estabelecido por `OperationsBoardService`.

---

## 5. Lacunas e débitos

- `[LACUNA]` RF-PAI-005 "abre a tela da operação" a partir da etapa acionável: as telas de EXECUÇÃO de cada operação (picking, conferência, etc.) são de outras sessões/DOCs e não existem na área `internal` ainda — a Trilha registra qual etapa foi acionada mas não navega para lugar nenhum, com uma nota explícita na tela.
- `[LACUNA]` RF-PAI-010 "navegar para o objeto de origem": só `inbound_order`/`outbound_order` têm uma tela de destino (a Trilha) nesta sessão; alertas de outras origens (dispositivo, lote) não têm tela própria ainda.
- `[DÉBITO]` RF-PAI-030 menções (@usuário): não existe endpoint de diretório de usuários para montar um seletor; o campo `mentioned_user_ids` está wired no backend mas sem UI de seleção.
- `[DÉBITO]` RF-PAI-030 anexo de imagem: não existe endpoint HTTP de upload (`FileStorageService` é só interno, usado por outros módulos para seus próprios anexos). O campo aceita uma URL já hospedada em vez de um seletor de arquivo real.
- `[DÉBITO]` Silent refresh do access token: o token de 15 min não é renovado automaticamente antes de expirar — ao expirar, a sessão cai e exige novo login. `/auth/refresh` existe no backend mas não está consumido pelo frontend nesta sessão.
- `[DÉBITO]` Ferramenta de teste de integração de tela (item 6 do prompt): nenhuma existia; não introduzida aqui (fora do escopo desta sessão adicionar uma nova dependência de teste sem ADR). Os testes de componente (trilha + cartão) são os obrigatórios e estão feitos.
- `[DÉBITO]` `[ACHADO ARQUITETURAL]` herdado (§4.1): tópico WebSocket por-tenant não serve telas cross-cliente. Não resolvido aqui — pertence à mesma frente de trabalho do `[DEBITO: app.tenant_ids como lista]` já registrado em `RbacService`.

---

## 6. Evidência

### 6.1 Build e testes

```
$ pnpm build
Tasks: 5 successful, 5 total

$ pnpm test
Tasks: 8 successful, 8 total
@wms/backend:test — Tests 180 passed (180)
@wms/ui:test — Tests 19 passed (19)
@wms/frontend:test — Tests 1 passed (1)

$ pnpm test:integration   # execução 1
Test Files  68 passed (68)
     Tests  267 passed (267)

$ pnpm test:integration   # execução 2 (consecutiva, idêntica)
Test Files  68 passed (68)
     Tests  267 passed (267)
```

### 6.2 Docker + health check

```
$ docker compose up -d --build
 Container wms-backend-api      Started (healthy)
 Container wms-backend-worker   Started (healthy)
 Container wms-backend-scheduler Started (healthy)
 Container wms-frontend         Started

$ curl localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-23T02:40:01.797Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ curl -o /dev/null -w "%{http_code}" localhost:3001/login
200
```

### 6.3 Navegação manual real (Chrome headless via CDP — login de verdade, clique de verdade, não simulação)

Dado de demonstração: usuário `demo7b@wms-example.invalid` (papel `GESTOR_ARMAZEM`, armazém SP01, cliente ACME01), 1 pedido de saída liberado com PEDIDO concluída + PICKING acionável, 1 alerta de atraso, 8 dias de `kpi_daily` sintéticos, 1 mensagem de chat — inserido via SQL direto no Postgres do `docker compose` (mesmo padrão de bypass de RLS do `run-seed.mjs` oficial), documentado, não é seed permanente do projeto.

| Tela | Screenshot | O que prova |
|---|---|---|
| Login | `screenshots/sessao-7b/01-login.png` | Formulário real, envio real |
| Painel | `screenshots/sessao-7b/02-painel.png` | Login bem-sucedido → cartão real do pedido, badge de alertas não lidos no header, filtros persistidos do servidor |
| Trilha (clique real no cartão) | `screenshots/sessao-7b/07-click-navigation-painel-trilha.png` | Clique no `data-testid="operation-card-..."` navega para `/trilha/outbound_order/...` — não é uma URL digitada à mão |
| Trilha (detalhe) | `screenshots/sessao-7b/03-trilha.png` | PEDIDO verde "Concluída · 22/08, 21:35 · Demo Sessão 7B"; PICKING vermelho "Pendente · iniciar", borda de 2px; demais etapas esmaecidas "Aguardando etapa anterior" — os 3 estados visuais de RF-PAI-005 num fluxo real |
| Dashboard | `screenshots/sessao-7b/04-dashboard.png` | Grupo Expedição: 5 cartões de KPI com valor, seta de tendência colorida, média de 7 dias — dados reais de `kpi_daily` |
| Alertas | `screenshots/sessao-7b/05-alertas.png` | Badge de severidade "Atenção" com ícone+texto (nunca só cor), marcador de não-lido, ação "Marcar como lido" |
| Chat | `screenshots/sessao-7b/06-chat.png` | Sala "armazém e turno", mensagem com remetente resolvido ("Você"), composer com anexo opcional |

---

## 7. Commit

Este relatório e `docs/PROMPT-SESSAO-7B-doc10-frontend.md` fazem parte do commit desta sessão. Backend teve mudanças reais fora do escopo estritamente "frontend" — todas descritas no §2 como pré-requisitos descobertos pela própria verificação manual desta sessão (não trabalho de uma sessão futura antecipado sem necessidade).
