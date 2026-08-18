# SESSÃO 6A: PEDIDO E FLUXO OPERACIONAL (DOC-06 §4.1–§4.3, §4.8)
> Modelo recomendado: **PREMIUM (Opus)**. Implementa a RG-002 — o requisito que
> originou o projeto (fluxo verde/vermelho sem salto de etapas).
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-06-expedicao.md`, `docs/relatorios/SESSAO-5B-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar: Pedido (criação, liberação com validação física E fiscal,
reserva), a **máquina de estados normativa do Fluxo Operacional** com as
regras de navegação da RG-002, ondas, e o motor de estornos/cancelamento.
Picking→carregamento é a 6B.

## REGRAS
- Cite o §/ID do DOC-06 ao definir CADA etapa, estado, transição, permissão,
  exceção e evento. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **relaxar a RG-002 (ordem das etapas) para
  fazer teste passar**; declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria `before`+`after`;
  permissão por rota; eventos via outbox; serviço único de movimentação
  (5A) para qualquer alteração de saldo; `StockSelectionService` (5B) para
  escolher saldo — **não reimplemente seleção**.
- Não refatore código que já passa nos testes (exceto item 0).

## ENTREGÁVEIS

### 0. Teste de contrato de permissões [PRIMEIRO, se ainda não existir]
Percorre as tabelas do schema `wms` e valida os grants de `wms_app` e
`wms_worker` contra lista declarada. Motivo: grants faltando para
`wms_worker` apareceram em 3 sessões seguidas, sempre descobertos tarde.

### 1. Catálogos centrais (antes do código)
8 permissões `EXP.*` (§3) com escopos exatos e atribuição aos papéis semente;
5 tipos de exceção `EXP.*` (§3) em `exception_type`; os eventos `expedicao.*`
do §4.9 que pertencem a esta sessão (`pedido_criado`, `pedido_liberado`,
`reserva_efetivada`, `onda_liberada`, `etapa_concluida`, `pedido_cancelado`,
`estorno_executado`) no catálogo tipado + mapeamento evento→tópico.

### 2. Migrations (§7)
`outbound_order` + `outbound_order_item`, `wave`, e — **estrutura genérica e
reutilizável** — `operation_flow` + `flow_step` (RD-EXP-002), que o DOC-04
(recebimento) e o DOC-07 (reversa) também instanciarão. RLS nas de tenant;
enums como CHECK com os valores exatos da §5.1.
Se o recebimento (4A) já criou algo equivalente a `operation_flow`, CONSOLIDE
numa estrutura única — não crie uma segunda.

### 3. Pedido: criação e liberação (§4.1)
RF-EXP-001 (criação por API/interno; numeração `PED` da 2B; itens na unidade
base ou embalagem com conversão RN-DAD-021).
**RN-EXP-002 [INVIOLÁVEL] — validação na liberação, item a item:**
1. saldo físico suficiente pela `StockSelectionService` (5B), incluindo shelf
   life com `purpose = EXPEDICAO_CLIENTE`;
2. **saldo fiscal disponível total ≥ quantidade** quando o cliente controla
   Estoque Fiscal (RG-014) — a alocação POR NOTA é do DOC-08; aqui valida-se
   apenas suficiência. Enquanto o DOC-08 não existir, implemente a consulta
   contra `fiscal_stock_balance` (`qty_credited − qty_consumed −
   qty_pending_writeoff`) e marque `[LACUNA: DOC-08 detalha a alocação]`;
3. ausência de bloqueios de produto/cliente.
Falha → rejeição com lista determinística de pendências POR ITEM (saldo
físico faltante, saldo fiscal faltante, bloqueio). Liberação parcial conforme
`EXP.PERMITE_LIBERACAO_PARCIAL`, gerando pedido remanescente vinculado.
RN-EXP-003 (reserva via movimentação `RESERVA` do serviço único, com
detalhamento saldo→item persistido; expiração por `EXP.RESERVA_VALIDADE_H`
devolvendo a `RELEASED_EXPIRED`).

### 4. Fluxo Operacional — NORMATIVO (§4.2) [O CORAÇÃO DO SISTEMA]
**RN-EXP-010**: instanciar as 8 etapas fixas na ordem, cada uma com a condição
exata de conclusão e o estado correspondente do pedido (tabela do documento).
**RN-EXP-011 [INVIOLÁVEL] — as 6 regras de navegação:**
1. `DONE` = verde, `PENDING` = vermelho;
2. única etapa acionável = primeira `PENDING` cuja antecessora esteja `DONE`;
3. tentativa de acionar etapa posterior é **inerte na UI e erro
   `FLOW_STEP_ORDER_VIOLATION` na API** — implemente a guarda no SERVIÇO, não
   no controller, para que nenhum caminho a contorne;
4. etapa `DONE` abre em modo consulta;
5. exceção `PENDING`/`ESCALATED` vinculada mantém a etapa vermelha com
   indicador de bloqueio (RN-SEG-042);
6. conclusão de etapa publica evento e atualiza o painel em ≤ 2 s.
A API expõe o estado do fluxo (etapas, estados, acionável, bloqueios) num
contrato único que o DOC-10 consumirá.

### 5. Ondas (§4.3)
RF-EXP-020: agrupamento de pedidos `RELEASED` por filtros, liberação gerando
as tarefas (a geração em si é 6B — aqui a onda e seus limites,
`EXP.ONDA_MAX_PEDIDOS`); pedido sem onda = onda unitária implícita.

### 6. Estornos e cancelamento (§4.8)
**RN-EXP-070 [INVIOLÁVEL]**: tabela de estorno por etapa com atomicidade —
nunca parcial. Nesta sessão implemente o MOTOR e os casos que já existem
(estorno de liberação/reserva); os estornos de picking/packing/pesagem/
carregamento ficam com o gancho pronto e `[DEBITO: 6B]`.
**Estorno após gate-out é PROIBIDO** — rejeição explícita orientando o DOC-07.
RN-EXP-071: cancelamento direto em `DRAFT`/`RELEASED`; do picking iniciado até
antes da emissão fiscal exige `EXP.CANCELAMENTO_TARDIO` (2 passos) com
estornos em cascata.

### 7. Testes de integração (contra containers reais)
- liberação bloqueada por saldo fiscal insuficiente (cenário §6, mensagem
  "saldo fiscal insuficiente: disponível 600");
- liberação parcial gera pedido remanescente;
- **navegação sem salto**: clicar/chamar etapa posterior → inerte + erro
  `FLOW_STEP_ORDER_VIOLATION` (cenários §6);
- exceção pendente mantém etapa vermelha e bloqueia a seguinte;
- reserva expirada devolve a `RELEASED_EXPIRED` e libera o saldo;
- concorrência: dois pedidos disputando o mesmo saldo — só um reserva
  (reuso da serialização da 5B);
- estorno de liberação desfaz a reserva integralmente;
- estorno após `GATE_OUT` é rejeitado orientando reversa;
- cancelamento tardio exige 2 aprovadores.
+ Regressão: todas as suítes anteriores verdes (188+).

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-6A-relatorio.md` com
matriz requisito → arquivo → teste, a decisão sobre consolidação do
`operation_flow` com o recebimento, lacunas e débitos.

## FORA DE ESCOPO
Picking, packing, pesagem, expedição documental, carregamento e saída
(§4.4–§4.7 — Sessão 6B); alocação fiscal por nota e emissão de NF-e (DOC-08);
painel e KPIs (DOC-10); telas de coletor (DOC-15); inventários (5C); e tudo
do DOC-06 §8 (TMS, roteirização, cubagem, voice picking, batch picking).
