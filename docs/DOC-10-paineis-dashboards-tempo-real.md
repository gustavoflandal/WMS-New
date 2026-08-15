# DOC-10 — PAINÉIS, DASHBOARDS E TEMPO REAL
## Especificação de Requisitos do Sistema WMS Enterprise 3PL

| Metadado | Valor |
|---|---|
| Código do documento | DOC-10 |
| Versão | 1.0.0 |
| Status | APROVADO PARA USO |
| Data | 2026-08-10 |
| Depende de | DOC-00 v1.2.0, DOC-01, DOC-03, DOC-04, DOC-05, DOC-06, DOC-12 |
| Módulo (prefixo de requisitos) | PAI |

---

## 1. ESCOPO E OBJETIVO

Este documento especifica: o **Painel de Operações Pendentes** (visão consolidada de todos os Fluxos Operacionais com a tela de fluxo verde/vermelho), o centro de alertas, o chat operacional, o rastreamento de pedidos no portal do cliente e os **dashboards de performance diária** com o catálogo fechado de KPIs e fórmulas.

**Este documento resolve:** LAC-004 (tabela de KPIs e fórmulas).
**Fronteiras:** o comportamento normativo do fluxo (o que é clicável, ordem, bloqueios) é a RN-EXP-011 — aqui se especifica a APRESENTAÇÃO e a consolidação. A infraestrutura de tempo real é do DOC-01 (§4.5). KPIs de faturamento são do DOC-09.

---

## 2. DEPENDÊNCIAS E TERMOS

| Termo | Identificador técnico | Definição única |
|---|---|---|
| Painel de Operações | `operations_board` | Tela consolidada das operações com Fluxo Operacional aberto, por armazém. |
| Cartão de Operação | `operation_card` | Item do painel representando um Fluxo Operacional (pedido, recebimento, reversa, transferência, inventário). |
| Agregado Diário | `kpi_daily` | Valor pré-computado de KPI por dia × armazém × cliente. |
| Sala de Chat | `chat_room` | Canal persistente de mensagens: por armazém-turno ou por Fluxo Operacional. |

---

## 3. ATORES E PERMISSÕES ENVOLVIDAS

| Ator | Interação |
|---|---|
| Todos os usuários internos | Painel de Operações do(s) armazém(ns) e clientes autorizados (RBAC filtra os cartões) |
| Gestor / Líder | Dashboards completos, centro de alertas |
| Cliente (portal) | Rastreamento dos próprios pedidos/recebimentos; dashboard restrito ao próprio estoque |

**Permissões:** `PAI.PAINEL_OPERACOES` (WAREHOUSE), `PAI.DASHBOARD` (WAREHOUSE), `PAI.DASHBOARD_CLIENTE` (CLIENT_WAREHOUSE, portal), `PAI.CHAT` (WAREHOUSE). Sem exceções próprias neste módulo.

---

## 4. REQUISITOS

### 4.1 Painel de Operações Pendentes

**RF-PAI-001 — Conteúdo do painel**
O painel DEVE listar como Cartões de Operação todos os Fluxos Operacionais NÃO concluídos do armazém selecionado, dos tipos: Ordem de Recebimento (DOC-04), Pedido (DOC-06), Ordem de Devolução/Reversa (DOC-07), Transferência inter-armazém (DOC-05), Inventário (DOC-05). Cada cartão exibe: número do documento, tipo, cliente, etapa atual (nome + há quanto tempo), indicador de exceção pendente (quando houver), prioridade/atraso (RN-PAI-004). O RBAC restringe os cartões aos clientes autorizados do usuário (RN-SEG-011).

**RF-PAI-002 — Filtros e ordenação**
Filtros combináveis: tipo, cliente, etapa atual, com exceção pendente, atrasados, período de criação, texto (número/destinatário). Ordenação padrão: atrasados primeiro, depois maior tempo na etapa atual. Preferências de filtro persistem por usuário.

**RF-PAI-003 — Atualização em tempo real**
O painel assina o tópico `painel_operacoes` (RF-ARQ-041). QUANDO evento `*.etapa_concluida`, `*.concluido`, criação de operação ou decisão de exceção ocorrer, o cartão afetado DEVE atualizar sem recarga em ≤ 2 s P95 (RNF-ARQ-088), com transição visual sutil (sem reordenar bruscamente a lista enquanto o usuário interage; novo posicionamento aplicado em re-render explícito ou rolagem).

**RN-PAI-004 — Atraso do cartão**
Cartão é ATRASADO quando o tempo na etapa atual exceder o limite da etapa (parâmetro `PAI.SLA_ETAPA_MIN`, mapa etapa→minutos por armazém; sem entrada = sem SLA). Atraso muda o realce do cartão e conta no KPI K-14.

**RF-PAI-005 — Tela do Fluxo Operacional (apresentação da RN-EXP-011)**
QUANDO um cartão for aberto, o sistema DEVE exibir a tela do fluxo com:
1. Cabeçalho: documento, cliente, datas, responsáveis, botão de chat da operação (§4.4);
2. Trilha horizontal de etapas na ordem fixa, cada etapa com: nome, ícone (conjunto Lucide, RG-013), estado visual — `DONE` = verde com ícone de check; `PENDING` = vermelho; primeira pendente acionável = vermelho com realce e cursor de ação; pendentes seguintes = vermelho esmaecido/desabilitado;
3. Acessibilidade [INVIOLÁVEL]: o estado NÃO PODE ser comunicado apenas por cor — cada etapa carrega ícone e rótulo textual do estado (WCAG 2.1 AA, RG-013);
4. Comportamento de clique conforme RN-EXP-011 (acionável abre a tela da operação; posterior é inerte com aviso; concluída abre consulta);
5. Indicador de exceção pendente sobre a etapa bloqueada, com acesso à exceção para quem tem alçada;
6. Timestamps de conclusão de cada etapa e usuário executante (RG-003) visíveis em detalhe.

### 4.2 Centro de alertas

**RF-PAI-010 — Consolidação**
O centro de alertas assina o tópico `alertas` e consolida: exceções aguardando o usuário (com alçada), Edge Agent desconectado, estoque de segurança violado, lotes a vencer/vencidos, cross-docking acima do tempo, transbordo de armazém lógico pendente de retorno, cartões atrasados, falhas de integração (DOC-13). Cada alerta tem severidade (`INFO`/`WARN`/`CRIT`), é marcável como lido por usuário e navega para o objeto de origem. Badge de não-lidos no cabeçalho da aplicação.

### 4.3 Rastreamento (portal do cliente)

**RF-PAI-020 — Linha do tempo do documento**
No portal, cada pedido/recebimento do cliente DEVE exibir a linha do tempo do Fluxo Operacional (mesma trilha visual, SOMENTE leitura, sem nomes de operadores internos), com timestamps das etapas concluídas e previsão (data prevista de expedição). Atualização em tempo real pelo mesmo tópico, filtrada pelo RLS/RBAC do portal (RF-SEG-006).

### 4.4 Chat operacional

**RF-PAI-030 — Salas**
Duas modalidades de Sala de Chat: (a) sala do armazém-turno (uma por armazém, persistente); (b) sala da operação (criada sob demanda a partir do cartão/tela do fluxo, vinculada ao Fluxo Operacional). Mensagens: texto até 2.000 caracteres e anexo de imagem (S3). Menções `@usuario` notificam via tópico `chat:{sala}`. Mensagens são persistentes, imutáveis e sujeitas a RLS quando a operação for de cliente (sala da operação herda o `tenant_id`).

**RN-PAI-031 — Limites do chat**
O chat NÃO substitui registros formais: decisões de exceção, motivos e aprovações ocorrem exclusivamente nos fluxos próprios (DOC-12). É PROIBIDO acionar qualquer operação a partir do chat. Retenção de mensagens: 12 meses (depois arquivadas em S3 como as demais retenções).

### 4.5 Dashboards de performance diária (resolve LAC-004)

**RF-PAI-040 — Estrutura**
Dashboard por armazém com filtros: período (dia/semana/mês, padrão = hoje), cliente (autorizados). Layout fixo (edição fora de escopo, DOC-01) em quatro grupos: Recebimento, Expedição, Pátio & Portaria, Estoque. Consultas de dashboard DEVEM usar os Agregados Diários e/ou réplica de leitura (DOC-01) — é PROIBIDO consultar tabelas transacionais quentes para gráficos.

**RN-PAI-041 — Catálogo fechado de KPIs [INVIOLÁVEL — fórmulas normativas]**
Notação: eventos e campos dos módulos de origem; `média()` = média aritmética; períodos em horas decimais.

| ID | KPI | Fórmula | Origem |
|---|---|---|---|
| K-01 | Ordens recebidas | contagem de `recebimento.concluido` no período | DOC-04 |
| K-02 | Tempo de doca (h) | média(liberação da doca − atracação) | DOC-04 |
| K-03 | Dock-to-stock (h) | média(último putaway da ordem − atracação) | DOC-04 |
| K-04 | % ordens com divergência | ordens com ≥1 Divergência ÷ K-01 × 100 | DOC-04 |
| K-05 | Pedidos expedidos | contagem de `expedicao.pedido_concluido` | DOC-06 |
| K-06 | OTIF (%) | pedidos COMPLETOS (sem corte definitivo) E no prazo (gate-out ≤ data prevista) ÷ K-05 × 100 | DOC-06 |
| K-07 | Lead time do pedido (h) | média(gate-out − liberação) | DOC-06 |
| K-08 | % de corte | Σ qty cortada definitiva ÷ Σ qty pedida dos pedidos concluídos × 100 | DOC-06 |
| K-09 | Permanência de veículo (h) | média(gate-out − gate-in) por sentido | DOC-03 |
| K-10 | Veículos atendidos | contagem de visitas ENCERRADAS por sentido | DOC-03 |
| K-11 | No-show (%) | agendamentos NO_SHOW ÷ agendamentos da janela no período × 100 | DOC-03 |
| K-12 | Acuracidade de endereço (%) | conforme RF-EST-064, último inventário concluído no período | DOC-05 |
| K-13 | Ocupação de posições (%) | endereços STORAGE/PICKING com saldo ÷ endereços ativos × 100 (snapshot diário 23:59 do fuso do armazém) | DOC-05 |
| K-14 | Cartões atrasados | contagem de cartões que entraram em atraso (RN-PAI-004) no período | DOC-10 |
| K-15 | Produtividade de picking (linhas/h) | Σ tarefas de picking DONE ÷ Σ horas com tarefa em execução por operador (agregado do armazém) | DOC-06 |
| K-16 | Lotes a vencer 30 dias | contagem de lotes com validade ≤ hoje+30 e saldo > 0 (snapshot diário) | DOC-05 |
| K-17 | Aging de pátio (min) | média(chamada para doca − gate-in) das visitas do dia | DOC-03 |

**Exemplo normativo (K-06 OTIF):** dia com 40 pedidos concluídos; 32 sem corte definitivo; desses 32, 30 com gate-out até a data prevista → OTIF = 30 ÷ 40 × 100 = **75,0%** (pedidos com corte não contam no numerador ainda que no prazo).

**RN-PAI-042 — Materialização dos agregados [INVIOLÁVEL]**
Um worker dedicado consome os eventos de domínio e mantém `kpi_daily` (dia × armazém × cliente × KPI) por incrementos idempotentes (chave: `event_id` — RG-009). KPIs de snapshot (K-13, K-16) são computados pelo `scheduler` às 23:59 do fuso do armazém. Recontagem completa de um dia (comando administrativo) DEVE reproduzir os mesmos valores a partir de `event_outbox`/tabelas-fonte (determinismo verificável).

**RF-PAI-043 — Gráficos**
Por grupo: cartões de valor do dia (comparativo com média dos 7 dias anteriores, seta de tendência), série temporal do período (linha/barra), e ranking top-5 (clientes por volume, etapas por atraso). Exportação CSV dos valores exibidos (auditada, RN-SEG-032).

### 4.6 Eventos de domínio deste módulo

`paineis.alerta_emitido`, `paineis.chat_mensagem` (payload sem conteúdo — o conteúdo trafega no canal da sala), `paineis.kpi_recomputado`.

---

## 5. MÁQUINAS DE ESTADO E FLUXOS

### 5.1 Cartão de operação (derivado — sem persistência própria)

O cartão reflete `operation_flow` (RD-EXP-002): `ABERTO → (ATRASADO) → CONCLUIDO/CANCELADO`. `ATRASADO` é atributo calculado (RN-PAI-004), não estado persistido.

### 5.2 Alerta

`EMITIDO → LIDO (por usuário) → RESOLVIDO (quando o objeto de origem sai da condição)`. Resolução é automática por evento (ex.: Edge Agent reconecta) ou pela conclusão do objeto.

---

## 6. CRITÉRIOS DE ACEITE (GHERKIN)

```gherkin
Cenário: Painel atualiza em tempo real
  Dado o painel aberto com o cartão do pedido PED-SP01-00000400 na etapa Picking
  Quando a última tarefa de picking for concluída
  Então o cartão deve exibir a etapa Embalagem em até 2 segundos
  E sem recarga da página

Cenário: RBAC filtra cartões
  Dado usuário com atribuições apenas para o cliente A no armazém SP01
  Quando abrir o Painel de Operações de SP01
  Então nenhum cartão de operações do cliente B deve ser exibido

Cenário: Acessibilidade da trilha de etapas
  Dado a tela do fluxo de um pedido
  Quando inspecionados os elementos das etapas
  Então cada etapa deve conter rótulo textual do estado e ícone além da cor
  E o contraste deve atender WCAG 2.1 AA

Cenário: Etapa posterior é inerte
  Dado fluxo com Embalagem pendente acionável e Pesagem pendente seguinte
  Quando o usuário clicar em Pesagem
  Então nenhuma tela deve abrir
  E o aviso "conclua a etapa anterior" deve ser exibido

Cenário: OTIF exclui pedidos com corte (exemplo normativo RN-PAI-041)
  Dado 40 pedidos concluídos no dia, 32 sem corte, 30 destes no prazo
  Quando o KPI K-06 for calculado
  Então o valor deve ser 75,0%

Cenário: Recomputação determinística
  Dado o dia 2026-08-09 com K-05 = 512 em kpi_daily
  Quando o comando administrativo de recontagem do dia executar
  Então o valor recomputado a partir das fontes deve ser 512

Cenário: Dashboard não consulta tabelas quentes
  Dado a implementação das consultas do dashboard
  Quando inspecionadas
  Então devem ler exclusivamente kpi_daily e/ou réplica de leitura
  E nenhuma consulta deve acessar tabelas transacionais no primário

Cenário: Chat não aciona operações
  Dado a sala de chat de uma operação
  Quando inspecionadas as capacidades da sala
  Então não deve existir comando que conclua etapa, aprove exceção ou movimente estoque

Cenário: Rastreamento do portal omite operadores
  Dado cliente autenticado no portal acompanhando o pedido próprio
  Quando abrir a linha do tempo
  Então as etapas e timestamps devem aparecer
  E nenhum nome de operador interno deve ser exibido
```

---

## 7. REQUISITOS DE DADOS (DELTA SOBRE O DOC-02)

| ID | Estrutura | Classificação | Observações |
|---|---|---|---|
| RD-PAI-001 | `kpi_daily` | TENANT (linhas por cliente) + linhas consolidadas por armazém (tenant do operador) | UNIQUE(dia, warehouse, client, kpi); valores NUMERIC(18,4) |
| RD-PAI-002 | `kpi_event_applied` | TENANT | idempotência da materialização (event_id aplicado por KPI) |
| RD-PAI-003 | `alert` + `alert_read` | TENANT/GLOBAL conforme origem | severidade, objeto de origem, resolução |
| RD-PAI-004 | `chat_room` + `chat_message` | TENANT quando sala de operação; GLOBAL quando sala de armazém | mensagens imutáveis, anexos em S3 |
| RD-PAI-005 | `user_board_preference` | GLOBAL | filtros persistidos do painel |

Parâmetros: `PAI.SLA_ETAPA_MIN` (mapa etapa→minutos).

---

## 8. FORA DE ESCOPO (NÃO IMPLEMENTAR)

- Dashboards editáveis/BI self-service, drill-down além dos rankings definidos (DOC-01 §8).
- Exportação agendada de relatórios por e-mail.
- KPIs financeiros e de faturamento (DOC-09 define os próprios).
- Chat com clientes externos (o chat é interno; o portal comunica-se por notificações estruturadas).
- Chamadas de vídeo/áudio, reações, threads no chat.
- Notificações push nativas de sistema operacional (as notificações são in-app pelo tópico de alertas).

---

## 9. MATRIZ DE RASTREABILIDADE LOCAL

| Necessidade (DOC-00 §8) | Requisitos deste documento |
|---|---|
| N16 Painel de controle com gráficos diários | §4.5 (LAC-004 resolvida) |
| N17 Painel de operações pendentes + fluxo clicável | §4.1, RF-PAI-005 |
| N24 Tempo real (painel, chat, rastreamento) | RF-PAI-003, §4.3, §4.4 |
| RG-013 visual/acessibilidade | RF-PAI-005 item 3 |

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0.0 | 2026-08-10 | Versão inicial aprovada |
