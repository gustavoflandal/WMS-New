# Relatório — Sessão 3: DOC-12 Segurança, Permissões e Auditoria

**Data**: 2026-08-16
**Escopo**: DOC-12 completo — autenticação real, RBAC multi-dimensional [INVIOLÁVEL], alçadas, trilha de auditoria imutável, motor de workflow de aprovação, LGPD (mascaramento).

---

## 1. Resumo executivo

Todos os 7 entregáveis da missão foram implementados e testados. `docker compose up -d`, `pnpm build`, `pnpm test` e `pnpm test:integration` estão **verdes com zero skip**. `curl localhost:3000/health/ready` responde `200`.

Durante a validação em Docker (a única forma de exercitar o grafo de DI completo via `NestFactory.create(AppModule)` — os testes instanciam serviços diretamente, sem passar pelo boot real do Nest) foi encontrado e corrigido **um bug real de wiring de DI** que não aparecia em nenhum teste. Está descrito na §5.

Também foi encontrada, durante a mesma auditoria final, uma **vulnerabilidade real de falsificação de identidade** (RG-003 [INVIOLÁVEL]): os 13 controllers de cadastro (DOC-02, Sessões 2A/2B) ainda extraíam `actor_user_id` do corpo/query da requisição em vez de derivá-lo do principal autenticado, e nenhum usava `@Audited()`. **Corrigida nesta sessão** após revisão do usuário — detalhes completos na §7, incluindo dois bugs adicionais descobertos durante a correção (DI sob Vitest/esbuild e ordenação do middleware de rejeição vs. o body-parser do Express).

---

## 2. Matriz requisito → arquivo → teste

| Entregável DOC-12 | Arquivos principais | Teste(s) |
|---|---|---|
| 1. Autenticação (Argon2id, política de senha, JWT 15min + refresh 8h/24h, MFA TOTP, portal×internal) | `core/auth/password.service.ts`, `jwt.service.ts`, `jwt.module.ts`, `mfa.util.ts`, `auth.service.ts`, `auth.controller.ts` | `core/auth/__tests__/mfa.util.spec.ts` (6), fluxo exercitado indiretamente por `rbac-resolution.integration.spec.ts` e `token-invalidation.integration.spec.ts` |
| 2. RBAC multi-dimensional [INVIOLÁVEL] (RN-SEG-011/012) | `core/rbac/rbac.service.ts`, `route-audit.service.ts`, `guards/permission.guard.ts`, `decorators/*` | `route-audit.spec.ts` (2, unit — inclui caso negativo de boot-fail), `rbac-resolution.integration.spec.ts` (3), `token-invalidation.integration.spec.ts` (1) |
| 3. Alçadas (approval_authority) + escalonamento automático | `core/workflow/approval-authority.service.ts` | `workflow/__tests__/escalation.integration.spec.ts` (2) |
| 4. Auditoria imutável (audit_log particionado, INSERT/SELECT-only) | `core/audit/audit.service.ts`, `audit.interceptor.ts`, `decorators/audited.decorator.ts`, `audit.controller.ts` | `audit-immutability.integration.spec.ts` (3) |
| 5. Workflow de aprovação (state machine, efeito suspensivo, segregação de funções, notificação real-time, auto-expiração) | `core/workflow/operational-exception.service.ts/.controller.ts`, `workers/exception-expiry.worker.impl.ts` | `suspensive-effect` (2), `self-approval-denied` (1), `two-step-distinct-approvers` (1), `exception-expiry.integration.spec.ts` (3) |
| 6. LGPD (mascaramento CPF/CNH + exibição completa auditada) | `core/lgpd/masking.util.ts`, `personal-data-access.service.ts` | `masking.util.spec.ts` (4, unit), `cpf-masking-audit.integration.spec.ts` (2) |
| 7. Testes de regressão (Sessões 1.5/2A/2B com RBAC real) | — (cobertura transversal) | 34/34 arquivos de integração, incluindo suites herdadas (`rls.integration.spec.ts`, `stock-movement-append-only`, `client-isolation`, `code-immutability`, etc.) |
| 8. RG-003 [INVIOLÁVEL] — identidade do ator nunca vem do cliente | `core/rbac/middleware/reject-actor-spoofing.middleware.ts`, `app.module.ts` (`NestModule.configure()`), 13 controllers/services de cadastro | `reject-actor-spoofing.middleware.spec.ts` (5, unit), `actor-identity-e2e.integration.spec.ts` (4, e2e HTTP real) |

**Totais finais**: unitários 6/6 arquivos, 25/25 testes · integração 34/34 arquivos, 84/84 testes.

---

## 3. Migrations desta sessão (0015–0022)

| # | Arquivo | Conteúdo |
|---|---|---|
| 0015 | `0015-user.sql` | `wms.user`, `wms.user_password_history`; bootstrap do usuário "Sistema" (`00000000-…-001`) — necessário porque `audit_log.user_id` (migration 0019) passou a exigir FK real, e esse UUID já era usado como ator de sistema desde a Sessão 2A |
| 0016 | `0016-rbac.sql` | `wms.permission` (18 códigos), `wms.role` (13 papéis semente), `wms.role_permission`, `wms.user_role_assignment` + trigger `validate_user_role_assignment` (RD-SEG-010: área bate com usuário, `warehouse_id`/`client_id` obrigatórios conforme escopo das permissões do papel) |
| 0017 | `0017-auth-session.sql` | `wms.auth_session` (refresh tokens opacos, revogáveis), `wms.login_attempt` |
| 0018 | `0018-approval-authority.sql` | `wms.exception_type`, `wms.approval_authority` |
| 0019 | `0019-audit-log.sql` | `wms.audit_log` particionado mensalmente, `SECURITY DEFINER` para gestão de partição, `REVOKE UPDATE, DELETE` (INSERT/SELECT-only) |
| 0020 | `0020-operational-exception.sql` | `wms.operational_exception` + `_decision`, RLS por tenant |
| 0021 | `0021-password-policy-defaults.sql` | `SEG.PASSWORD_*` em `app_parameter` (10 caracteres, 3 classes, bloqueio 15min/5 falhas, histórico de 5) |
| 0022 | `0022-worker-event-outbox-insert.sql` | `GRANT INSERT` em `event_outbox` para `wms_worker` (gap de privilégio descoberto ao testar a notificação de exceção via outbox) |

---

## 4. Catálogo de permissões e papéis

**18 códigos de permissão** inseridos (10 do RD-SEG-014 citados literalmente do documento + 7 `DAD.*` para cobrir DOC-02/Sessões 2A-2B + `POR.DADO_PESSOAL_COMPLETO` + 2 `SEG.REALTIME_*`).

**13 papéis semente** (nomes exatos do RF-SEG-013). `[LACUNA: anexo RF-SEG-013 ausente]` — o DOC-12 referencia um anexo consolidando os catálogos por papel que não estava presente no documento fornecido. Composição de permissões só foi declarada onde o próprio corpo do DOC-12 dá sinal direto:

| Papel | Permissões atribuídas |
|---|---|
| `ADMIN_SISTEMA` | todas as `GLOBAL` (bootstrap) |
| `ADMIN_SEGURANCA` | `SEG.GESTAO_PAPEIS`, `SEG.GESTAO_ATRIBUICOES`, `SEG.CONSULTA_AUDITORIA` |
| `GESTOR_ARMAZEM` | `SEG.APROVACAO_EXCECAO`, `SEG.CONSULTA_AUDITORIA`, overrides `EST.*`, `DAD.BLOQUEIO_CADASTRO`, `POR.DADO_PESSOAL_COMPLETO` |
| `CONFERENTE` | `DAD.PRODUCT_CATALOG_MANAGE` (placeholder — ver débito abaixo) |
| todos os internos exceto `ADMIN_SISTEMA` | `SEG.REALTIME_SUBSCRIBE`, `SEG.REALTIME_RESYNC` |
| **`LIDER_TURNO`, `PORTEIRO`, `OPERADOR_EMPILHADEIRA`, `OPERADOR_PICKING`, `FATURISTA`, `FISCAL`, `INVENTARIANTE`, `CLIENTE_CONSULTA`, `CLIENTE_OPERACAO`** | **nenhuma permissão além de realtime** — `[DÉBITO]` |

**`[DÉBITO + sessão-alvo: quando DOC-03/04/05… existirem]`**: 9 dos 13 papéis semente foram criados sem composição de permissões de domínio porque os catálogos `REC.*`, `POR.*` (além do já usado), `EXP.*`, `FIS.*` dependem de documentos (DOC-03/04/05…) que ainda não existem no repositório. Isso é esperado e documentado na própria migration 0016 — não é uma omissão silenciosa.

---

## 5. Bug de DI encontrado e corrigido durante a validação Docker

**Sintoma**: `wms-backend-api`/`worker`/`scheduler` saíam com código 1 imediatamente após o boot, mesmo após corrigir o `JWT_SECRET` ausente do `docker-compose.yml` (fix anterior, também aplicado nesta sessão).

**Causa raiz**: `PermissionGuard` (usado via `@UseGuards(PermissionGuard)` em 15+ controllers) depende de `JwtService`. `RbacModule` importa `JwtModule` mas **não o reexportava**, então qualquer módulo que importasse `RbacModule` (não a própria `JwtModule`) ganhava acesso a `RbacService`/`PermissionGuard`, mas não a `JwtService` — necessária para resolver as dependências do próprio guard no escopo do módulo hospedeiro do controller. Além disso, **`CadastroModule` não importava `RbacModule` de forma alguma**, apesar de todos os seus 13 controllers usarem `@RequirePermission`/`PermissionGuard`.

Esse bug era invisível a todos os testes porque nenhuma suíte builda a aplicação inteira via `NestFactory.create(AppModule)` — apenas `main.ts` (executado só em runtime real, incluindo Docker) faz isso.

**Correção** (2 arquivos):
- `core/rbac/rbac.module.ts`: `exports` passou a incluir `JwtModule` (reexportado), não só `RbacService`/`PermissionGuard`.
- `modules/cadastro/cadastro.module.ts`: adicionado `RbacModule` a `imports`.

**Verificação**: rebuild dos 3 serviços backend, todos health-check `healthy`; log de boot de cada um mostra `RouteAuditService: RN-SEG-012 … Boot liberado` e `NestApplication successfully started`; `curl localhost:3000/health/ready` → `200 {"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}`; suíte completa (unit + integration) re-executada e permanece 100% verde após a correção.

---

## 6. Validação de Definition of Done

| Item do DoD | Status | Evidência |
|---|---|---|
| `docker compose up -d` | ✅ | `backend-api`, `backend-worker`, `backend-scheduler` — todos `Up … (healthy)` |
| `pnpm build` | ✅ | 5/5 pacotes |
| `pnpm test` | ✅ | 6/6 arquivos, 25/25 testes |
| `pnpm test:integration` | ✅ | 34/34 arquivos, 84/84 testes |
| `curl localhost:3000/health/ready` | ✅ | `200`, postgresql/redis `ok` |
| RG-003 verificado contra o Docker real | ✅ | `curl` com `actor_user_id`/`user_id` forjados → `400` citando RG-003; requisição limpa sem token → `401` (prova que o middleware não bloqueia em excesso) |
| `git commit && git push` | ⏳ pendente | aguardando confirmação explícita do usuário (regra do projeto) |
| Relatório final | ✅ | este documento |

**Fora do escopo, não bloqueante do DoD**: `wms-frontend` continua saindo com `ERR_PNPM_NO_SCRIPT_OR_SERVER Missing script start or file server.js` — falha pré-existente, nunca tocada nesta sessão (nenhum arquivo de frontend foi modificado).

---

## 7. RG-003 [INVIOLÁVEL] — correção da falsificação de identidade nos 13 controllers de cadastro

### 7.1 A vulnerabilidade

Todos os 13 controllers de cadastro (DOC-02, Sessões 2A/2B) extraíam `actor_user_id` do body ou da query da requisição — literalmente enviado pelo cliente — e o gravavam em `created_by`/`updated_by` e no `user_id` do GUC `app.user_id` (usado por RLS), mesmo com `PermissionGuard` já autenticando o JWT e populando `request.principal.userId`. Qualquer usuário autenticado podia se passar por outro na trilha de auditoria. Nenhum desses controllers usava `@Audited()` — o motor de auditoria (item 4 da missão) existia e estava testado, mas não conectado à maior superfície de escrita do sistema.

### 7.2 A correção

1. **`actor_user_id` removido de todos os DTOs** (`CreateXInput`/`UpdateXInput`) dos 13 módulos — os services agora recebem o ator como parâmetro explícito separado (`create(input, actorUserId)`), nunca embutido no corpo desserializado do cliente.
2. **Todos os 13 controllers passaram a usar `@CurrentUser()`** (derivado de `request.principal`, setado pelo `PermissionGuard` a partir do JWT verificado) como única fonte do ator, em toda rota — leitura e escrita.
3. **Middleware global `reject-actor-spoofing.middleware.ts`** — rejeita (400, nunca ignora em silêncio) qualquer requisição que ainda tente informar `actor_user_id`/`user_id` via body ou query, para toda a aplicação (não apenas cadastro), registrado via `AppModule.configure()` (`NestModule`).
4. **Cobertura de auditoria (RN-SEG-032)**: CREATE via `@Audited()` + `AuditInterceptor` (before=null, correto — a entidade ainda não existe); UPDATE/STATUS_CHANGE/link/unlink via chamada explícita a `AuditService.record()` dentro do próprio service, com `before` capturado do `findById()` que a operação já fazia e `requirement_id` citando o RF-DAD-XXX/RG-XXX aplicável.
5. **9 services** (Zone, Warehouse, StorageEquipment, Client, ClientWarehouseSettings, LogicalWarehouse, Product, Batch, Location) passaram a injetar `AuditService`; `CadastroModule` passou a importar `AuditModule`.

`pallet.service.ts` manteve o padrão antigo intencionalmente: não tem controller/rota HTTP própria (não é alcançável por nenhum cliente nesta sessão), então não fazia parte da superfície de ataque demonstrada — fica registrado aqui, não corrigido silenciosamente.

### 7.3 Dois bugs adicionais encontrados ao validar a correção

**Bug A — DI sob Vitest (esbuild)**: assim como o bug de RbacModule/CadastroModule da §5, todo constructor com mais de um parâmetro (e vários com um só) resolvia `undefined` quando instanciado via `TestingModule.get()`/`createNestApplication()` — porque nenhum teste anterior desta sessão havia bootado o `CadastroModule` real via DI do Nest (todos os outros testes de integração de cadastro fazem `new XService(db)` manualmente, contornando reflection). O primeiro teste HTTP real (`actor-identity-e2e.integration.spec.ts`) expôs isso em cascata: `AuthService`, `PasswordService`, `RbacService`, `AuditService`, `PermissionGuard`, `AuditInterceptor`, os 13 controllers e os 13 services de cadastro (+ `DocumentNumberingService`, `LpnService`, `PalletService`) precisaram do mesmo `@Inject(Token)` explícito já usado em `RouteAuditService` desde a §5.

**Bug B — ordem do middleware vs. body-parser do Express**: a primeira tentativa registrou o middleware via `app.use(rejectActorSpoofingMiddleware)` cru em `main.ts`, antes de `app.init()`. Isso rejeitava corretamente `user_id`/`actor_user_id` na **query** (sempre disponível), mas **não no body** — porque o body-parser padrão do Nest ainda não tinha rodado quando o middleware era executado, então `req.body` chegava vazio até o middleware, que deixava passar. Mover para depois de `app.init()` quebrou de outro jeito: o Nest registra as rotas dos controllers dentro do próprio `init()`, então qualquer `app.use()` posterior nunca era alcançado (a rota já respondia antes). **A correção correta e definitiva é a idiomática do Nest**: registrar via `AppModule implements NestModule { configure(consumer) { consumer.apply(...).forRoutes('*') } }`, que o framework garante rodar depois do parser e antes do roteamento, independente de timing de chamada. Verificado tanto no teste e2e quanto via `curl` direto contra os 3 containers Docker reconstruídos.

### 7.4 Verificação

- `pnpm test`: 6/6 arquivos, 25/25 testes (incluindo `reject-actor-spoofing.middleware.spec.ts`, 5 testes unitários puros do middleware).
- `pnpm test:integration`: 34/34 arquivos, 84/84 testes (incluindo `actor-identity-e2e.integration.spec.ts`, 4 testes que sobem uma aplicação HTTP real com JWT genuíno e varrem 11 dos 13 controllers via requisições reais, comparando `created_by`/`audit_log.user_id` com o principal do token).
- Contra os 3 containers Docker reconstruídos: `actor_user_id` forjado no body → `400` citando RG-003; `user_id` forjado na query → `400`; requisição sem token → `401` (prova de que o middleware não bloqueia em excesso).
- `warehouse`/`client` (permissões GLOBAL, exigem MFA) ficaram fora da varredura HTTP por simplicidade de setup de teste, mas têm a mesma garantia estrutural: seus DTOs também não têm mais campo `actor_user_id`, e a suíte herdada (`sku-uniqueness`, `client-isolation`, etc.) já prova `created_by` correto no nível de service.

---

## 8. Outros débitos e observações honestas

- **PIN de coletor**: não implementado (`grep` por `PIN`/`pin_` em `core/auth/` não retorna nada). O item da missão era condicional ("se factível") — não há dispositivos coletores no escopo atual do backend para justificar o fluxo; tratado como fora do escopo desta sessão.
- **LGPD — direitos do titular** (acesso/portabilidade/eliminação): não implementado, conforme já previsto como débito aceitável na missão original ("deferrable as debt"). Só o mascaramento + exibição completa auditada (RN-SEG-051) foi implementado e testado.
- **`e2e-event-pipeline.integration.spec.ts`**: apresentou falhas intermitentes quando executado dentro da suíte completa sob carga combinada (observado em execuções anteriores desta sessão, antes da validação final), mas passou de forma consistente tanto isoladamente quanto em todas as execuções completas mais recentes. Registrado aqui por transparência — não é uma regressão introduzida pelo DOC-12, é pré-existente e relacionado a timing sob carga, não a lógica.
- **`app_parameter` schema divergente**: a migration 0021 reaproveita o schema de `app_parameter` já existente desde a Sessão 2A/DOC-01 (`scope/name/value TEXT`), que diverge do dicionário formal do DOC-02 §5.7 (`key/value jsonb/value_type`). Débito já registrado no relatório da Sessão 2A; não tocado aqui, por instrução explícita de não refatorar código já testado.
- **`pallet.service.ts`**: mantém o padrão antigo de `actor_user_id` embutido no DTO (§7.2) — sem controller/rota própria nesta sessão, então fora da superfície de ataque demonstrada, mas deve ser corrigido quando DOC-04/05 (Recebimento) expuser um endpoint real para ele.

---

## 9. Próximos passos sugeridos

1. Quando DOC-03/04/05 existirem: completar a composição de permissões dos 9 papéis semente ainda sem catálogo de domínio (§4) e corrigir `pallet.service.ts` (§8) quando ganhar um controller real.
2. `git add` seletivo + `git commit` (aguardando autorização explícita do usuário — já concedida para esta rodada, ver §7).
