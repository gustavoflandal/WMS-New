# PROMPT — SESSÃO 1: ARQUITETURA E INFRAESTRUTURA (DOC-01)
> Uso: cole este prompt no Claude Code na raiz do monorepo criado na Sessão 0.
> Contexto obrigatório na sessão: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-01-arquitetura-infraestrutura.md` e `docs/relatorios/SESSAO-0-relatorio.md`.

---

## PAPEL E MISSÃO

Implementar a fundação técnica especificada no DOC-01 sobre o scaffold existente:
multi-tenancy por RLS, backbone de eventos com outbox transacional, gateway
WebSocket com fallback, cache e locks Redis, esqueleto do canal do Edge Agent,
observabilidade e as tabelas técnicas do DOC-01 §7. Regras de NEGÓCIO continuam
proibidas (vêm nas sessões dos módulos).

## REGRAS DE CONDUTA (obrigatórias — DOC-00 §1.2)

1. `[LACUNA]` e `[CONFLITO]` como na Sessão 0; relatório em
   `docs/relatorios/SESSAO-1-lacunas.md`.
2. Todo requisito implementado referencia o ID em comentário no ponto de
   implementação (`// RNF-ARQ-031`) E entra na matriz do relatório final
   (requisito → arquivos → testes).
3. Requisitos [INVIOLÁVEL] têm prioridade absoluta; se um deles conflitar com uma
   conveniência de implementação, o requisito vence e a limitação é reportada.
4. TDD orientado pela especificação: para cada cenário Gherkin do DOC-01 §6,
   escreva PRIMEIRO o teste automatizado correspondente (nomeie o teste com o
   título do cenário), depois implemente até passar.

## ENTREGÁVEIS (na ordem)

### 1. Multi-tenancy RLS — RNF-ARQ-010..013 [INVIOLÁVEL]
- Migration: função `set_tenant_context()`; template de política RLS padrão
  (RNF-ARQ-011) como função SQL reutilizável que as migrations do DOC-02 aplicarão.
- Backend `core/db`: wrapper de transação que OBRIGA `SET LOCAL app.tenant_ids` e
  `app.user_id` derivados do contexto autenticado antes de qualquer query;
  transação sem contexto lança erro em desenvolvimento e produção.
- Tabela de teste temporária `rls_probe` (removida em migration futura) para provar
  o isolamento no teste do cenário "RLS bloqueia acesso entre tenants".

### 2. Outbox transacional + Redis Streams — RNF-ARQ-030..033 [INVIOLÁVEL]
- Migration: `event_outbox` particionada mensal (RNF-ARQ-090) com as colunas do
  envelope (RNF-ARQ-030) + criação automática de partições pelo scheduler
  (job `partition-manager`, dia 20 — RNF-ARQ-090).
- `core/events`: API `publishInTx(tx, event)` (grava na outbox NA MESMA transação;
  publicar direto do fluxo HTTP é impossível por design — construtor privado).
- Worker `outbox-publisher`: poll da outbox → `XADD events:{modulo}` → marca
  publicado; métricas de lag.
- Consumo: helper de consumer group com `XREADGROUP`, ACK pós-efeito idempotente,
  `XAUTOCLAIM` 60 s, DLQ `events:dlq` após 5 falhas, `XTRIM MAXLEN ~ 1000000`
  (RNF-ARQ-032).
- Worker `realtime-fanout` (RNF-ARQ-033): streams → Pub/Sub
  `rt:{tenant}:{warehouse}:{topico}`.

### 3. Tempo real — RF-ARQ-040..043
- Gateway Socket.IO com adapter Redis; autenticação pelo token da API; validação de
  assinatura de canal com stub de autorização (`canSubscribe(user, channel)` —
  implementação real virá do DOC-12; stub nega por padrão e loga `[LACUNA]` se
  chamado sem provider).
- Tópicos padrão registrados (RF-ARQ-041) como catálogo tipado em
  `packages/contracts`.
- Recuperação de intervalo (RF-ARQ-043): último `event_id` por tópico, reenvio pela
  janela de 15 min do stream, comando `RESYNC` além dela.
- Endpoint SSE `/events/stream` e cliente frontend com a máquina de estados do
  DOC-01 §5.1 (CONECTADO → DEGRADADO_SSE → DEGRADADO_POLLING) + indicador visual
  de modo degradado.

### 4. Cache e locks — RNF-ARQ-020..021
- `core/cache`: cache-aside com chave `cache:{tenant}:{entidade}:{id}`, TTL 300 s,
  invalidação por delete via evento; LISTA DE BLOQUEIO em código impedindo cache de
  `stock_balance`/`fiscal_stock_balance` (tentativa lança erro — RNF-ARQ-020).
- `core/lock`: `SET NX PX` com token, liberação verificada, timeout 10 s
  (RNF-ARQ-021).

### 5. Canal do Edge Agent (esqueleto) — RNF-ARQ-060..061
- Endpoint WebSocket de dispositivo (token de `edge_agent`), heartbeat 15 s,
  estados de conexão, tabela `edge_agent` (RD-ARQ-003).
- Fila de jobs genérica com estados `PENDENTE..EXPIRADO` e validade (drivers reais
  são da sessão do DOC-11).

### 6. Observabilidade — RNF-ARQ-070..072
- OpenTelemetry (HTTP, pg, ioredis) com `trace_id/span_id` no logger; `/metrics`
  Prometheus com: latência por rota, lag da outbox, profundidade de streams/DLQ,
  conexões WebSocket; alertas como regras Prometheus em `/infra/prometheus/rules.yml`
  (RNF-ARQ-072).

### 7. Tabelas técnicas restantes — DOC-01 §7
Migrations de `sync_operation` (estrutura apenas; a lógica RN-ARQ-053 é de sessão
futura) e `app_parameter` com resolução de escopo
CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL testada.

### 8. Segurança de transporte — RNF-ARQ-100 (parcial)
Rate limiting (60/min auth, 1200/min autenticado, 429 determinístico), CORS
restrito, helmet; JWT/refresh REAL fica para a sessão do DOC-12 — nesta sessão um
provider de autenticação de desenvolvimento claramente marcado.

## TESTES OBRIGATÓRIOS (cenários do DOC-01 §6 — todos automatizados)
1. RLS bloqueia acesso entre tenants
2. Outbox garante evento após commit (Redis derrubado no teste)
3. Reenvio idempotente da sincronização (contra `sync_operation`)
4. Degradação de tempo real (WebSocket → SSE, indicador visível — teste de frontend)
5. Resolução de escopo de `app_parameter`
+ teste de carga smoke (script k6 em `/infra/k6`): 100 rps em `/health/ready`
  com P95 < 300 ms local, como baseline do RNF-ARQ-081.

## DEFINITION OF DONE
```bash
pnpm test                                   # inclui os cenários acima, verdes
docker compose up -d && pnpm test:e2e       # e2e de outbox/fanout/SSE verdes
curl localhost:3000/metrics | grep outbox_lag
```
Relatório final `docs/relatorios/SESSAO-1-relatorio.md` com: matriz
requisito → arquivo → teste (todos os RNF/RF/RN-ARQ do DOC-01), lacunas/conflitos,
e pendências explícitas deixadas para sessões futuras (auth real DOC-12, lógica de
sincronização offline, drivers do Edge Agent).

## FORA DE ESCOPO DESTA SESSÃO
Tabelas e regras de negócio (DOC-02+), RBAC real e auditoria (DOC-12), lógica de
resolução de conflitos offline (RN-ARQ-053 — apenas a estrutura), drivers de
periféricos (DOC-11), qualquer endpoint de negócio.
