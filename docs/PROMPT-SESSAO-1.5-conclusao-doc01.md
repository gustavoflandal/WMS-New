# PROMPT — SESSÃO 1.5: CONCLUSÃO DO DOC-01 (WORKERS + RATE LIMITING)
> Uso: cole no Claude Code na raiz do monorepo, com a Sessão 1 commitada.
> Contexto obrigatório: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-01-arquitetura-infraestrutura.md`,
> `docs/relatorios/SESSAO-1-relatorio.md` (leia as pendências declaradas).

---

## PAPEL E MISSÃO

Concluir as pendências declaradas da Sessão 1 para FECHAR o DOC-01 por completo:
worker `outbox-publisher`, worker `realtime-fanout`, rate limiting, e a auditoria
final de cobertura do documento. Nada de regra de negócio.

## REGRAS DE CONDUTA
As mesmas das sessões anteriores (DOC-00 §1.2): `[LACUNA]`/`[CONFLITO]` em
`docs/relatorios/SESSAO-1.5-lacunas.md`; IDs de requisito em comentário; cenários
Gherkin do DOC-01 §6 como testes ANTES da implementação; requisitos [INVIOLÁVEL]
vencem conveniências.

## ENTREGÁVEIS (na ordem)

### 1. Worker `outbox-publisher` — RNF-ARQ-031/032 [INVIOLÁVEL]
- Roda no processo `APP_ROLE=worker`; poll da `event_outbox` (lote de até 500,
  ordenado por `event_id`), `XADD events:{modulo}`, marca `published_at` na MESMA
  iteração; falha no XADD = não marca (retry natural no próximo poll).
- Concorrência segura entre réplicas do worker: claim por lock Redis (RNF-ARQ-021)
  OU `FOR UPDATE SKIP LOCKED` — escolha uma, justifique em ADR, e prove com teste
  de duas instâncias simultâneas sem publicação duplicada no stream
  (dedupe verificável por `event_id`).
- Métrica `outbox_lag_seconds` (agora com valor real) e `outbox_pending_total`;
  alerta Prometheus de lag > 30 s (RNF-ARQ-072) validado com regra testável.

### 2. Worker `realtime-fanout` — RNF-ARQ-033
- Consumer group nos streams `events:*` (helper já existente da Sessão 1), filtro
  dos eventos relevantes a tempo real, republicação em Pub/Sub
  `rt:{tenant_id}:{warehouse_id}:{topico}`.
- Mapeamento evento→tópico como catálogo tipado em `packages/contracts`
  (RF-ARQ-041) — mapeamento ausente NÃO derruba o worker: loga em nível warn com
  `event_type` e segue (eventos de módulos futuros ainda não mapeados são esperados).
- ACK somente após republicação; falha → redelivery/XAUTOCLAIM → DLQ após 5
  (RNF-ARQ-032), com teste cobrindo o caminho de DLQ.

### 3. Teste fim-a-fim do pipeline completo
Cenário e2e novo (obrigatório): transação grava evento na outbox → publisher →
stream → fanout → Pub/Sub → gateway WebSocket → cliente assinante recebe.
Medir a latência commit→cliente no teste e afirmar ≤ 2 s (RNF-ARQ-042/088) no
ambiente local. Repetir o cenário "Outbox garante evento após commit" agora
validando a entrega ao assinante quando o Redis retorna.

### 4. Rate limiting — RNF-ARQ-100 (parcial da Sessão 1)
- Por usuário e por IP, armazenado em Redis (janela deslizante ou token bucket —
  ADR): 60 req/min em rotas de autenticação; 1.200 req/min autenticado; resposta
  429 determinística com `Retry-After` e corpo problem+json (alinhado ao formato
  do DOC-13 RNF-INT-001).
- Aplicado como guard global com lista de isenção explícita (`/health/*`,
  `/metrics`); testes: estouro de limite em auth, estouro autenticado, e ausência
  de limite nos isentos.

### 5. Auditoria de fechamento do DOC-01
Percorrer TODOS os requisitos RNF/RF/RN/RD-ARQ do DOC-01 e produzir
`docs/relatorios/DOC-01-cobertura.md` com três colunas:
`ATENDIDO (arquivo, teste)` | `PARCIAL (o que falta, qual sessão futura)` |
`NÃO INICIADO (justificativa)`.
Itens legitimamente futuros já conhecidos: RN-ARQ-053 (lógica de sincronização
offline — sessão do PWA), RNF-ARQ-050..054 (PWA), autenticação real (DOC-12),
drivers do Edge Agent (DOC-11). QUALQUER outro item não coberto é pendência a
resolver NESTA sessão.

## DEFINITION OF DONE
```bash
pnpm test && pnpm test:e2e                      # inclui pipeline completo ≤ 2 s
docker compose up -d
# fumaça manual do pipeline:
#   inserir evento de teste via script scripts/emit-test-event.ts
#   observar entrega no cliente WS de exemplo em < 2 s
curl -s localhost:3000/metrics | grep -E "outbox_lag_seconds|outbox_pending_total"
```
Relatório `docs/relatorios/SESSAO-1.5-relatorio.md` + `DOC-01-cobertura.md`.
Critério de saída: DOC-01 sem pendências fora da lista de "legitimamente futuros".

## FORA DE ESCOPO
Tabelas/regras de negócio (DOC-02+), RBAC/JWT real (DOC-12), PWA offline,
drivers de periféricos, qualquer catálogo de eventos de negócio além do necessário
para os testes (usar `event_type` de teste `teste.evento_emitido` claramente
marcado e removível).
