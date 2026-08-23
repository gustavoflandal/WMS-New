# SESSÃO 7A: DOC-10 BACKEND — KPIs, ALERTAS E CHAT
> Modelo recomendado: MÉDIO (Sonnet).
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-10-paineis-dashboards-tempo-real.md`,
> `docs/relatorios/SESSAO-7-relatorio.md` (checkpoint parcial).
> NÃO carregue outros documentos.

---

## MISSÃO
Concluir o BACKEND do DOC-10: worker de materialização de KPIs, endpoints de
dashboard, centro de alertas e chat operacional. O frontend é a 7B.

## ESTADO HERDADO (checkpoint da Sessão 7)
Já prontos e testados: migrations (catálogo `PAI.*`, `kpi_daily`,
`kpi_event_applied`, `alert`, `alert_read`, `chat_room`, `chat_message`,
`user_board_preference`); ponte Redis→Socket.IO corrigida (eventos agora
chegam ao cliente); `flow_step.started_at` populado; utilitários puros das
fórmulas de KPI com o OTIF normativo travado; Painel de Operações backend
(listagem filtrada por RBAC, SLA/atraso, filtros, preferências).
**Não refaça nada disso.** Comece verificando com `pnpm test:integration` que
o herdado está verde em 2 execuções consecutivas.

## REGRAS
- Cite o §/ID do DOC-10 ao definir CADA KPI, fórmula, severidade e tópico.
  Não invente KPI nem altere fórmula: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **consultar tabelas transacionais quentes
  no dashboard** (RF-PAI-040); declarar ✅ sem saída de comando real;
  **asserção comparando resultados possivelmente vazios sem antes afirmar que
  são não-vazios**.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria em escritas; permissão
  por rota; eventos via outbox; teste de contrato de permissões atualizado a
  cada tabela nova.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Worker de materialização de KPIs (RN-PAI-042) [INVIOLÁVEL]
Consome os eventos de domínio e mantém `kpi_daily` (dia × armazém × cliente ×
KPI) por incrementos **idempotentes** (chave `event_id` em
`kpi_event_applied`, RG-009). KPIs de snapshot (K-13 ocupação, K-16 lotes a
vencer) pelo scheduler às **23:59 do fuso do armazém** (não UTC).
**Comando administrativo de recontagem** de um dia, que DEVE reproduzir
exatamente os mesmos valores a partir das fontes.

### 2. Os 17 KPIs (RN-PAI-041) [fórmulas normativas]
Implementar todos com as fórmulas EXATAS da tabela, ligando cada um à sua
origem de evento. Os KPIs cujos módulos ainda não existem (nenhum hoje —
todos os 17 têm origem em DOC-03/04/05/06/10 já implementados) devem
funcionar; se algum depender de dado inexistente, `[LACUNA: ...]` explícito,
nunca fórmula adaptada.
**Regressão permanente já existente:** OTIF K-06 = 75,0% (40 concluídos, 32
sem corte, 30 no prazo). Denominador é 40, não 32. Aritmética decimal.

### 3. Endpoints de dashboard (RF-PAI-040, RF-PAI-043)
Quatro grupos (Recebimento, Expedição, Pátio & Portaria, Estoque); filtros de
período (dia/semana/mês, padrão hoje) e cliente (apenas autorizados).
Retorno por KPI: valor do período, comparativo com a média dos 7 dias
anteriores (para a seta de tendência), série temporal e ranking top-5.
Exportação CSV **auditada** (RN-SEG-032).
**Fonte de dados: exclusivamente `kpi_daily`** — nenhuma consulta a tabela
transacional. Prove isso no teste (inspeção do código ou instrumentação de
query).

### 4. Centro de alertas (RF-PAI-010)
Consolidar no `alert`: exceções aguardando o usuário **com alçada**, Edge
Agent offline, estoque de segurança violado, lotes a vencer/vencidos,
cross-docking acima do tempo, transbordo de armazém lógico pendente, cartões
atrasados, falhas de integração. Severidade `INFO`/`WARN`/`CRIT`; marcação de
lido por usuário (`alert_read`); referência ao objeto de origem para
navegação; resolução automática por evento (§5.2) — ex.: Edge Agent reconecta
resolve o alerta. Publicação no tópico `alertas`.

### 5. Chat operacional (RF-PAI-030)
Salas: uma por armazém-turno (persistente) e sob demanda por Fluxo Operacional
(herda `tenant_id` da operação, com RLS). Mensagens ≤ 2.000 chars, imutáveis,
anexo de imagem no S3, menções `@usuario` notificando no tópico `chat:{sala}`.
Retenção de 12 meses (RN-PAI-031).
**RN-PAI-031 [INVIOLÁVEL]**: nenhuma capacidade de acionar operação a partir
do chat — sem concluir etapa, aprovar exceção ou movimentar estoque. Prove por
teste que essas capacidades não existem na superfície da sala.

### 6. Testes de integração (containers reais)
- OTIF 75,0% (regressão existente, mantenha);
- **recomputação determinística**: `kpi_daily` de um dia, recontagem
  administrativa reproduz valores idênticos;
- idempotência: reprocessar o mesmo `event_id` não altera o agregado;
- snapshot no fuso do armazém (armazém com timezone ≠ UTC fecha às 23:59
  local);
- dashboard consulta apenas `kpi_daily`;
- alerta de estoque de segurança criado no cruzamento do limiar e resolvido
  quando o saldo volta;
- chat: sala de operação isolada por tenant; mensagem imutável; nenhuma
  capacidade operacional exposta.
+ Regressão: todas as suítes anteriores verdes (246+), 2 execuções.

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-7A-relatorio.md` com
matriz requisito → arquivo → teste, lacunas e débitos.

## FORA DE ESCOPO
**Todo o frontend — Sessão 7B** (trilha de etapas, painel visual, telas de
alertas/chat/dashboard). Portal do cliente (§4.3), telas de coletor (DOC-15),
KPIs financeiros (DOC-09), e tudo do DOC-10 §8.
