CLAUDE.md — WMS Enterprise 3PL

Instruções permanentes para qualquer sessão de trabalho neste repositório. Leia antes de qualquer alteração. Responda sempre em português do Brasil.

1. O que é este projeto

WMS (Warehouse Management System) para operador logístico 3PL: 50 armazéns, N empresas-clientes por armazém, 4.000 usuários concorrentes, 50 mil pedidos/ dia. Cobre portaria, pátio, docas, recebimento, armazenagem dirigida, estoque com políticas de giro, inventários, expedição, reversa, fiscal, faturamento de serviços, painéis em tempo real, periféricos e operação em coletores.

Stack congelada (DOC-00 §2.2 — é PROIBIDO introduzir alternativas): Next.js + Tailwind · NestJS (monolito modular, perfis api/worker/ scheduler) · PostgreSQL 16 com RLS · Redis (cache, Streams, Pub/Sub) · MinIO (S3) · WMS Edge Agent para periféricos.

bash
docker compose -f infra/docker-compose.yml up -d --build
pnpm build && pnpm test && pnpm test:integration
curl localhost:3000/health/ready
2. A especificação manda

docs/DOC-00 a DOC-15 são o contrato. O código serve a eles, não o contrário.

DOC-00 é o documento mestre: glossário canônico, 16 regras globais invioláveis (RG-001..RG-016), decisões arquiteturais e convenções. Em conflito, DOC-00 vence.
Cada sessão carrega apenas: DOC-00 + o documento do módulo + o último relatório relevante. Nunca os 16 documentos — contexto inflado é o maior custo do projeto.
Cite o §/ID do documento ao definir qualquer schema, enum, regra, KPI, permissão, exceção ou evento. Quem escreve de memória inventa; quem consulta acerta. Esse foi o padrão observado em todas as sessões.
Marcadores (usar corretamente)
Marcador	Significado
[LACUNA: descrição]	Informação ausente da especificação. Pare naquele ponto, siga o resto, reporte no relatório.
[DEBITO: descrição + sessão-alvo]	Dificuldade técnica adiada. Débito que bloqueia o Definition of Done não pode ser adiado.
[CONFLITO: DOC-X §n vs DOC-Y §m]	Divergência entre documentos. Precedência: DOC-00 > módulo específico.

É PROIBIDO usar [LACUNA] para escapar de dificuldade técnica.

3. Proibições absolutas

Estas nasceram de defeitos reais encontrados no projeto. Nenhuma é negociável.

Enfraquecer regra [INVIOLÁVEL] para fazer teste passar. Se o teste falha, o sistema está errado — não o teste.
Implementar prompt de sessão que mencione stack diferente de DOC-00 §2.2 sem pausa. Se prompt descrever React Native, Expo, app nativa, ou qualquer framework proibido, PARE antes de escrever código. Reporte ao Gustavo e aguarde validação. Sessão COL-1 começou com React Native (violava stack congelada) — implementar tecnologia errada e depois desfazer custa semanas. Sempre pausar e perguntar primeiro.
USING(true) em policy RLS, ou IS NULL OR que libera sem contexto. Deny por omissão sempre (RG-001).
Optional chaining (?.) ou fallback para esconder dependência não injetada. Configuração ausente = falha explícita no boot (fail-fast).
.skip em teste, ou mock de PostgreSQL/Redis em teste de integração.
Declarar ✅ sem saída de comando real colada no relatório.
Asserção comparando dois resultados possivelmente vazios sem antes afirmar que ambos são não-vazios (já produziu teste que passava testando nada).
Remover, mover ou renomear arquivo fora do escopo da sessão. Exclusão exige confirmação explícita do usuário.
Acesso direto do navegador a hardware — periférico só via Edge Agent (RG-008).
Comunicar estado apenas por cor na interface (RG-013).
localStorage/sessionStorage para dados de negócio — preferências vão para a API.
Estorno que marca etapa como desfeita sem desfazer os efeitos. Atomicidade ou nada (RN-EXP-070).
Reclassificar pendência como "não crítica" para encerrar sessão.
4. Padrões obrigatórios de implementação

Todos já estabelecidos e testados. Herde-os; não reinvente.

Identidade e auditoria

actor_user_id vem SEMPRE do JWT autenticado. Middleware global rejeita (não ignora) requisição que tente informá-lo no body/query.
Toda escrita gera auditoria com before e after e requirement_id (RG-003). audit_log é append-only: wms_app tem apenas INSERT e SELECT.

Acesso

Toda rota REST e handler WebSocket declara a permissão exigida. Rota sem declaração impede o boot (RN-SEG-012).
Permissão = papel × cliente × armazém, sem curinga (RN-SEG-011).
RLS: ENABLE + FORCE em toda tabela de tenant; policy com NULLIF(current_setting('app.tenant_ids', true), ''); pool de aplicação conecta como wms_app/wms_worker, nunca postgres (ADR-RLS-002).
set_config só dentro de transação explícita — fora dela, is_local é no-op e o contexto vaza pelo pool (ADR-RLS-001).
Leitura cross-tenant legítima (ex.: compatibilidade de espécies num endereço compartilhado) apenas por função SECURITY DEFINER de exposição mínima.

Serviços únicos (fechados por construção)

Saldo só muda pelo serviço único de movimentação (catálogo fechado de 16 tipos, RN-EST-001). Nenhum módulo escreve stock_balance direto.
Evento só é publicado pela outbox transacional, na mesma transação do negócio (RNF-ARQ-031).
Seleção de saldo para saída só pelo StockSelectionService (FEFO/FIFO/ LIFO/JIT + shelf life).
Fluxo Operacional: uma estrutura operation_flow/flow_step para todos os módulos, com um contrato único de leitura.

Máquinas de estado

Explícitas, com tabela de transições. Transição não prevista é rejeitada. Nunca setStatus() livre.

Idempotência

Toda operação externa ou offline tem chave de idempotência; reprocessar não duplica efeito (RG-009).
5. Testes
Cenários Gherkin dos documentos são a fonte — converta-os literalmente, não invente suítes próprias.
Exemplos normativos são regressão permanente. Valores esperados são imutáveis; se falharem, o algoritmo está errado. Os travados hoje: LPN 129000000000012346 · FEFO 80 de S1 + 70 de S2 · shelf life 25,2% excluído × 41,9% elegível · putaway E2 > E1 > E3 · pesagem faixa 12,103–12,597 · OTIF 75,0% · fila de pátio C=12, A=7, B=2 · conversão 10 CX12 = 120 UN.
Aritmética decimal, nunca ponto flutuante, em percentual, moeda e peso.
Testes de integração rodam contra containers reais, duas execuções consecutivas (a segunda pega o que a primeira esconde).
Migration que corrige dados é testada em banco descartável: aplicar do zero, inserir dados sujos propositais, rodar, verificar resultado exato, rodar de novo (idempotência).
Teste de contrato de permissões: toda tabela nova é declarada; grants de wms_app e wms_worker validados contra a lista (inclusive partições).
Testes independentes: nenhum herda estado de outro.
6. Definition of Done de qualquer sessão
bash
docker compose up -d --build          # api, worker, scheduler saudáveis
pnpm build && pnpm test && pnpm test:integration   # 2 execuções, zero skip
curl localhost:3000/health/ready      # 200
git commit && git push                # inclui o prompt da sessão

Relatório em docs/relatorios/SESSAO-<n>-relatorio.md contendo: matriz requisito → arquivo → teste, saída real dos comandos, lacunas e débitos, e as decisões tomadas com justificativa.

Nenhum número em relatório sem o comando que o produziu. Relatório sem saída real é rejeitado.

Commit inclui sempre o docs/PROMPT-SESSAO-*.md da própria sessão (rastreabilidade prompt → código).

7. Onde está a memória do projeto
Arquivo	Conteúdo
docs/DOC-00 a DOC-15	Especificação completa (fonte de verdade)
docs/relatorios/MARCO-estado-do-sistema.md	Estado consolidado e roteiro
docs/relatorios/SESSAO-*.md	O que cada sessão fez, decidiu e deixou aberto
docs/adr/	Decisões técnicas com justificativa
docs/PROMPT-SESSAO-*.md	Como cada parte foi gerada
.claude/skills/wms-design-system/	Sistema de design (toda interface)

Uma sessão nova não precisa de histórico de conversa: DOC-00 + documento do módulo + último relatório bastam.

8. Economia de contexto
Uma sessão por módulo; módulo grande vira A/B (como 4A/4B, 6A/6B, 7A/7B).
Máximo ~20–25 mensagens por sessão; ao fechar o Definition of Done, commite e abra sessão nova.
Modelo por natureza da tarefa: econômico para DDL e protocolos; médio para o grosso; premium apenas para algoritmo denso (putaway, seleção de saldo, fluxo operacional, fiscal).
Não troque de modelo no meio da sessão — o novo modelo reprocessa todo o contexto a preço cheio. Escolha ao abrir (claude --model <modelo>).
Erro de build, dependência ou configuração: leia a mensagem primeiro; se a causa for óbvia, entregue-a no prompt em vez de pagar rodadas de "diagnostique e tente".

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

## Prompts conflitantes com stack congelada (achado COL-1)

Prompt que menciona React Native, Expo, app nativa Android/iOS, ou qualquer
framework não listado em DOC-00 §2.2 é um **stack conflict**. A tentação é
"confiar no prompt e implementar mesmo assim" — já aconteceu em COL-1, onde o
primeiro prompt era React Native (100% violação da stack congelada). Implementar
tecnologia errada, testes, migrações e depois desfazer = **semanas de perda**.

**Padrão rigoroso**: Se prompt menciona tecnologia diferente de Next.js + Tailwind
(frontend) ou NestJS + PostgreSQL + Redis (backend), **PAUSE antes de escrever
qualquer código**. Verifique DOC-00 §2.2. Se há conflito, reporte ao Gustavo com
a citação exata do prompt e aguarde "OK, segue" ou "corrija para [tecnologia certa]"
antes de prosseguir. Uma pausa de 30 segundos aqui salva semanas depois.