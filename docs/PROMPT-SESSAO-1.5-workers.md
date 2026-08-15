# SESSÃO 1.5: WORKERS + RATE LIMITING + FIM DO fix-esm-imports
> Modelo recomendado: MÉDIO (Sonnet). Concorrência entre réplicas exige cuidado.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-01-arquitetura-infraestrutura.md`, `docs/relatorios/SESSAO-1.6-*`.
> NÃO carregue outros documentos.

---

## MISSÃO
Fechar o DOC-01 por completo: worker `outbox-publisher`, worker
`realtime-fanout`, rate limiting, e eliminar o script `fix-esm-imports.js`.
Nenhuma regra de negócio.

## REGRAS
- `[LACUNA]` = informação ausente da ESPECIFICAÇÃO; `[DEBITO: descrição +
  sessão-alvo]` = dificuldade técnica. Débito que bloqueia o Definition of Done
  NÃO pode ser adiado.
- É PROIBIDO: optional chaining ou fallback para esconder dependência não
  injetada; `USING(true)` em policy; `.skip` em teste; mock de Postgres/Redis
  em teste de integração; declarar ✅ sem saída de comando real.
- Cite o §/ID do documento ao definir schema, enum ou contrato.
- Não refatore código que já passa nos testes (exceto item 4).
- Commit ao final (o repositório já existe: github.com/gustavoflandal/WMS-New).

## ENTREGÁVEIS

### 1. Worker `outbox-publisher` — RNF-ARQ-031/032 [INVIOLÁVEL]
- Roda em `APP_ROLE=worker`. Poll da `event_outbox` (lote ≤ 500, ordem por
  `event_id`), `XADD events:{modulo}`, marca `published_at`. Falha no XADD =
  não marca (retry no próximo ciclo).
- Stream de destino: derive `{modulo}` do prefixo de `event_type`
  ("<modulo>.<fato_no_passado>", RNF-ARQ-030).
- Concorrência entre réplicas: `FOR UPDATE SKIP LOCKED` ou lock Redis
  (RNF-ARQ-021) — escolha uma, ADR obrigatório.
- **Teste**: duas instâncias do worker em paralelo, 100 eventos → cada
  `event_id` aparece exatamente 1× no stream.
- Métricas: `outbox_lag_seconds`, `outbox_pending_total` (RNF-ARQ-071).

### 2. Worker `realtime-fanout` — RNF-ARQ-033
- Consumer group nos streams `events:*`; republica em Pub/Sub
  `rt:{tenant_id}:{warehouse_id}:{topico}`.
- Mapa evento→tópico tipado em `packages/contracts` (RF-ARQ-041). Evento sem
  mapeamento: log warn e segue — NÃO derruba o worker (módulos futuros ainda
  não mapeados são esperados).
- ACK só após republicação; falha → XAUTOCLAIM 60s → DLQ após 5 (RNF-ARQ-032).
- **Teste**: caminho de DLQ coberto.

### 3. Rate limiting — RNF-ARQ-100
- Redis, por usuário e por IP: 60 req/min em rotas de auth; 1.200 req/min
  autenticado. Resposta 429 com `Retry-After` e corpo problem+json (RFC 9457,
  formato do DOC-13 RNF-INT-001).
- Guard global com isenção explícita de `/health/*` e `/metrics`.
- **Testes**: estouro em auth, estouro autenticado, isento sem limite.

### 4. Eliminar `scripts/fix-esm-imports.js` [DÍVIDA TÉCNICA]
O script reescreve 14 arquivos após cada build e polui a saída. Resolva na
configuração: `module: NodeNext` / `moduleResolution: NodeNext` no tsconfig do
backend e extensões `.js` nos imports relativos do FONTE (ou bundler, se
justificar em ADR). Remova o script e o passo `build:fix-imports` do
package.json. Critério: `pnpm build && docker compose up -d --build` funciona
sem o script.

### 5. Auditoria de fechamento do DOC-01
`docs/relatorios/DOC-01-cobertura.md`, três colunas:
ATENDIDO (arquivo, teste) | PARCIAL (o que falta, sessão-alvo) | NÃO INICIADO.
Legitimamente futuros: RN-ARQ-053 e RNF-ARQ-050..054 (PWA), auth real (DOC-12),
drivers do Edge Agent (DOC-11). Qualquer outro item aberto resolve-se AQUI.
Reinsira o teste de `docs/relatorios/testes-pendentes-SESSAO-1.5.md`.

## DEFINITION OF DONE
```bash
pnpm build                      # sem fix-esm-imports
pnpm test && pnpm test:integration   # todos verdes, zero skip
docker compose up -d --build && curl localhost:3000/health/ready
curl -s localhost:3000/metrics | grep outbox_lag_seconds
git commit && git push
```
Cole a saída REAL de cada comando no relatório. Relatório sem saída real é
rejeitado.

## FORA DE ESCOPO
Tabelas e regras de negócio (DOC-02+), RBAC/JWT real (DOC-12), PWA offline,
drivers de periféricos, qualquer endpoint de negócio.
