# DOC-16 — PORTAL DO CLIENTE (DEPOSITANTE)
## Especificação de Requisitos do Sistema WMS Enterprise 3PL

| Metadado | Valor |
|---|---|
| Código do documento | DOC-16 |
| Versão | 1.0.0 |
| Status | APROVADO PARA USO |
| Data | 2026-08-16 |
| Depende de | DOC-00 v1.4.0, DOC-02, DOC-03, DOC-04, DOC-05, DOC-06, DOC-07, DOC-08, DOC-09, DOC-10, DOC-12, DOC-13 |
| Módulo (prefixo de requisitos) | POR-C (portal do cliente) |
| Posição no plano | Implementar após DOC-08 e DOC-09 (ver §10) |

---

## 1. ESCOPO E OBJETIVO

Este documento especifica o **Portal do Cliente**: a aplicação web que o
Cliente depositante usa para operar seu estoque no armazém — consultar saldos,
agendar chegadas, enviar avisos de recebimento, criar pedidos de saída,
acompanhar operações em tempo real, tratar pendências fiscais, autorizar
devoluções, conferir pré-faturas e extrair relatórios.

**Princípio central:** o portal deve suprir TODAS as necessidades do cliente
relativas à armazenagem, de modo que ele não precise telefonar ao armazém para
saber o que está acontecendo com sua mercadoria nem para solicitar operações
de rotina.

**Fronteiras:** o portal NÃO executa operações físicas (isso é da área interna
e dos coletores). Ele **solicita**, **autoriza**, **consulta** e **confere**.
As regras de negócio pertencem aos módulos de origem — este documento
especifica a superfície do cliente sobre elas, nunca regras novas.

---

## 2. DEPENDÊNCIAS E TERMOS

Aplica-se o Glossário (DOC-00 §4). Termos adicionais:

| Termo | Identificador técnico | Definição única |
|---|---|---|
| Usuário do Portal | `portal_user` | Usuário de área `CLIENT_PORTAL` (RF-SEG-006), vinculado a exatamente um Cliente. |
| Pendência do Cliente | `client_pending_item` | Item que aguarda ação do próprio cliente (nota de armazenagem, decisão de destinação, conferência de pré-fatura, aprovação de divergência). |
| Solicitação | `client_request` | Pedido de operação criado pelo cliente e sujeito a aceite/execução do armazém (agendamento, ASN, pedido de saída, devolução). |

---

## 3. ATORES E PERMISSÕES

| Papel (semente, RF-SEG-013) | Uso típico |
|---|---|
| `CLIENTE_CONSULTA` | Consulta saldos, rastreamento e relatórios; nenhuma escrita |
| `CLIENTE_OPERACAO` | Tudo do anterior + criar ASN, pedidos, agendamentos, autorizar devoluções |
| `CLIENTE_FISCAL` *(novo)* | Tudo de consulta + registrar Nota de Armazenagem e tratar pendências fiscais |
| `CLIENTE_FINANCEIRO` *(novo)* | Tudo de consulta + conferir, aprovar e contestar Pré-Faturas |
| `CLIENTE_ADMIN` *(novo)* | Gestão dos usuários do próprio cliente e das preferências de notificação |

**Catálogo de permissões deste módulo** (registradas em `permission`, DOC-12):

| Código | Escopo |
|---|---|
| `POR-C.CONSULTAR` | CLIENT_WAREHOUSE |
| `POR-C.CATALOGO_GERIR` | CLIENT_WAREHOUSE |
| `POR-C.ASN_CRIAR` | CLIENT_WAREHOUSE |
| `POR-C.PEDIDO_CRIAR` / `POR-C.PEDIDO_CANCELAR` | CLIENT_WAREHOUSE |
| `POR-C.AGENDAMENTO_CRIAR` | CLIENT_WAREHOUSE |
| `POR-C.DEVOLUCAO_AUTORIZAR` | CLIENT_WAREHOUSE |
| `POR-C.DIVERGENCIA_DECIDIR` | CLIENT_WAREHOUSE |
| `POR-C.FISCAL_TRATAR` | CLIENT_WAREHOUSE |
| `POR-C.PREFATURA_DECIDIR` | CLIENT_WAREHOUSE |
| `POR-C.USUARIOS_GERIR` | CLIENT_WAREHOUSE (sensível) |
| `POR-C.API_CREDENCIAL` | CLIENT_WAREHOUSE (sensível) |

Sem exceções próprias: decisões do cliente alimentam os workflows já
existentes (DOC-12 §4.5).

---

## 4. REQUISITOS TRANSVERSAIS

**RN-PORC-001 — Isolamento absoluto [INVIOLÁVEL]**
Token de portal carrega `tenant_ids` fixado no próprio Cliente (RF-SEG-006);
nenhuma rota interna é acessível com ele, e vice-versa. Toda consulta obedece
à RLS (RG-001). O cliente NUNCA vê: dados de outros clientes, nomes de
operadores internos, endereços físicos de armazenagem (ver RN-PORC-002),
custos internos do operador, ou o Painel de Operações interno.

**RN-PORC-002 — Granularidade da informação física [INVIOLÁVEL]**
O cliente vê saldo por **produto, lote, validade, situação e armazém** — e,
quando houver Armazém Lógico próprio, por ele. NÃO vê o endereço
(`location.code`), a estrutura de armazenagem nem o LPN de paletes
armazenados, salvo quando o LPN identifica volume expedido a ele (etiqueta que
ele recebe). Motivo: o endereçamento é know-how operacional do armazém e sua
exposição facilita contestações improdutivas.
ONDE o contrato do cliente previr transparência total (parâmetro
`POR-C.EXIBE_ENDERECO`, padrão false), o endereço pode ser exibido.

**RN-PORC-003 — Toda escrita é solicitação, nunca execução**
Ações do cliente criam documentos em estado inicial sujeito às validações e ao
aceite do armazém (agendamento sujeito a capacidade, pedido sujeito a
liberação, devolução sujeita a autorização). É PROIBIDO que uma ação do portal
altere saldo, conclua etapa de fluxo ou dispense validação interna.

**RN-PORC-004 — Tempo real e notificações**
O portal assina os tópicos do cliente (filtrados por RLS) para atualizar
rastreamento e pendências sem recarga (≤ 2 s, RNF-ARQ-042). Notificações por
e-mail conforme preferências do `CLIENTE_ADMIN`: divergência de recebimento,
pedido expedido, pendência fiscal, pré-fatura emitida, estoque de segurança
violado, lote a vencer, devolução autorizada/recusada.

**RNF-PORC-005 — Interface**
Segue o sistema de design do projeto (`wms-design-system`) e a RG-013:
componentes de `@wms/ui`, ícones Lucide, estado nunca apenas por cor,
contraste AA, responsivo para desktop e tablet. Idioma pt-BR (RG-012).

**RNF-PORC-006 — Autoatendimento**
Toda tela de listagem oferece exportação CSV do que está sendo exibido
(auditada, RN-SEG-032). Toda tela de detalhe oferece link permanente
compartilhável dentro do portal.

---

## 5. CATÁLOGO DE TELAS [FECHADO]

### Grupo A — Visão geral

**C-01 · Início (dashboard do cliente)**
- Cartões: saldo total (unidades, m³ ou paletes conforme contrato), pedidos em
  andamento por etapa, recebimentos previstos para hoje/semana, pendências
  que aguardam o cliente (destaque principal), alertas ativos.
- Gráficos (subconjunto dos KPIs do DOC-10 §4.5, restritos ao cliente):
  volume recebido e expedido no período, OTIF dos próprios pedidos, ocupação
  contratada × utilizada, lotes a vencer em 30/60/90 dias.
- Fonte: `kpi_daily` filtrado por cliente (RF-PAI-040 — nunca tabela quente).

**C-02 · Minhas Pendências [tela mais importante do portal]**
Lista única e priorizada de tudo que aguarda ação do cliente:
| Origem | Ação esperada |
|---|---|
| NF de entrada sem Nota de Armazenagem (RN-FIS-010) | registrar a nota antes do prazo, com contador regressivo |
| Divergência de recebimento (RN-REC-023) | dar ciência ou decidir destino da sobra/avaria |
| Produto sem cadastro na doca (RN-REC-012) | cadastrar/vincular o produto |
| Item de reversa em quarentena (RN-REV-021) | decidir destinação |
| Pré-fatura em conferência (RN-FAT-022) | aprovar ou contestar, com prazo |
| Descarte/ajuste aguardando documento fiscal (RN-FIS-070) | registrar o documento |
| Pedido bloqueado por saldo fiscal (RN-EXP-002) | regularizar lastro |
Cada item mostra o que é, desde quando aguarda, o prazo (quando houver) e o
impacto de não agir (ex.: "expedições deste produto seguem bloqueadas").

### Grupo B — Estoque

**C-03 · Saldo por produto**
Lista com SKU, descrição, espécie, e as parcelas do saldo em linguagem de
cliente: **disponível**, **reservado** (com link aos pedidos), **bloqueado**
(com motivo), **em quarentena**, **avariado**, **em trânsito**. Filtros por
armazém, categoria, espécie, situação e faixa de validade. Totais por unidade
base e conversão para embalagem de exibição (RN-DAD-021).

**C-04 · Saldo por lote e validade**
Detalhe do produto por lote: quantidade, fabricação, validade, dias restantes,
percentual de vida útil restante (RN-EST-012) e situação. Destaque para lotes
abaixo do shelf life mínimo contratado e para vencidos bloqueados
(RN-EST-014). Ordenação padrão por validade crescente.

**C-05 · Extrato de movimentações**
Histórico auditável por produto/lote/período: data, tipo de movimentação (em
linguagem de cliente, derivado do catálogo RN-EST-001), quantidade, documento
de origem, saldo resultante. Exportação CSV. É o extrato que o cliente concilia
com o próprio ERP.

**C-06 · Inventários**
Inventários que envolveram o estoque do cliente: tipo, período, endereços/
produtos abrangidos, resultado de acuracidade (RF-EST-064) e ajustes aplicados
com justificativa. Ajuste negativo exibe a pendência documental associada
(RN-FIS-070).

**C-07 · Alertas de estoque**
Estoque de segurança violado (RF-EST-040), lotes a vencer nos marcos
configurados, saldo bloqueado há mais de N dias, saldo em quarentena
aguardando decisão. Cada alerta navega ao objeto.

### Grupo C — Entrada de mercadoria

**C-08 · Agendamentos**
Criação (RF-POR-001) escolhendo armazém, sentido, janela com vaga disponível
(RN-POR-002 — nunca overbooking), tipo de veículo e vínculo a ASN ou pedidos.
Lista com situação (agendado, chegada confirmada, cumprido, no-show,
cancelado) e remarcação/cancelamento conforme RF-POR-003.

**C-09 · Avisos de recebimento (ASN)**
Criação por **upload de XML de NF-e** (extração automática de itens, lotes,
emitente e chave — RF-REC-010), por planilha (template fixo) ou digitação.
Validação linha a linha com relatório de erro determinístico. Vínculo opcional
a agendamento e a pedidos (cross-docking, RN-REC-050).

**C-10 · Acompanhamento de recebimentos**
Rastreamento de cada Ordem de Recebimento com a **trilha de etapas** (mesma
do DOC-10 RF-PAI-005, em modo consulta, sem nomes de operadores): chegada,
doca, descarga, conferência, divergências, etiquetagem, putaway, fim.
Detalhe do conferido × esperado por item, com fotos de avaria quando houver.

**C-11 · Divergências de recebimento**
Fila das divergências do cliente (falta, sobra, avaria, troca, produto sem
cadastro) com evidências, quantidade e efeito. Onde a regra exigir decisão do
cliente, os botões de decisão alimentam o workflow interno (RN-REC-023) — o
portal registra a manifestação, a decisão formal segue a alçada do armazém.
Carta de divergência em PDF disponível para download.

### Grupo D — Saída de mercadoria

**C-12 · Pedidos de saída**
Criação (RF-EXP-001) com destinatário, itens (SKU + quantidade em unidade base
ou embalagem), data prevista, transportadora prevista e observações.
Importação por planilha e por API (DOC-13). **Simulação antes de confirmar:**
o portal exibe, para cada item, se há saldo físico e fiscal suficiente
(RN-EXP-002), antecipando a rejeição.

**C-13 · Acompanhamento de pedidos**
Lista com situação e a **trilha verde/vermelho** por pedido em modo consulta:
Pedido → Picking → Embalagem → Pesagem → Expedição → Carregamento → Saída →
Fim. Timestamps de cada etapa concluída. Cortes de picking exibidos com
quantidade e motivo (RN-EXP-032). Cancelamento conforme RN-EXP-071 (o portal
solicita; a alçada decide quando tardio).

**C-14 · Volumes e documentos da expedição**
Por pedido: volumes com LPN, peso, sequência n/N; documentos fiscais
autorizados (chave, DANFE em PDF, XML para download — DOC-08); dados do
veículo e horário de saída.

### Grupo E — Devoluções

**C-15 · Autorizações de devolução**
Criação/autorização de Ordem de Devolução (RF-REV-001) por tipo, vinculada ao
pedido de origem, com validação de quantidade não excedente ao expedido
(RN-REV-003). Acompanhamento da triagem e das destinações aplicadas
(RN-REV-021), com fotos.

**C-16 · Decisões de destinação**
Itens em quarentena aguardando decisão do cliente: reintegrar (quando
permitido), devolver ao cliente ou descartar — com o efeito de cada opção
explicado e o registro do documento fiscal necessário quando aplicável.

**C-17 · Recall**
Acionamento de recall de lote (RF-REV-030) com anexo da determinação;
acompanhamento do bloqueio aplicado em todos os armazéns e do relatório de
rastreabilidade dos pedidos já expedidos com o lote.

### Grupo F — Fiscal

**C-18 · Notas de armazenagem**
Registro por upload de XML ou integração; validação contra as NF de entrada
(RF-FIS-020) com apontamento por item quando divergir. Lista com cobertura:
quanto de cada entrada já está coberto e quanto falta.

**C-19 · Saldo fiscal**
Saldo fiscal por produto × Nota de Armazenagem (creditado, consumido,
pendente de baixa documental, disponível), com o total confrontado ao saldo
físico. É a tela que explica ao cliente por que um pedido pode estar bloqueado
mesmo havendo mercadoria.

**C-20 · Documentos fiscais**
Todas as notas relacionadas ao cliente (entrada, armazenagem, devolução de
armazenagem, transferências), com chave, situação, DANFE e XML para download,
e a referência cruzada de qual nota de entrada cada linha de devolução
consumiu (RN-FIS-040).

**C-21 · Pendências documentais**
Descartes, ajustes negativos de inventário e prazos de regularização
aguardando documento do cliente (RN-FIS-070), com o efeito de cada pendência
sobre a operação.

### Grupo G — Financeiro

**C-22 · Pré-faturas**
Lista por período com situação. Detalhe com memória de cálculo navegável até o
lançamento individual (RF-FAT-021): armazenagem dia a dia, movimentações
evento a evento, serviços avulsos. **Aprovar** ou **contestar por item com
motivo** (RN-FAT-022), com o prazo de conferência e o aviso de aprovação
tácita. PDF para download.

**C-23 · Contrato e tarifas vigentes**
Itens tarifáveis contratados e preços vigentes, com histórico de vigências —
para o cliente conferir a pré-fatura contra o contrato sem pedir ao comercial.

### Grupo H — Cadastros e administração

**C-24 · Catálogo de produtos**
CRUD do próprio catálogo (RF-DAD-053): produto, espécie, embalagens com fator
de conversão, códigos de barras, NCM, shelf life, valor declarado para seguro.
Importação por planilha com validação linha a linha. Alterações sujeitas às
regras do DOC-02 (código imutável, espécie imutável com saldo > 0).

**C-25 · Parâmetros do meu estoque**
Consulta e, onde o contrato permitir, edição de: política de giro por produto,
shelf life mínimo, estoque de segurança por produto × armazém, kanban.
Alterações que afetam a operação exigem aceite do armazém.

**C-26 · Usuários do portal**
Gestão dos usuários do próprio cliente pelo `CLIENTE_ADMIN`: convite, papéis
do portal, desativação, e preferências de notificação por usuário.

**C-27 · Integrações e API**
Credenciais de API do cliente (client_id, rotação de secret — DOC-13),
assinaturas de webhook com endpoint e eventos, e o monitor das últimas
mensagens trocadas com estado e erro legível.

**C-28 · Relatórios**
Conjunto fechado, todos com filtro de período e exportação CSV/PDF:
posição de estoque, movimentação por período, recebimentos, expedições e
OTIF, divergências, inventários e acuracidade, lotes a vencer, devoluções,
faturamento por período.

---

## 6. MÁQUINAS DE ESTADO E FLUXOS

O portal não introduz máquinas de estado próprias: exibe e alimenta as dos
módulos de origem (agendamento §DOC-03 5.2, recebimento §DOC-04 5.1, pedido
§DOC-06 5.1, devolução §DOC-07 5.1, pré-fatura §DOC-09 5.1, documento fiscal
§DOC-08 5.1). A trilha de etapas é o componente único do DOC-10 (RF-PAI-005)
em modo consulta.

**Estado de uma Solicitação do cliente (RN-PORC-003):**
`SOLICITADA → ACEITA` (validações do armazém passaram) `→ EM_EXECUÇÃO →
CONCLUÍDA`; ramos `RECUSADA` (com motivo obrigatório visível ao cliente) e
`CANCELADA`.

---

## 7. CRITÉRIOS DE ACEITE (GHERKIN)

```gherkin
Cenário: Isolamento entre clientes no portal
  Dado um usuário do portal do cliente A
  Quando ele consultar qualquer tela do portal
  Então nenhum dado do cliente B deve aparecer
  E nenhuma rota da área interna deve ser acessível com seu token

Cenário: Endereço físico não é exposto por padrão
  Dado o parâmetro POR-C.EXIBE_ENDERECO desligado
  Quando o cliente consultar o saldo de um produto
  Então o endereço de armazenagem não deve aparecer em nenhum campo nem no CSV
  E o saldo deve ser apresentado por produto, lote, validade, situação e armazém

Cenário: Pedido bloqueado por saldo fiscal é explicado
  Dado saldo físico de 700 UN e saldo fiscal disponível de 600 UN
  Quando o cliente simular um pedido de 700 UN em C-12
  Então a simulação deve indicar a insuficiência fiscal antes da confirmação
  E deve haver link para a tela C-19 explicando a composição do saldo fiscal

Cenário: Prazo da nota de armazenagem visível com impacto
  Dado uma NF de entrada registrada há 8 dias com prazo de 10
  Quando o cliente abrir C-02
  Então a pendência deve aparecer com contador regressivo de 2 dias
  E deve informar que expedições do produto ficarão bloqueadas ao expirar

Cenário: Rastreamento não expõe operador interno
  Dado um pedido em execução
  Quando o cliente abrir a trilha em C-13
  Então as etapas e timestamps devem aparecer
  E nenhum nome de operador interno deve ser exibido

Cenário: Contestação de pré-fatura é aditiva
  Dado uma pré-fatura com item contestado e decisão procedente
  Quando o ajuste for aplicado
  Então uma nova versão da pré-fatura deve ser emitida
  E a versão anterior deve permanecer acessível ao cliente

Cenário: Ação do portal não altera saldo diretamente
  Dado qualquer ação disponível ao cliente
  Quando executada
  Então nenhuma movimentação de estoque deve ocorrer sem execução interna
  E o documento criado deve nascer em estado SOLICITADA

Cenário: Devolução limitada ao expedido
  Dado 100 UN expedidas e 30 UN já devolvidas do pedido de origem
  Quando o cliente autorizar devolução de 80 UN
  Então o sistema deve rejeitar informando o limite restante de 70 UN
```

---

## 8. REQUISITOS DE DADOS (DELTA)

| ID | Estrutura | Observações |
|---|---|---|
| RD-PORC-001 | `client_pending_item` (view ou materialização) | consolida as pendências do §C-02 a partir dos módulos de origem; não duplica estado |
| RD-PORC-002 | `portal_notification_preference` | por usuário do portal × tipo de notificação |
| RD-PORC-003 | `client_request` | estado §6 e vínculo ao documento gerado |

Parâmetros: `POR-C.EXIBE_ENDERECO`, `POR-C.PERMITE_EDITAR_PARAMETROS`,
`POR-C.PRAZO_DECISAO_DIVERGENCIA_H`.

---

## 9. FORA DE ESCOPO (NÃO IMPLEMENTAR)

- Execução de operações físicas ou conclusão de etapas de fluxo pelo cliente.
- Visão de endereços, estruturas, docas, pátio ou Painel de Operações interno.
- Chat com a operação (DOC-10 §8 mantém o chat como interno; a comunicação com
  o cliente é por notificação estruturada e pelas telas de decisão).
- Pagamento, boleto, gateway ou baixa financeira (AD-003).
- Emissão de NF-e de venda do cliente (DOC-08 §8).
- Aplicativo nativo para o cliente.
- Personalização de dashboards e relatórios além do conjunto fechado do §C-28.
- Acesso a dados de outros clientes, ainda que agregados ou anonimizados.

---

## 10. POSIÇÃO NO PLANO DE EXECUÇÃO

O portal depende de módulos ainda não implementados: **DOC-08** (telas C-18 a
C-21) e **DOC-09** (C-22, C-23). Recomenda-se implementá-lo **após a posição 4
do ROTEIRO-DESENVOLVIMENTO** (faturamento), em duas sessões:

- **PORTAL-1:** fundação e operação — C-01 a C-17 e C-24 a C-28 (tudo que
  depende apenas de módulos já prontos);
- **PORTAL-2:** fiscal e financeiro — C-18 a C-23.

**Antecipação possível:** se um cliente-piloto precisar de acesso antes,
PORTAL-1 pode ser executado logo após os coletores (posição 1), entregando
consulta de estoque, ASN, pedidos, agendamento e rastreamento — que já cobrem
a maior parte da rotina do depositante.

---

## 11. MATRIZ DE RASTREABILIDADE LOCAL

| Necessidade (DOC-00 §8) | Telas |
|---|---|
| N14 Multi-empresas (visão do cliente) | RN-PORC-001, todas |
| N11/N12/N13 Estoque, validade, segurança, kanban | C-03 a C-07, C-25 |
| N03/N04 Recebimento e cross-docking | C-08 a C-11 |
| N09 Pedidos | C-12 a C-14 |
| N05 Reversa | C-15 a C-17 |
| N27/N25 Estoque fiscal e emissão | C-18 a C-21 |
| N22 Faturamento de serviços | C-22, C-23 |
| N15 Integrações | C-27 |
| N16/N24 Painel e tempo real (visão do cliente) | C-01, C-02, RN-PORC-004 |
| N21 Visual clean e padronizado | RNF-PORC-005 |

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0.0 | 2026-08-16 | Versão inicial aprovada |
