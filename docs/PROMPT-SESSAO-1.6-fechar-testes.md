# SESSÃO 1.6: FECHAR OS TESTES DO DOC-01
> Modelo recomendado: ECONÔMICO (Haiku). Trabalho mecânico com causa já mapeada.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-01-arquitetura-infraestrutura.md` (apenas §6 e §7 são relevantes),
> último relatório de sessão. NÃO carregue outros documentos.

---

## MISSÃO
Fazer os 5 cenários Gherkin do DOC-01 §6 passarem contra os containers reais,
e remover do suite os testes que dependem de tabelas de negócio ainda inexistentes.

## REGRAS
- `[LACUNA]` = informação ausente da ESPECIFICAÇÃO. Dificuldade técnica usa
  `[DEBITO: descrição + sessão-alvo]`. Débito que bloqueia o Definition of Done
  NÃO pode ser adiado.
- Não refatore código que já passa nos testes.
- Não crie testes além dos cenários do DOC-01 §6.
- É PROIBIDO `.skip` silencioso e mock de PostgreSQL/Redis nos testes de integração.

## ENTREGÁVEIS

### 1. Classificar as 21 falhas
`docs/relatorios/ANALISE-falhas-testes.md`, uma linha por teste:
nome | erro exato | causa | classe (A/B/C)
- **A** = depende de tabela do DOC-01 (`event_outbox`, `app_parameter`,
  `sync_operation`, `edge_agent`, `rls_probe`) → BUG: migrations não aplicadas
  no setup de teste;
- **B** = depende de tabela de NEGÓCIO (DOC-02+) → teste escrito cedo demais;
- **C** = outra causa (fixture, conexão, asserção).

### 2. Corrigir classe A
Global setup dos testes de integração aplica TODAS as migrations do DOC-01 no
container antes da suíte (e limpa entre suítes). Estes testes devem passar agora.

### 3. Mover classe B
Remover do suite atual e listar em `docs/relatorios/testes-pendentes-DOC-02.md`
com o requisito correspondente, para reinserção na Sessão 2B.

### 4. Corrigir classe C
Correção direta.

### 5. ADR pendente
Registrar em `docs/adr/` a decisão do `set_config($1,$2,true)` para o contexto de
tenant (bind seguro em vez de interpolação — RNF-ARQ-010).

## DEFINITION OF DONE
```bash
docker compose up -d
pnpm test                    # unitários verdes
pnpm test:integration        # 5 cenários do DOC-01 §6 verdes, zero skip
curl localhost:3000/health/ready
```
Relatório final `docs/relatorios/SESSAO-1.6-relatorio.md` com a contagem
(passando/total) e a lista movida para o DOC-02.

## FORA DE ESCOPO
Workers outbox-publisher e realtime-fanout (Sessão 1.5), rate limiting,
qualquer tabela ou regra de negócio, PWA, drivers de periféricos.
