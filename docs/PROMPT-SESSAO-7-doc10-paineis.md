# SESSÃO 7: DOC-10 — PAINÉIS, DASHBOARDS E TEMPO REAL
> Modelo recomendado: MÉDIO (Sonnet). Primeira sessão com peso de FRONTEND.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-10-paineis-dashboards-tempo-real.md`,
> `docs/relatorios/SESSAO-6B-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Dar rosto ao sistema: Painel de Operações Pendentes, a tela do Fluxo
Operacional verde/vermelho, centro de alertas, chat operacional e os
dashboards com o catálogo fechado de 17 KPIs. Backend + frontend.

## REGRAS
- Cite o §/ID do DOC-10 ao definir CADA KPI, fórmula, tópico e comportamento.
  Não invente KPI nem altere fórmula: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **consultar tabelas transacionais quentes
  no dashboard** (RF-PAI-040); **comunicar estado apenas por cor**
  (RF-PAI-005 item 3); declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria em escritas; permissão
  por rota (RN-SEG-012); eventos via outbox; contrato único de leitura do
  fluxo criado na 6A — **consuma-o, não crie uma segunda leitura das etapas**;
  teste de contrato de permissões atualizado a cada tabela nova.
- Frontend: Next.js App Router (área `internal`), Tailwind + `@wms/ui`,
  ícones Lucide exclusivamente (RG-013). Sem biblioteca de componentes nova.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Backend — agregados e KPIs (§4.5)
Migrations `kpi_daily`, `kpi_event_applied`, `alert` + `alert_read`,
`chat_room` + `chat_message`, `user_board_preference` (RD-PAI-001..005).
**RN-PAI-041 [INVIOLÁVEL]** — os 17 KPIs com as fórmulas EXATAS da tabela.
**RN-PAI-042 [INVIOLÁVEL]** — worker de materialização consumindo eventos com
idempotência por `event_id` (`kpi_event_applied`); KPIs de snapshot (K-13,
K-16) pelo scheduler às 23:59 do fuso do armazém; **comando administrativo de
recontagem que reproduz os mesmos valores** a partir das fontes.
**Teste de regressão permanente (exemplo normativo K-06 OTIF):** 40 pedidos
concluídos, 32 sem corte, 30 destes no prazo → **75,0%** (pedido com corte não
entra no numerador ainda que no prazo). Valor imutável; aritmética decimal.

### 2. Backend — Painel de Operações (§4.1)
RF-PAI-001 (cartões de TODOS os Fluxos Operacionais abertos: recebimento,
pedido, reversa, transferência, inventário — os tipos ainda não implementados
simplesmente não aparecem, sem código morto), com número, tipo, cliente, etapa
atual e tempo nela, indicador de exceção pendente, atraso.
RBAC filtra cartões pelos clientes autorizados (RN-SEG-011).
RF-PAI-002 (filtros combináveis + ordenação padrão: atrasados primeiro, depois
maior tempo na etapa; preferências persistidas por usuário).
RN-PAI-004 (atraso por `PAI.SLA_ETAPA_MIN`, mapa etapa→minutos por armazém;
sem entrada = sem SLA). K-14 conta as entradas em atraso.

### 3. Backend — alertas e chat (§4.2, §4.4)
RF-PAI-010 (centro de alertas consolidando: exceções aguardando o usuário com
alçada, Edge Agent offline, estoque de segurança violado, lotes a vencer/
vencidos, cross-docking acima do tempo, transbordo pendente, cartões
atrasados, falhas de integração; severidade `INFO`/`WARN`/`CRIT`; marcação de
lido por usuário; navegação ao objeto de origem).
RF-PAI-030 (salas: armazém-turno e por operação, com RLS herdada na sala de
operação; menções `@usuario`; anexo de imagem no S3; mensagens imutáveis).
**RN-PAI-031 [INVIOLÁVEL]**: o chat NÃO aciona operação alguma — nenhuma
capacidade de concluir etapa, aprovar exceção ou movimentar estoque.

### 4. Frontend — tela do Fluxo Operacional (§4.1 RF-PAI-005) [O CORAÇÃO]
Trilha horizontal das etapas na ordem, cada uma com:
- `DONE` verde com ícone de check; `PENDING` vermelho; primeira pendente
  acionável em vermelho com realce e cursor de ação; pendentes seguintes
  esmaecidas/desabilitadas;
- **acessibilidade [INVIOLÁVEL]**: ícone + rótulo textual do estado além da
  cor (WCAG 2.1 AA, RG-013) — daltonismo é comum em operação de armazém;
- comportamento de clique conforme RN-EXP-011: acionável abre a tela da
  operação; posterior é **inerte com aviso** "conclua a etapa anterior";
  concluída abre em modo consulta;
- indicador de exceção bloqueante sobre a etapa, com acesso à exceção para
  quem tem alçada;
- timestamps e executante de cada etapa concluída (RG-003).

### 5. Frontend — painel, alertas, chat e dashboard
Painel de Operações com os cartões (RF-PAI-003: assinatura do tópico
`painel_operacoes`, atualização sem recarga em ≤ 2 s, **sem reordenar
bruscamente enquanto o usuário interage** — reposicionar só em re-render
explícito ou rolagem); centro de alertas com badge de não lidos; chat;
dashboard em 4 grupos (Recebimento, Expedição, Pátio & Portaria, Estoque) com
cartões de valor + comparativo de 7 dias, série temporal e ranking top-5
(RF-PAI-043), exportação CSV auditada.

### 6. Testes
Integração (containers reais): OTIF 75,0% (exemplo normativo); recomputação
determinística reproduzindo o mesmo valor; RBAC filtrando cartões; dashboard
consultando apenas `kpi_daily`/réplica (prove por inspeção do código ou
instrumentação); chat sem capacidade de operar; painel atualiza em ≤ 2 s após
evento (reuso do padrão e2e da 1.5).
Frontend: teste de componente da trilha de etapas cobrindo — estados visuais,
**etapa posterior inerte**, rótulo textual presente em cada estado, e
contraste AA.
+ Regressão: todas as suítes anteriores verdes (225+).

## DEFINITION OF DONE
```bash
docker compose up -d --build      # inclusive o container frontend
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
# frontend acessível e painel renderizando com dados do seed
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-7-relatorio.md` com
matriz requisito → arquivo → teste, lacunas, débitos, e nota sobre o estado do
container `frontend` (que não subia na Sessão 1.5 por conflito de porta).

## FORA DE ESCOPO
Dashboards editáveis/BI self-service, drill-down além dos rankings definidos,
exportação agendada por e-mail, KPIs financeiros (DOC-09), chat com clientes
externos, vídeo/áudio/reações/threads, push nativo do SO (DOC-10 §8).
Também fora: portal do cliente (§4.3 — fica para sessão própria com DOC-13),
telas de coletor (DOC-15).
