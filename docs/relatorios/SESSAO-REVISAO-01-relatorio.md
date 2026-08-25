# Sessão REVISÃO-01 — Auditoria documento × código e correção dos desvios

**Data**: 2026-08-25
**Origem**: pedido de revisão geral do projeto ("compare documentos com tudo o
que já está pronto... procure por erros de lógica ou mau entendimento"),
seguido de autorização para corrigir.
**Escopo**: confronto do DOC-00 (contrato-mestre) e documentos de módulo
contra o código real, e correção dos desvios encontrados.

---

## 1. O que a auditoria confirmou como CORRETO

Verificado com comando real, não por leitura:

| Regra | Situação |
|---|---|
| RG-001 (isolamento) | Nenhum `USING(true)`; toda tabela com `ENABLE` tem `FORCE`; deny por omissão. Guarda de runtime no `queryGlobal()` ativa |
| RG-004 (saldo nunca negativo) | Garantido no **banco**: `CHECK (qty_* >= 0)` nas 6 parcelas de `stock_balance` — não depende do código |
| RG-002 (sem salto) | `FLOW_STEP_ORDER_VIOLATION` no service, não na interface |
| RG-006 (giro) | Quebra exige permissão **+** exceção APROVADA antes de qualquer efeito |
| RG-014 (estoque fiscal) | Chave de `fiscal_stock_balance` idêntica à da regra; exemplo normativo do DOC-00 (notas 1000234/2356899/3216544) coberto por teste |
| Exemplos normativos | Os 8 do CLAUDE.md presentes em teste |
| Disciplina de teste | Zero `.skip`/`.only`; auditoria de rota derruba o boot (RN-SEG-012) |

## 2. Desvios encontrados e corrigidos

### 2.1 RG-011 — UUID v7 nunca foi implementado `[ALTO]`

**Achado**: DOC-00 RG-011 diz "Chaves primárias: UUID v7". A realidade eram
**98 DEFAULTs `gen_random_uuid()` (v4) em 46 migrations**. O mais revelador:
`infra/postgres/init/02-extensions.sql` criava DUAS funções v7, uma com o
comentário literal `-- RG-011: UUID v7 for primary keys` — e nenhuma foi
chamada uma única vez. Alguém leu a regra, preparou o terreno, e o projeto
inteiro seguiu em v4. Nunca marcado como `[LACUNA]` nem `[DEBITO]`.

Pior: a `uuid_v7()` do init não gravava os nibbles de versão nem os bits de
variante — produzia um UUID que ordena por tempo e **mente sobre a própria
versão**.

**Por que importa nesta escala** (DOC-00 §2.3: 50 mil pedidos/dia, tabelas
particionadas): v4 é aleatório e espalha cada INSERT por uma página distinta
do B-tree da PK (page splits, índice inchado); v7 tem prefixo temporal e
mantém os inserts vizinhos.

**Correção** (migration `0077`):
- `wms.uuid_v7()` conforme RFC 9562 §5.7, com versão e variante corretas;
- troca do DEFAULT em **todas** as colunas por varredura do catálogo (não
  lista fixa de 98 — pega também o que escapou da revisão);
- `public.uuid_v7()` e `public.gen_ulid()` (as não-conformes, sem chamador)
  removidas para não restarem implementações concorrentes;
- lado da aplicação: novo `core/identifiers/uuid-v7.util.ts` como fonte
  única, aplicado onde a aplicação gera PK explícita —
  `event_outbox.event_id` (PK sem DEFAULT, tabela de maior volume de escrita
  do sistema), `client.service.ts` e `inbound-order.service.ts`.
  `correlation_id`/`trace_id` seguem v4: não são chave.

Linhas já gravadas permanecem com os v4 antigos — UUID continua único e
válido; reescrever PK histórica com todas as FKs teria risco desproporcional
ao ganho. A partir daqui, todo ID novo nasce v7.

**Bug real pego pelo próprio teste desta correção**: a primeira versão da
função usava `gen_random_bytes()`, que é do **pgcrypto**. Em banco sem a
extensão, **todo INSERT do sistema falharia**. Trocado por
`gen_random_uuid()` (built-in do PostgreSQL ≥13, CSPRNG) como fonte de
aleatoriedade. Sem o teste de integração, isso teria ido para produção.

### 2.2 Emendas do DOC-17 nunca aplicadas — código contrariava o DOC-00 `[ALTO]`

**Achado**: DOC-17 §2 mandava explicitamente emendar DOC-06 RN-EXP-011 item 3
e DOC-10 RF-PAI-005 item 4. Nenhuma foi feita — DOC-17 era citado **0 vezes**
em DOC-00, DOC-06 e DOC-10. A Sessão 10C implementou o comportamento novo no
código, deixando três documentos dizendo o contrário do sistema, **incluindo
o DOC-00, que por regra própria (INSTRUÇÃO-IA-003) vence todos**. Havia
inclusive um cenário Gherkin no DOC-06 (`"nada deve abrir"`) contradizendo o
sistema — e o CLAUDE.md trata Gherkin como fonte dos testes.

Falha de governança da própria Sessão 10C: o correto seria registrar
`[CONFLITO]` e emendar ANTES de escrever o código.

**Correção**:
- **DOC-00 → v2.0.0** (MAJOR, conforme §9.1: alteração de requisito
  existente): RG-002 passa a conter a separação DETALHE × EXECUÇÃO com a
  tabela de quem pode o quê, e declara que a guarda de ordem vive no serviço,
  sendo PROIBIDO usar a interface como guarda;
- **DOC-06 → v2.0.0**: RN-EXP-011 item 3 reescrito + cenário Gherkin de §6
  atualizado;
- **DOC-10 → v2.0.0**: RF-PAI-005 itens 2 e 4 reescritos, com proibição
  explícita de `aria-disabled`/`tabindex="-1"` nas etapas posteriores;
- DOC-17 §2 marca as emendas como aplicadas, incluindo a do DOC-00 que a
  lista original nem previa (era a mais importante);
- DOC-00 §5.1 passa a indexar DOC-14 a DOC-17, que existiam sem registro no
  mapa de módulos.

O código da 10C não mudou — ele já estava conforme o DOC-17; o que estava
errado era o registro.

### 2.3 RG-015 item 3 (transbordo) — regra INVIOLÁVEL com beco sem saída `[ALTO]`

**Achado**: o tipo de exceção `EST.TRANSBORDO_ARMAZEM_LOGICO` (migration
0044), a permissão `EST.LOGICAL_WAREHOUSE_OVERFLOW` (0016) e o alerta
`TRANSBORDO_PENDENTE` (0055) existiam — e **nenhum código jamais abria a
exceção**. `putaway-filters.util.ts` simplesmente reprovava o endereço, com
um `[DÉBITO]` no comentário.

Consequência operacional: armazém lógico do cliente cheio ⇒ putaway falha e
**não há caminho nenhum** — nenhuma exceção para alguém aprovar, palete
parado na doca. Catálogo cadastrado sem produtor é pior que ausência, porque
parece pronto. O CLAUDE.md listava isso como "verificar se foi fechado na 5A";
nunca foi.

**Correção**:
- `putaway-filters.util.ts`: novo `allowLogicalWarehouseOverflow` suspende
  **apenas** o item 1 (endereço fora do armazém lógico do próprio cliente).
  O item 2 (armazém lógico de OUTRO cliente) continua reprovando sempre —
  "não admite override por nenhum papel";
- `putaway-engine.service.ts`: detecta o transbordo com precisão —
  `logicalWarehouseOverflow` só é `true` quando há endereço aprovável FORA e
  nenhum DENTRO. Se não há endereço em lugar nenhum, é armazém cheio, não
  transbordo (e transbordo não resolveria);
- `putaway-task.service.ts`: sem endereço dentro, **abre a exceção** e
  devolve `LOGICAL_WAREHOUSE_OVERFLOW` com o `exception_id`; reenvio com
  `overflow_exception_id` APROVADO aloca fora e marca a tarefa como
  transbordo. Autorização validada ANTES de qualquer efeito (mesmo padrão da
  RN-EST-013). Reenvio antes da aprovação não empilha exceções duplicadas;
- migration `0076`: `putaway_task.is_overflow` + `overflow_exception_id`, com
  CHECK garantindo que **não existe transbordo sem a exceção que o
  autorizou** — a marca não pode ser forjada;
- auditoria: transbordo entra como `OVERRIDE` com `requirement_id =
  'DOC-00 RG-015 item 3'` e o motivo aprovado (RG-003).

### 2.4 `origin = PAPEL` inexistente `[PREVENTIVO]`

DOC-17 RN-TEL-012 item 3 exige `origin = PAPEL` para movimentação vinda de
transcrição de Formulário de Campo, mas o CHECK de `audit_log.origin` não
admitia o valor — a próxima sessão (Transcrição, §8) bateria nisso. Alargado
na migration `0076`. É enum canônico (DOC-00 §4.8), não escolha livre do
implementador.

### 2.5 Inconsistências editoriais do DOC-00 `[BAIXO]`

§8 dizia "toda linha N01–N26" e §9.2 "N01–N28", enquanto a tabela ia até N29;
§1.1/§1.3/§7 falavam em "DOC-01 a DOC-13" com 17 documentos existindo.
Corrigidos.

## 3. Saída real dos comandos

```
$ pnpm build
 Tasks:    5 successful, 5 total

$ pnpm test
@wms/backend:test:  Test Files 25 passed (25) | Tests 238 passed (238)
@wms/ui:test:       Test Files 3 passed (3)   | Tests 22 passed (22)
@wms/frontend:test: Test Files 7 passed (7)   | Tests 37 passed (37)

$ pnpm test:integration   (execução 1/2)
 Test Files 80 passed (80) | Tests 348 passed (348)

$ pnpm test:integration   (execução 2/2)
 Test Files 80 passed (80) | Tests 348 passed (348)

$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-backend-api Started   (... todos healthy)

$ curl localhost:3000/health/ready
{"status":"ok","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ psql -c "SELECT version FROM wms.schema_migration WHERE version IN (76,77)"
 76 | Revisao: RG-015 item 3 (marca de transbordo em putaway_task) ...
 77 | DOC-00 RG-011: uuid_v7() conforme (RFC 9562) e troca do DEFAULT ...

$ psql -c "SELECT count(*) FROM information_schema.columns
           WHERE table_schema='wms' AND column_default LIKE '%gen_random_uuid%'"
 0     -- nenhuma coluna restou em v4
```

Backend: 232 → 238 unitários (+6 uuid v7). Integração: 337 → 348
(+5 defaults uuid v7, +6 transbordo).

## 4. NÃO corrigido nesta sessão (deliberado)

Dois achados da revisão são **funcionalidade nova, não correção** — fazê-los
às pressas junto de uma mudança de PK seria exatamente o risco de qualidade
que se pediu para evitar:

- **RG-012 (i18n) `[MÉDIO]`** — não existe infraestrutura de i18n no
  frontend nem tabela de tradução no banco; todo componente tem string
  literal pt-BR. A regra pede "arquitetura i18n preparada, sem strings
  literais em componentes", e REG-GLO-004 `[INVIOLÁVEL]` pede a tabela de
  i18n. Retrofit atinge ~60 componentes: **sessão própria**.
- **RG-016 (modos de operação) `[MÉDIO]`** — `APP.MODO_OPERACAO` não existe
  (0 ocorrências). Está no roteiro como "4 itens pequenos", mas é
  `[INVIOLÁVEL]`: precisa de decisão — implementar ou rebaixar a regra no
  DOC-00.

Débitos remanescentes do transbordo:
- `[DEBITO: REVISÃO-01]` "retorno obrigatório sugerido pelo sistema assim que
  houver capacidade" (parte final da RG-015 item 3) não implementado — o
  alerta `TRANSBORDO_PENDENTE` já existe no catálogo (DOC-10 RF-PAI-010) mas
  ninguém o emite. É um job de scheduler, mesma natureza do que já existe
  para vencimento de lote. O beco sem saída (o problema grave) está fechado;
  falta a sugestão de retorno.
- Transbordo implementado para **putaway**; transferência (RN-EST-052)
  obedece RG-015 no destino mas não abre transbordo — mesmo padrão de débito.

## 5. Lição de método

Os três achados altos têm a mesma forma: **alguém preparou o terreno e
ninguém fechou o ciclo** — funções v7 criadas e nunca usadas, exceção de
transbordo cadastrada e nunca aberta, emendas mandadas pelo DOC-17 e nunca
aplicadas. Nenhum apareceu em relatório de sessão porque cada sessão olhou o
próprio módulo, e estas são regras **globais**.

Sugestão para as próximas sessões: incluir no DoD uma checagem das RG-* que a
sessão toca, não só dos RF/RN do módulo.
