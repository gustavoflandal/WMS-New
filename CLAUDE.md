# Padrões do repositório WMS-New

Regras descobertas por bug real (não por preferência de estilo). Cada uma
existe porque um bug real aconteceu sem ela — ver a sessão citada para o
caso concreto antes de relaxar a regra.

## Acesso a dados: RLS e `queryGlobal()`

`DatabaseService.queryGlobal()` só é seguro para tabelas **sem** Row-Level
Security (`warehouse`, `zone`, `location`, `product_species`, ...). Toda
tabela com RLS — inclusive linhas `scope = 'GLOBAL'` de `wms.app_parameter`,
que hoje têm RLS igual às demais — exige contexto de tenant
(`db.query(ctx, ...)` / `db.transaction(ctx, ...)`).

Chamar `queryGlobal()` numa tabela com RLS sem contexto de tenant **não
lança erro**: retorna 0 linhas em silêncio, indistinguível de "não há
dados". `queryGlobal()` agora detecta esse caso fora de produção (compara
com o mesmo SELECT via `wms_worker`/BYPASSRLS e lança erro descritivo se
houver divergência — ver `database.service.ts`), mas isso é uma rede de
segurança, não uma licença para usar `queryGlobal()` por padrão: se a
tabela tem RLS, use contexto de tenant desde o início.

Achado 3× com a mesma forma — Sessões 5A, 5B e 5C (`expiration.service.ts`,
`InventoryPlanningService.resolveRotativoDiaQty()`, e o teste de integração
de inventário liam `app_parameter`/`inventory_count`/`operational_exception`
via `queryGlobal()`). Detalhe completo em
`docs/relatorios/SESSAO-5C-relatorio.md` §5.2–§5.4. A causa raiz para
`app_parameter` GLOBAL foi corrigida na policy (migration `0053`), não nos
chamadores — prefira sempre corrigir a regra de acesso na origem a corrigir
cada chamador um por um.

## Testes: nunca comparar dois resultados possivelmente vazios

Uma asserção como `expect(resultadoA).toEqual(resultadoB)` passa
trivialmente quando os dois lados são `[]` — o teste "verde" não verificou
nada. Isso mascarou silenciosamente o bug de RLS acima num teste de
reprodutibilidade de sorteio (Sessão 5C: `queryGlobal()` retornava `[]` nos
dois lados da comparação, e `expect([]).toEqual([])` passava sem nunca ter
lido uma linha real).

**Regra**: antes de comparar dois resultados que podem legitimamente vir
vazios, afirme primeiro que pelo menos um deles é não-vazio (ex.:
`expect(resultadoA.length).toBeGreaterThan(0)`) — só depois compare A com
B. Vale para arrays, listas de linhas de banco, e qualquer coleção que uma
query mal formada possa reduzir a "nada" sem lançar erro.
