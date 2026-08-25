# Sessão 10E — DOC-17 §6: Execução por Tela (backend)

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-10E-doc17-execucao-por-tela.md`
**Escopo**: RN-TEL-010, RN-TEL-011, RN-TEL-012 e RD-TEL-004
(`execution_channel`) — a governança de canal do DOC-17 §6.

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RN-TEL-010 [INVIOLÁVEL] — modo COLETOR/TELA/HIBRIDO por armazém e por operação | `execution-mode.util.ts`, `execution-mode.service.ts::resolveMode/assertCanExecute` | `execution-mode.util.spec.ts` (10) + `execucao-por-tela.integration.spec.ts` (modo por operação, canais por modo) |
| RN-TEL-010, 2ª parte — tarefa iniciada num canal não conclui no outro | `assertNoCrossChannelSwitch` | integração: coletor→tela negado; mesmo canal permitido; `CREATED` aceita qualquer |
| RN-TEL-011 [INVIOLÁVEL] — paridade | *nenhum arquivo novo* — ver §2 | toda a suíte existente das 8 operações |
| RN-TEL-012 item 3 — origem registrada | `putaway-task.service.ts` (mapa origem→canal), `stock-movement.service.ts` (`executionChannel`) | `transcricao.integration.spec.ts` (movimento de papel nasce `FORMULARIO`) |
| RN-TEL-012 item 4 — permissão própria | `assertCanExecute`, migration 0079 | integração: sem `TEL.EXECUCAO_TELA` a tela é negada, o coletor não |
| RD-TEL-004 — `execution_channel` em tarefas e movimentações | `infra/postgres/migrations/0079-doc17-execucao-por-tela.sql` | integração: `stampChannel`, default `COLETOR` em `stock_movement` |
| Configuração do modo (`TEL.MODO_EXECUCAO_CONFIGURAR`) | `execution-mode.controller.ts`, `setMode` | integração: modo inválido rejeitado; `setMode` idempotente |

## 2. Sobre RN-TEL-011 (paridade): por que não há arquivo novo

RN-TEL-011 exige que a execução por tela chame **exatamente os mesmos
serviços de domínio** do coletor. Ao levantar o terreno, as 8 operações do
catálogo RF-TEL-013 já tinham controller e serviço:

| Tela | Operação | Controller existente |
|---|---|---|
| T-P1 | Putaway | `recebimento/putaway/putaway.controller.ts` |
| T-P2 | Picking | `expedicao/picking/picking-task.controller.ts` |
| T-P3 | Conferência | `recebimento/checking/checking.controller.ts` |
| T-P4 | Contagem | `estoque/inventory/inventory-count.controller.ts` |
| T-P5 | Reposição/Transferência | `estoque/replenishment/...`, `estoque/transfer/...` |
| T-P6 | Packing | `expedicao/packing/package.controller.ts` |
| T-P7 | Pesagem | `expedicao/packing/package.controller.ts` |
| T-P8 | Carregamento | `expedicao/loading/loading.controller.ts` |

Ou seja: a paridade já era estrutural. Criar endpoints "de tela" seria
justamente o caminho paralelo que RN-TEL-011 **proíbe**. O que faltava era
a governança do canal — que é o que esta sessão entrega.

## 3. Defeito de raiz encontrado e corrigido: `app_parameter` sem chave única

Ao escrever o `setMode` (um upsert de parâmetro) descobri que
`wms.app_parameter` **nunca teve UNIQUE** sobre `(scope, name,
warehouse_id, client_id)` — que É a sua chave de resolução (DOC-01 §6 /
DOC-02 §5.7). Duas consequências reais, nenhuma delas visível até aqui:

1. **14 migrations** fazem `INSERT INTO wms.app_parameter ... ON CONFLICT DO
   NOTHING`. Sem constraint não existe conflito a detectar: essas cláusulas
   não protegem nada, e uma reexecução **insere duplicata em silêncio**.
2. Com linha duplicada, a resolução de parâmetro (`ORDER BY scope ... LIMIT 1`)
   passa a devolver uma das duas **arbitrariamente** — parâmetro de negócio
   decidido por sorte. Vale para todos os parâmetros do sistema, não só os
   do DOC-17.

Corrigido na migration 0079: dedup (mantendo a linha mais recente de cada
chave) seguido de `CREATE UNIQUE INDEX ... NULLS NOT DISTINCT`. O
`NULLS NOT DISTINCT` (PostgreSQL ≥ 15; DOC-00 §2.2 exige ≥ 16) é essencial:
sem ele as linhas `GLOBAL` — `warehouse_id` e `client_id` nulos, o caso mais
comum da tabela — escapariam da unicidade.

O teste de regressão é funcional, não estrutural: insere a mesma chave
GLOBAL duas vezes e exige `23505` na segunda.

## 4. Decisões de projeto

- **A trava de canal cruzado vale em QUALQUER modo**, não só em HIBRIDO. Em
  COLETOR/TELA puros o outro canal já cai antes; aplicar sempre fecha o
  buraco de o modo do armazém MUDAR no meio de uma tarefa em curso — que é
  exatamente quando a dupla contagem aconteceria.
- **A trava só morde depois de INICIADA**: em `CREATED`/`PENDING`/`OPEN` o
  canal gravado é só o default e qualquer um pode assumir. Travar antes
  impediria o primeiro atendimento da tarefa.
- **`FORMULARIO` passa pela porta de `TELA`** (RN-TEL-010 define `TELA` como
  "apenas telas **e formulários**"), mas para a trava de dupla contagem os
  dois são canais **distintos**: começar por tela e terminar no papel seriam
  dois registros do mesmo trabalho.
- **Padrão `COLETOR` em tudo** (parâmetro e coluna): aplicar esta migration
  não muda o comportamento de quem já operava (DOC-15), e parâmetro ausente
  ou corrompido não LIBERA canal novo por omissão — mesmo raciocínio de
  fail-safe da 10D.
- **`TEL.EXECUCAO_TELA` não vai para todos os papéis operacionais**:
  RN-TEL-012 item 4 diz "concedida deliberadamente".
- **Mapa origem→canal explícito** em `putaway-task.service.ts`: acrescentar
  uma origem nova obriga a decidir o canal, em vez de cair num default calado.

## 5. Saída real dos comandos

```
$ pnpm build
 Tasks:    5 successful, 5 total

$ pnpm test
@wms/backend:test:  Test Files 27 passed (27) | Tests 258 passed (258)
@wms/ui:test:       Test Files 3 passed (3)   | Tests 22 passed (22)
@wms/frontend:test: Test Files 7 passed (7)   | Tests 37 passed (37)

$ pnpm test:integration   (execução 1/2)
 Test Files 82 passed (82) | Tests 370 passed (370)

$ pnpm test:integration   (execução 2/2)
 Test Files 82 passed (82) | Tests 370 passed (370)

$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-backend-api Started   (... todos healthy)

$ curl localhost:3000/health/ready
{"status":"ok","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ psql -c "SELECT version FROM wms.schema_migration WHERE version=79"
 79

$ psql -c "SELECT indexname FROM pg_indexes WHERE indexname='uq_app_parameter_scope_name_target'"
 uq_app_parameter_scope_name_target     -- aplicado sobre a base de dev existente

$ curl localhost:3000/modo-execucao?tenant_id=x&warehouse_id=y
401   # rota protegida (não 404)
```

Backend: 248 → 258 unitários (+10 modo de execução). Integração: 358 → 370
(+12 execução por tela, +1 asserção de canal na transcrição, −1 realocada).

## 6. O que falta do DOC-17

**As 8 telas (T-P1..T-P8) — frontend.** É o único item remanescente do
documento inteiro. As operações e a governança de canal estão prontas no
backend; as telas consomem os endpoints que já existem, com densidade
desktop e o design system (`.claude/skills/wms-design-system/`).

Mesmo padrão de divisão já usado em COL-2A→COL-2B e 10A→10C: motor primeiro,
telas depois.

## 7. Lacunas e débitos

- `[DEBITO: 10E]` `execution_channel` está ligado de ponta a ponta apenas em
  **putaway** (único com hook real desde a 10B). As outras 7 operações têm a
  coluna e o mapa origem→canal prontos, mas seus serviços de domínio ainda
  não repassam o canal — cada um precisa aceitar a origem, como
  `executeTask` passou a aceitar.
- `[DEBITO: 10E]` `assertCanExecute` existe e está testado, mas ainda não é
  chamado pelas rotas de execução das 8 operações — ligá-lo é ato por rota
  e pertence à sessão das telas, quando houver chamador real de canal
  `TELA`. Hoje nenhuma rota executa em canal `TELA`, então não há regra
  sendo burlada; é preparação, não buraco.
- `[DEBITO: 10B]` (herdado) só putaway tem hook de tarefa real para
  formulário/transcrição.
- Débitos da 10D seguem abertos (fechamento de saldo remanescente de
  transcrição parcial; abertura automática de `TEL.TRANSCRICAO_DIVERGENTE`).
