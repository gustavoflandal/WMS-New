# Relato consolidado — 2026-08-25
## DOC-17 (10C, 10B, 10D, 10E) e a auditoria REVISÃO-01

**Escopo deste documento**: o fio condutor de cinco entregas feitas em
sequência num mesmo dia. Não substitui os relatórios de sessão — cada um
tem a matriz requisito→arquivo→teste e a saída real dos comandos. O que
está aqui é o que **não cabe** em nenhum deles isoladamente: por que a
auditoria aconteceu no meio do caminho, o padrão comum entre os defeitos
encontrados, e o estado real do DOC-17 ao fim do dia.

| Sessão | Commit | Entrega |
|---|---|---|
| 10C | `955a74b` | Consumo do detalhe de etapa no frontend (DOC-17 §2) |
| 10B | `2f55383` | Formulário de Campo (§7) |
| **REVISÃO-01** | `84ec8d8` | **Auditoria documento × código e correção dos desvios** |
| 10D | `d8e9e90` | Transcrição (§8) |
| 10E | `210c8f6` | Execução por Tela — backend (§6) |

Migrations do bloco: `0075` a `0079`.

---

## 1. A auditoria não estava planejada — e mudou o resto do dia

A REVISÃO-01 nasceu de um pedido de revisão geral, não de um item de
roteiro. Ela encontrou **três regras globais `[INVIOLÁVEL]` violadas em
silêncio**, nenhuma marcada como `[LACUNA]` ou `[DEBITO]`:

- **RG-011** (chaves primárias = UUID v7): 98 DEFAULTs em
  `gen_random_uuid()` (v4) em 46 migrations. Havia até duas funções v7
  criadas no `init`, uma com o comentário literal *"RG-011: UUID v7 for
  primary keys"* — chamadas **zero** vezes, e nem conformes (não gravavam
  versão nem variante).
- **RG-015 item 3** (transbordo do Armazém Lógico): o tipo de exceção, a
  permissão e o alerta estavam cadastrados desde as migrations 0016/0044/
  0055 — e **nenhum código jamais abria a exceção**. Armazém lógico cheio
  deixava o putaway sem saída alguma: palete parado na doca, nada para
  ninguém aprovar.
- **RG-012** (i18n): nenhuma infraestrutura de tradução, nenhuma tabela de
  i18n, todo componente com string literal.

Mais um achado de governança: as **emendas que o DOC-17 §2 mandava aplicar**
a DOC-06 e DOC-10 nunca foram feitas — o DOC-17 era citado **0 vezes** em
DOC-00, DOC-06 e DOC-10. Como a 10C já havia implementado o comportamento
novo, o código passou a contrariar literalmente a RG-002 do DOC-00, que
vence por precedência (INSTRUÇÃO-IA-003). Havia inclusive um cenário Gherkin
no DOC-06 (*"nada deve abrir"*) afirmando o oposto do que o sistema fazia.

**Isso foi falha da própria 10C**, que é minha: o correto seria registrar
`[CONFLITO]` e emendar os documentos **antes** de escrever o código.

## 2. O padrão comum: terreno preparado, ciclo não fechado

Os três achados altos têm a mesma forma — **alguém preparou o terreno e
ninguém fechou o ciclo**:

| Achado | Terreno preparado | Ciclo não fechado |
|---|---|---|
| RG-011 | funções v7 criadas no `init`, com o requisito citado no comentário | nenhuma chamada; 98 PKs seguiram em v4 |
| RG-015.3 | exceção, permissão e alerta cadastrados | nenhum código abria a exceção |
| Emendas DOC-17 | o próprio DOC-17 listava as emendas a aplicar | nenhuma foi aplicada |
| `app_parameter` (achado na 10E) | `ON CONFLICT DO NOTHING` em 14 migrations | não existia a constraint que daria sentido à cláusula |

O denominador comum não é desleixo: é que **cada sessão auditou o próprio
módulo**, e essas são regras (e estruturas) **globais**. Nenhum dos quatro
apareceria numa revisão feita dentro do escopo de uma sessão.

Catálogo cadastrado sem produtor — o caso do transbordo e o do
`ON CONFLICT` — é pior que ausência: **parece pronto**.

**Consequência de método adotada**: incluir no Definition of Done uma
verificação objetiva das RG-\* que a sessão toca (grep, consulta ao catálogo
do banco), não só dos RF/RN do módulo. Registrado em
`SESSAO-REVISAO-01-relatorio.md` §5 e na memória do projeto.

## 3. Defeitos encontrados pelos próprios testes desta sessão

Três casos em que o teste pegou algo que teria ido para produção:

**3.1 `gen_random_bytes()` do pgcrypto (REVISÃO-01).** A primeira versão da
função `uuid_v7()` usava `gen_random_bytes()`, que é do **pgcrypto**. Em
banco sem a extensão, **todo INSERT do sistema falharia** — a coluna é
DEFAULT de praticamente toda PK. Trocado por `gen_random_uuid()` (built-in,
CSPRNG). Sem o teste de integração da própria migration, ia para produção.

**3.2 Fail-open na segregação de funções (10D).** O controle de RN-TEL-032
foi escrito como `if (required !== 'true') return;` — ou seja, parâmetro
`TEL.EXIGE_SEGREGACAO_TRANSCRICAO` ausente **desligava o controle em
silêncio**. Numa instalação nova, ainda não parametrizada, ele nasceria
desligado. A spec diz "padrão **true**", e o controle é antifraude: no
papel, quem anota e quem digita ser a mesma pessoa elimina a única
verificação independente que resta.

Os testes falharam porque o harness limpa `app_parameter` após as
migrations. A tentação era corrigir o *fixture*; a pergunta certa era **qual
deve ser o comportamento sem o parâmetro**. Era defeito de projeto.

**3.3 `wms.app_parameter` sem chave única (10E).** Descoberto ao escrever um
upsert de parâmetro: a tabela nunca teve UNIQUE sobre `(scope, name,
warehouse_id, client_id)`, que É sua chave de resolução. Logo, os
`ON CONFLICT DO NOTHING` de **14 migrations** não protegiam nada, e com
linha duplicada a resolução passava a devolver uma das duas
**arbitrariamente** — parâmetro de negócio decidido por sorte, em qualquer
módulo. Corrigido com dedup + índice único `NULLS NOT DISTINCT` (essencial:
sem ele as linhas `GLOBAL`, maioria da tabela, escapariam).

Há ainda um quarto, de natureza diferente, na 10B: `import { Response } from
'express'` sem `type` compilava e passava em todos os testes, mas **quebrava
o boot real no Docker**. Só o `docker compose up --build` do DoD pegou —
evidência de que aquele passo não é redundante com as suítes.

## 4. Uma decisão de projeto que se repetiu: paridade não se reimplementa

Duas sessões esbarraram na mesma regra, RN-TEL-011 (*"a execução por tela/
papel DEVE chamar exatamente os mesmos serviços de domínio"*), e a resposta
foi a mesma nas duas:

- **10D (Transcrição)**: cada linha transcrita chama
  `PutawayTaskService.executeTask()` — o método do coletor. Vieram de graça
  a dupla validação de leitura, o override com permissão e motivo, o crédito
  de saldo pelo serviço único de movimentação e a idempotência. A chave de
  idempotência é o `form_line_id` que a 10B já gerava na emissão, reusado
  como `operationId`: nenhum segundo mecanismo foi inventado.
- **10E (Execução por Tela)**: ao levantar o terreno, **as 8 operações do
  catálogo RF-TEL-013 já tinham controller e serviço de domínio únicos**,
  construídos para o coletor. Criar "endpoints de tela" seria exatamente o
  caminho paralelo que a regra proíbe. O que faltava era governança de
  **canal**, não operação — e foi só isso que a sessão entregou.

Vale como orientação para as próximas: antes de assumir que uma seção da
spec exige endpoints novos, verificar se o serviço de domínio já existe.

## 5. Estado do DOC-17 ao fim do dia

| Parte | Situação |
|---|---|
| §2 — separação DETALHE × EXECUÇÃO | ✅ backend (10A) + frontend (10C) + **emendas aplicadas** a DOC-00/06/10 (REVISÃO-01) |
| §5 — Detalhe de Etapa (RF-TEL-001/004) | ✅ 10A |
| §7 — Formulário de Campo | ✅ 10B |
| §8 — Transcrição | ✅ 10D |
| §6 — Execução por Tela (RN-TEL-010/011/012, `execution_channel`) | ✅ **backend** (10E) |
| §6 — as 8 telas T-P1..T-P8 | ⬜ **frontend — único item remanescente** |

**O DOC-17 não está fechado.** Falta a sessão 10F: as 8 telas desktop,
consumindo os endpoints que já existem, com o design system. A divisão
backend→telas segue o padrão que o projeto já usou em COL-2A→COL-2B e
10A→10C.

## 6. Números

Progressão de testes ao longo do bloco (saída real colada em cada relatório
de sessão):

| Sessão | Unitários (backend) | Integração |
|---|---|---|
| ponto de partida (pós-10A) | 215 | 330 |
| 10B | 232 | 337 |
| REVISÃO-01 | 238 | 348 |
| 10D | 248 | 358 |
| 10E | **258** | **370** |

Todas as sessões fecharam com `pnpm test:integration` em **2 execuções
consecutivas idênticas**, `docker compose up -d --build` saudável e
`/health/ready` em 200.

## 7. O que fica aberto

**Exigem sessão própria (não são correção, são funcionalidade ausente):**
- `[LACUNA: RG-012]` **i18n** — regra `[INVIOLÁVEL]` sem nenhuma
  infraestrutura; atinge ~60 componentes.
- `[LACUNA: RG-016]` **modos de operação** — `APP.MODO_OPERACAO` não existe
  no código. Regra `[INVIOLÁVEL]` estacionada no roteiro como "4 itens
  pequenos": **precisa de decisão** — implementar ou emendar o DOC-00
  rebaixando a regra. Manter regra inviolável em fila de conveniência é a
  mesma contradição que produziu os achados da §2.

**Débitos técnicos dos módulos entregues:** ver §7 de
`SESSAO-10E-relatorio.md`, §7 de `SESSAO-10D-relatorio.md` e §6 de
`SESSAO-10B-relatorio.md`. Os principais: `execution_channel` ligado de
ponta a ponta só em putaway; `assertCanExecute` pronto e testado mas ainda
sem chamador de canal `TELA` (pertence à 10F); retorno automático do
transbordo quando houver capacidade (RG-015 item 3, parte final).

## 8. Pendência não relacionada, registrada por transparência

Durante a 10E apareceu no working tree um **move de arquivo que não foi
feito por nenhuma sessão**: `CORRECAO-config-testes.md` saiu da raiz para
`docs/relatorios/` (conteúdo idêntico, move puro, verificado por hash).
Ficou **fora** do commit `210c8f6` para não misturar histórico, e segue
pendente:

```
 D CORRECAO-config-testes.md
?? docs/relatorios/CORRECAO-config-testes.md
```

Se foi tidy-up deliberado, basta commitar.
