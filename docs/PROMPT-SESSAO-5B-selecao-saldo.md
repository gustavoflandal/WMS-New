# SESSÃO 5B: SELEÇÃO DE SALDO — FEFO/FIFO/LIFO/JIT (DOC-05 §4.2)
> Modelo recomendado: **PREMIUM (Opus)**. Núcleo lógico do WMS: decide QUAL
> saldo sai. Erro aqui expede lote errado, vencido ou fora de contrato.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-5A-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar a Seleção de Saldo (RN-EST-010/011/012/013): universo de
candidatos, ordenação por política de giro com cadeia de desempate completa,
shelf life mínimo, e quebra de política com aprovação prévia. Substituir a
`StockSelectionPort` provisória da 5A sem alterar os consumidores.

## REGRAS
- Cite o §/ID do DOC-05 ao definir CADA regra de ordenação, filtro e
  mensagem. **Não invente critério nem ordem de desempate**: a cadeia está
  escrita na RN-EST-011. Divergência = `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **relaxar o universo de candidatos
  (RN-EST-010) ou o shelf life (RN-EST-012) para fazer teste passar**;
  declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria `before`+`after`;
  permissão por rota; eventos via outbox; leituras cross-tenant apenas por
  `SECURITY DEFINER` de exposição mínima.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Universo de candidatos (RN-EST-010) [INVIOLÁVEL]
Candidato é EXCLUSIVAMENTE: `qty_available > 0`, lote `RELEASED`, endereço
`ACTIVE` ou tipo `PICKING`, contenção RG-015 respeitada, e — para expedição a
cliente — shelf life aprovado (item 3). Parcelas `blocked`, `damaged`,
`quarantine`, `reserved`, `in_transit` NUNCA entram. Endereço com status
`INVENTORY` (congelado, RN-EST-061) é excluído.

### 2. Ordenação por política (RN-EST-011) [O NÚCLEO]
Implementar as 4 políticas com a cadeia de desempate EXATA da tabela:

| Política | Primária | Desempates, nesta ordem |
|---|---|---|
| FEFO | menor `expiration_date` | menor data de entrada → endereço `PICKING` antes de `STORAGE` → menor `location.code` |
| FIFO | menor data de entrada | menor `expiration_date` (se houver) → `PICKING` antes de `STORAGE` → menor `location.code` |
| LIFO | maior data de entrada | `PICKING` antes de `STORAGE` → menor `location.code` |
| JIT | zona `CROSS_DOCKING` primeiro | depois idêntico a FIFO |

- "Data de entrada do saldo" = timestamp do primeiro `stock_movement` de
  entrada daquele saldo. Defina a derivação de forma determinística e
  documente-a (é a base de FIFO/LIFO — não pode ser ambígua).
- Resolução da política: `product.giro_policy` → `client_warehouse_settings.
  default_giro_policy` (RG-006).
- Estruturas `LIFO_PHYSICAL` (DOC-02 RN-DAD-010): candidatos limitados ao
  palete acessível do canal — reuse a lógica da 4B, não reimplemente.
- Atendimento parcial: consome os candidatos em ordem até completar a
  quantidade; o resultado é uma LISTA de alocações (saldo, quantidade), não
  um único saldo.

**Teste de regressão permanente (exemplo normativo RN-EST-011):**
demanda 150 UN; S1 (lote L1, val. 2026-09-01, picking, 80), S2 (lote L2,
val. 2026-09-01, storage, 100), S3 (lote L3, val. 2026-10-15, picking, 200)
→ **80 de S1 + 70 de S2; S3 intocado**. Valor esperado imutável.

### 3. Shelf life mínimo (RN-EST-012) [INVIOLÁVEL]
Para demanda de expedição a cliente: excluir candidatos cuja vida útil
restante `(expiration_date − hoje) / shelf_life_days × 100` seja menor que o
`min_shelf_life_pct` resolvido (produto → cliente).

**Teste de regressão permanente (exemplo normativo):** `shelf_life_days = 365`,
`min_shelf_life_pct = 30`, hoje 2026-08-10; lote val. 2026-11-10 → 92 dias =
25,2% → **excluído**; lote val. 2027-01-10 → 153 dias = 41,9% → **elegível**.
Use data fixa no teste (não `now()`), e aritmética decimal — não ponto
flutuante — para o percentual.

### 4. Quebra de política (RN-EST-013)
Seleção fora da ordem (ex.: lote específico exigido pelo cliente) exige
`EST.QUEBRA_POLITICA_GIRO` **e** exceção `EST.QUEBRA_FEFO` **APROVADA ANTES**
de efetivar a reserva — nunca aprovação posterior. A movimentação resultante
grava `policy_break = true` e o motivo (colunas já existentes, RD-EST-005).
Quebra por shelf life (item 3) exige, além disso, anexo de autorização do
cliente na exceção.

### 5. Substituição da porta provisória
Trocar a implementação FIFO simples da 5A pela real, sem alterar a interface
`StockSelectionPort` nem os consumidores (kanban/reposição). Remover a marca
`[DEBITO: 5B substitui]`. Teste: a reposição kanban passa a escolher origem
pela política do produto (prove com produto FEFO).

### 6. Reserva a partir da seleção
Serviço que converte a lista de alocações em movimentações `RESERVA`
(catálogo RN-EST-001, serviço único da 5A), com detalhamento saldo→demanda
persistido para o consumo posterior no picking (DOC-06 usará). Concorrência:
duas demandas simultâneas do mesmo saldo não podem reservar a mesma
quantidade — serialize por `SELECT ... FOR UPDATE` no saldo candidato e prove
com teste de concorrência.

### 7. Testes de integração (contra containers reais)
Os 3 cenários do DOC-05 §6 desta parte (seleção FEFO com desempates; shelf
life excluindo lote; quebra de FEFO exigindo aprovação) + :
- FIFO, LIFO e JIT com seus desempates (um cenário cada, com valores fixos);
- endereço em `INVENTORY` não é candidato;
- saldo `blocked`/`quarantine`/`damaged` não é candidato;
- contenção RG-015 respeitada na seleção;
- `LIFO_PHYSICAL`: só o palete acessível é candidato;
- concorrência: 2 reservas paralelas de 60 UN sobre saldo de 100 → uma
  reserva 60, a outra recebe 40 ou falha determinística (nunca 60+60);
- reposição kanban usa a política real do produto.
+ Regressão: todas as suítes anteriores verdes (171+).

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-5B-relatorio.md` com
matriz requisito → arquivo → teste, a derivação escolhida para "data de
entrada do saldo", lacunas e débitos.

## FORA DE ESCOPO
Inventários (§4.7 — Sessão 5C), pedidos/picking/packing (DOC-06), alocação
FISCAL por nota de armazenagem (DOC-08 — a seleção aqui é FÍSICA), telas de
coletor (DOC-15), e tudo do DOC-05 §8.
