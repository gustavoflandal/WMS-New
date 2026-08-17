# SESSÃO 5A: DOC-05 PARTE 1 — MOVIMENTAÇÕES, BLOQUEIOS, TRANSFERÊNCIAS, KANBAN
> Modelo recomendado: MÉDIO (Sonnet). A seleção de saldo (FEFO/FIFO/LIFO) é a 5B (PREMIUM).
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-05-estoque-movimentacao.md`, `docs/relatorios/SESSAO-4B-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar o DOC-05 exceto a Seleção de Saldo e os inventários: catálogo
fechado de movimentações, bloqueios e reclassificações, estoque de segurança,
kanban e reposição, transferências internas e entre armazéns.

## REGRAS
- Cite o §/ID do DOC-05 ao definir CADA tipo, coluna, enum, permissão, exceção
  e evento. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; enfraquecer regra [INVIOLÁVEL] para fazer
  teste passar; declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria com `before`+`after`;
  permissão por rota (RN-SEG-012); máquina de estados explícita; eventos via
  outbox transacional; leituras cross-tenant apenas por `SECURITY DEFINER` de
  exposição mínima (padrão da 4B).
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Catálogos centrais (antes do código)
- 7 permissões `EST.*` da §3 (além das transversais já existentes), com
  escopos exatos, atribuídas aos papéis semente.
- 4 tipos de exceção `EST.*` da §3 em `exception_type` (passos, motivo,
  expiração conforme a tabela).
- 13 eventos `estoque.*` (§4.8) no catálogo tipado + mapeamento evento→tópico
  para o fanout.

### 2. Catálogo fechado de movimentações (RN-EST-001) [INVIOLÁVEL — O NÚCLEO]
Implementar `movement_type` como enum fechado com os 16 tipos da tabela e,
para CADA um, o efeito exato nas parcelas do saldo. Requisitos:
- Um serviço ÚNICO de movimentação é o único caminho para alterar
  `stock_balance` — nenhum módulo escreve saldo diretamente (proíba por
  construção, como foi feito com o `publishInTx`).
- Toda movimentação grava `stock_movement` (append-only, já garantido no banco)
  com tipo, documento causador, tarefa quando houver e `requirement_id`.
- Tipos ainda sem módulo de origem (`PICKING`, `SAIDA_EXPEDICAO`,
  `ENTRADA_REVERSA`, `AJUSTE_INVENTARIO_*`) ficam implementados no serviço,
  disponíveis para as sessões futuras, com teste unitário de efeito.
- RG-004 revalidado: qualquer movimentação que resulte em parcela negativa é
  rejeitada com erro determinístico (o CHECK do banco é a última barreira, não
  a primeira).

### 3. Bloqueios e reclassificações (§4.4)
RF-EST-030 (bloqueio/desbloqueio com motivo tipificado: `VENCIDO`,
`QUALIDADE`, `DIVERGENCIA`, `ORDEM_CLIENTE`, `OUTRO`+texto; saldo
`blocked`/`damaged`/`quarantine` NUNCA entra em seleção — garanta isso já no
serviço de saldo disponível),
RF-EST-031 (reclassificação para avaria com fotos obrigatórias e transferência
sugerida para zona `DAMAGED`; descarte via exceção `EST.DESCARTE_SALDO` de 2
passos, com termo em PDF e notificação; o reflexo fiscal fica
`[LACUNA: DOC-08]` — apenas registre a pendência).

### 4. Alerta de vencimento (RN-EST-014)
Job diário no scheduler: alertas em 90/60/30/15/0 dias
(`EST.ALERTA_VENCIMENTO_DIAS`) e **bloqueio automático** de saldo vencido
(`available → blocked`, motivo `VENCIDO`) com notificação ao cliente e ao
painel. Idempotente (rodar duas vezes no mesmo dia não duplica movimentação).

### 5. Estoque de segurança e kanban (§4.5)
RF-EST-040 (avaliação horária + a cada baixa; alerta por CRUZAMENTO de
limiar, não por movimentação — não spammar),
RF-EST-041 (kanban: gatilho no endereço de picking gera UMA tarefa de
reposição de `kanban_replenish_qty` arredondada para cima em embalagens de
picking; PROIBIDO gerar segunda tarefa enquanto houver reposição aberta do
mesmo produto×endereço),
RF-EST-042 (reposição como tarefa dirigida com dupla leitura, idempotente por
`operation_id`; prioridade sobre putaway quando houver pedido liberado
dependente — a informação do pedido fica `[LACUNA: DOC-06]`, implemente o
gancho).
**Origem do saldo para reposição:** usa a Seleção de Saldo da 5B — nesta
sessão, chame uma interface `StockSelectionPort` com implementação provisória
FIFO simples, claramente marcada `[DEBITO: 5B substitui]`.

### 6. Transferências (§4.6)
RF-EST-050 (interna: endereço→endereço/palete→palete, por tarefa dirigida com
dupla leitura ou imediata com permissão; **destino passa pelos filtros Fase 1
do motor de putaway da 4B** — reuso obrigatório, não reimplementar),
RF-EST-051 (inter-armazém: `TRF` → picking no origem com baixa via
`in_transit` → recebimento no destino como Ordem de Recebimento vinculada,
com conferência obrigatória e divergência vinculada à TRF; saldo em trânsito
visível no armazém de ORIGEM; documento fiscal fica `[LACUNA: DOC-08]`),
RN-EST-052 (contenção RG-015 aplicada no destino, inclusive em outro armazém).

### 7. Testes de integração (contra containers reais)
- Cada um dos 16 `movement_type` produz o efeito exato nas parcelas (tabela
  RN-EST-001) — teste parametrizado.
- Escrita direta em `stock_balance` fora do serviço é impossível/rejeitada.
- Lote vencido é bloqueado automaticamente pelo job (cenário do §6) e a
  segunda execução não duplica.
- Kanban dispara UMA reposição e não gera segunda com reposição aberta
  (cenário do §6).
- Transferência interna com destino reprovado na Fase 1 é rejeitada.
- Transferência inter-armazém: saldo aparece em `in_transit` na origem e só
  credita no destino após conferência.
- Estoque de segurança alerta no cruzamento do limiar, não a cada baixa.
+ Regressão: todas as suítes anteriores verdes (139+).

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-5A-relatorio.md` com
matriz requisito → arquivo → teste, lacunas e débitos.

## FORA DE ESCOPO
**Seleção de Saldo RN-EST-010/011/012/013 (FEFO/FIFO/LIFO/JIT, shelf life,
quebra de política) — Sessão 5B (PREMIUM).**
**Inventários §4.7 — Sessão 5C.**
Também fora: matriz de espécies (já implementada na 4B — reusar), expedição
(DOC-06), fiscal (DOC-08), telas de coletor (DOC-15), e tudo do DOC-05 §8
(custeio, previsão de demanda, re-slotting, serialização, WCS).
