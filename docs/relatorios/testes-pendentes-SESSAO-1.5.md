# Testes Pendentes da Sessão 1.5 — STATUS: RESOLVIDO

**Data original**: 2026-08-15 (durante Sessão 1.6)
**Data de resolução**: 2026-08-15 (Sessão 1.5, retomada pós-reboot Docker)

---

## Histórico

Este documento originalmente descrevia um teste pendente ("Worker Consumes
Published Events from Outbox") que dependia da implementação do worker
`outbox-publisher`, ainda não escrito na época.

## Status atual

O worker `outbox-publisher.worker.impl.ts` foi implementado na Sessão 1.5 e
validado contra Postgres/Redis reais nesta retomada (2026-08-15). O
comportamento descrito neste documento está coberto, com margem, pelos
seguintes testes reais (todos PASS — ver
`docs/relatorios/SESSAO-1.5-relatorio.md` §3 para a saída completa):

- `apps/backend/src/__tests__/e2e-event-pipeline.integration.spec.ts` —
  publica evento na outbox, chama `OutboxPublisherWorkerImpl.pollBatch()` e
  `RealtimeFanoutWorkerImpl.pollStreams()` reais, confirma `published_at`
  marcado e um subscriber Redis real recebendo a mensagem em ≤ 2s.
- `apps/backend/src/workers/__tests__/outbox-publisher-concurrency.integration.spec.ts` —
  cobre especificamente o requisito de concorrência do prompt original (2
  réplicas do worker, 100 eventos, cada `event_id` publicado exatamente 1×).

Nenhuma ação adicional pendente. Este arquivo é mantido como registro
histórico; pode ser removido em uma sessão futura de limpeza de documentação.
