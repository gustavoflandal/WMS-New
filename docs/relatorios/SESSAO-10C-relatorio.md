# Sessão 10C — DOC-17 §2: consumo do contrato de Detalhe de Etapa no frontend

**Data**: 2026-08-25
**Escopo**: fechar o `[DEBITO: 10A]` — "frontend não consome o novo endpoint
ainda" (ver `docs/relatorios/SESSAO-10A-relatorio.md` §5) — implementando o
lado do frontend do contrato único de Detalhe de Etapa criado na Sessão 10A
(`GET /fluxo-operacional/:entity/:entityId/steps/:stepCode/detail`).

Sem prompt de sessão dedicado: continuação direta do débito registrado pela
10A, autorizada em conversa ("siga e faça da melhor forma possível... Ao
finalizar, salve as telas... Após faça o commit e o push").

---

## 1. O que mudou e por quê

**DOC-17 §2 [INVIOLÁVEL]** resolve formalmente a divergência com
RN-EXP-011 item 3: *"separar DETALHE de EXECUÇÃO: o clique SEMPRE abre; o
que varia é o que a tela permite fazer."* Até esta sessão, `FlowTrail.tsx`
ainda implementava o comportamento antigo (clique em etapa futura era
inerte, exibia aviso "conclua a etapa anterior" sem navegar). A trilha
(`trilha/[entity]/[entityId]/page.tsx`) só logava `lastAction` — não existia
nenhuma tela de detalhe.

Mudança: todo clique em qualquer etapa (concluída, acionável, futura ou
bloqueada) sempre dispara a busca do contrato de detalhe e abre um painel.
O que muda entre os 4 modos (RN-TEL-002) é só o que o painel oferece —
nunca se ele abre. A decisão de bloquear a **execução** real continua
inteiramente no backend (`FLOW_STEP_ORDER_VIOLATION`), nunca no cliente.

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| DOC-17 §2 — clique sempre abre, nunca inerte | `packages/ui/src/components/FlowTrail.tsx` | `packages/ui/src/components/__tests__/FlowTrail.spec.tsx` (8 testes) |
| RF-TEL-001/RN-TEL-002 — painel genérico dos 4 modos, RG-013 (cor+ícone+texto) | `packages/ui/src/components/StepDetailPanel.tsx` (novo) | `packages/ui/src/components/__tests__/StepDetailPanel.spec.tsx` (6 testes) |
| Consumo real do endpoint pela tela da trilha, erro nunca engolido | `apps/frontend/src/app/(internal)/trilha/[entity]/[entityId]/page.tsx` | `.../__tests__/page.spec.tsx` (2 testes, novo) |
| Rótulos de etapa da Reversa na trilha (`return_order`) | `apps/frontend/src/lib/step-labels.ts` | coberto indiretamente pelos testes acima |

## 3. Decisões de design (sistema `@wms/ui`)

- **Não foi criado componente por etapa.** `StepDetailPanel` é único e
  genérico — renderiza o `content` do contrato (tabela para array de
  objetos, lista de campos para objeto/escalar) e humaniza as chaves via um
  dicionário (`KEY_LABELS`), seguindo §8.3 do skill de design ("não invente
  componente novo se um existente serve").
- **"Ações disponíveis" é só informativo.** O contrato já devolve `actions`
  resolvidas pelo backend, mas a Parte B (telas de execução reais) não
  existe ainda — os badges de ação não são botões funcionais. Fingir uma
  mutação que não existe seria pior do que não mostrar nada.
- **RG-013 nos 4 modos**: cada modo tem cor + ícone Lucide + rótulo textual
  (`StatusBadge`), nunca só cor — verificado em teste (`icon-presence`).

## 4. Bug encontrado e corrigido durante a verificação visual

Ao capturar as telas reais (ver §6), o painel de Pesagem mostrava um campo
"Tasks" duplicado (título da seção + linha `dt` idêntica) e colunas em
inglês não traduzido (`Weighed at`, `Weight exception id`, `Package id`,
`Contents`). Causa: `ContentSection` passava `title={key}` também para
grupos de um único campo (array vazio/escalar), duplicando o rótulo; e o
dicionário `KEY_LABELS` não cobria todas as colunas reais de
`wms.package`/`wms.package_content`. Corrigido em
`packages/ui/src/components/StepDetailPanel.tsx`:
- grupo de campo único agora usa `title=""` (mesmo tratamento já dado a
  escalares) — sem duplicação;
- adicionadas as chaves `tasks`, `packages`, `items`, `contents`, `id`,
  `package_id`, `weighed_at`, `weight_exception_id`, `staged_at`,
  `loaded_at` ao `KEY_LABELS` (esta última em `wms.package`, RF-EXP-060 —
  ver `infra/postgres/migrations/0051-...sql:227-230`).

Sem esse bug ter sido pego por teste automatizado (os testes usam fixtures
pequenas que não reproduziam um array vazio nomeado ou os campos reais de
`package`) — só apareceu ao olhar a tela renderizada contra dados reais do
backend. Reforça por que a verificação visual (não só suíte verde) é parte
do Definition of Done para trabalho de frontend.

## 5. Saída real dos comandos

```
$ pnpm build
...
 Tasks:    5 successful, 5 total
  Time:    30.667s

$ pnpm test
@wms/backend:test:  Test Files 22 passed (22) | Tests 215 passed (215)
@wms/ui:test:       Test Files 3 passed (3)   | Tests 22 passed (22)
@wms/frontend:test: Test Files 7 passed (7)   | Tests 37 passed (37)
 Tasks:    8 successful, 8 total

$ pnpm test:integration   (execução 1/2)
@wms/backend:test:integration: Test Files 77 passed (77) | Tests 330 passed (330)
 Tasks:    6 successful, 6 total
  Time:    3m15.876s

$ pnpm test:integration   (execução 2/2)
@wms/backend:test:integration: Test Files 77 passed (77) | Tests 330 passed (330)
 Tasks:    6 successful, 6 total
  Time:    3m10.599s

$ docker compose -f infra/docker-compose.yml up -d --build
...
 Container wms-backend-api Started
 Container wms-frontend Started

$ curl localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T15:18:23.027Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ docker compose -f infra/docker-compose.yml ps
wms-backend-api         Up (healthy)   0.0.0.0:3000->3000/tcp
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)
wms-frontend            Up             0.0.0.0:3002->3002/tcp
wms-minio               Up (healthy)   0.0.0.0:9000-9001->9000-9001/tcp
wms-postgres            Up (healthy)   0.0.0.0:5432->5432/tcp
wms-redis               Up (healthy)   0.0.0.0:6379->6379/tcp
```

## 6. Evidência visual

Capturadas com Chromium headless (Playwright) contra o stack real via
Docker (`localhost:3002`/`localhost:3000`), com dados semeados diretamente
via as classes reais do backend (mesmo padrão dos testes de integração —
scripts temporários, apagados ao final da sessão, não fazem parte do
código-fonte). Usuário de demonstração com papel `CONFERENTE` (papel
`GESTOR_ARMAZEM` dispara RF-SEG-005 MFA por ter permissão `GLOBAL`, fora do
escopo desta sessão).

Em `docs/relatorios/screenshots/sessao-10c/`:

| Arquivo | Conteúdo |
|---|---|
| `01-login.png` | Tela de login |
| `02-painel.png` | Painel pós-login |
| `03-trilha-pedido-a.png` | Trilha do Pedido A: Pedido+Picking concluídos, Embalagem acionável, demais futuras |
| `04-detalhe-picking-consulta.png` | Clique em etapa concluída → painel modo **Consulta** |
| `05-detalhe-embalagem-execucao.png` | Clique na etapa acionável → painel modo **Execução** |
| `06-detalhe-pesagem-previsao.png` | Clique em etapa **futura** → painel modo **Previsão** (a prova de DOC-17 §2: antes desta sessão este clique era inerte) |
| `07-trilha-pedido-b.png` | Trilha do Pedido B: Picking bloqueado por exceção `EXP.CORTE_PICKING` |
| `08-detalhe-picking-bloqueada.png` | Clique na etapa bloqueada → painel modo **Bloqueada por exceção**, com tipo e status da exceção |

## 7. Incidente de ambiente (não relacionado ao código)

Durante a depuração inicial, um `taskkill` em processos identificados via
`netstat` na porta 3002 derrubou o backend de rede do Docker Desktop
inteiro (não eram processos Node soltos — eram os proxies de porta do
Docker Desktop para os containers do próprio `docker-compose.yml`, que já
rodava frontend+backend+postgres+redis+minio containerizados). Diagnosticado
pela mensagem `ERR_CONNECTION_REFUSED` generalizada e `docker compose ps`
falhando por engine inacessível. Resolvido religando o Docker Desktop e
rodando `docker compose up -d --build` (o rebuild também foi necessário
para o container `frontend` pegar o novo `dist/` do `@wms/ui`). Nenhum dado
foi perdido — os volumes do Postgres/MinIO persistiram.

## 8. Lacunas e débitos

**Fechado nesta sessão**: `[DEBITO: 10A]` "frontend não consome o novo
endpoint ainda" — `FlowTrail.tsx` não trata mais etapa futura como inerte;
existe uma tela de detalhe por etapa (`StepDetailPanel`, genérica).

**Em aberto (inalterados, fora do escopo desta sessão):**
- Parte B do DOC-17 inteira (Formulário de Campo, Transcrição, 8 telas de
  execução reais T-P1..T-P8, `execution_channel`, `TEL.MODO_EXECUCAO`) — os
  badges de "Ação disponível" no `StepDetailPanel` continuam informativos,
  não executam nada.
- `[DEBITO: 10A]` modo Bloqueada por exceção e 12/16 combinações de
  conteúdo por etapa sem teste de integração dedicado no backend (Sessão
  10A) — inalterado.
- `[LACUNA: DOC-05]` "Contagem (inventário)" ainda não exposta pelo
  contrato — inalterado.
- Nenhum teste de integração E2E navegador→backend real foi escrito (as
  telas foram verificadas manualmente via Playwright ad-hoc, não como parte
  da suíte permanente) — a suíte `page.spec.tsx` cobre o comportamento com
  mocks de `apiClient`, que é o padrão já usado no resto do frontend.
