# SESSÃO 4B: MOTOR DE PUTAWAY (DOC-04 §4.5)
> Modelo recomendado: **PREMIUM (Opus)**. Algoritmo mais denso do módulo — a
> sugestão de endereço governa a integridade física e legal do armazém.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-04-recebimento-docas.md`, `docs/relatorios/SESSAO-4A-relatorio.md`,
> e APENAS as seções §4.3 e §5.2 do `docs/DOC-05-estoque-movimentacao.md`
> (matriz de espécies e coerência estrutura × giro).
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar o Motor de Putaway (RN-REC-040/041, RF-REC-042) e a execução das
tarefas de armazenagem, fechando o DOC-04. Este é o componente que decide
ONDE cada palete é guardado — erro aqui vira mercadoria em local ilegal.

## REGRAS
- Cite o §/ID ao definir CADA critério, filtro, enum e mensagem de erro.
  Não invente critério nem ordem: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`;
  mock de Postgres/Redis em integração; **enfraquecer um filtro da Fase 1 para
  fazer teste passar**; declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria com `before`+`after`;
  permissão declarada por rota (RN-SEG-012); máquina de estados explícita;
  eventos via outbox transacional.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Fase 1 — Filtros invioláveis (RN-REC-040) [O NÚCLEO]
Implementar os SEIS filtros na ORDEM FIXA do documento, como pipeline
não configurável:
1. `location.status = ACTIVE`;
2. Contenção do Armazém Lógico (RG-015): endereços restritos ao armazém
   lógico do cliente quando ativo; endereço de armazém lógico NUNCA aceita
   produto de outro cliente;
3. Compatibilidade de espécie: `zone.allowed_species` + matriz de
   segregação (DOC-05 RN-EST-020/021), distinguindo proibição LEGAL (`L`,
   sem override possível) de OPERACIONAL (`O`);
4. Quarentena: lote `QUARANTINE` → somente zonas `QUARANTINE` (RN-REC-031);
5. Capacidades do endereço (peso, volume, paletes, altura) considerando a
   ocupação ATUAL — não a capacidade nominal vazia;
6. Coerência física × política de giro (DOC-05 RN-DAD-010): estrutura
   `LIFO_PHYSICAL` só aceita produto FEFO/FIFO se todo o canal for do mesmo
   lote; `FIFO_PHYSICAL` preferencial para FEFO/FIFO.

**Regra de ouro [INVIOLÁVEL]:** endereço reprovado em QUALQUER filtro não pode
ser sugerido NEM aceito por override — nem com `EST.PUTAWAY_OVERRIDE`, nem por
API, nem por importação. O motor DEVE retornar o motivo exato da reprovação
(filtro + endereço) para diagnóstico.

### 2. Fase 2 — Ranqueamento configurável (RN-REC-040)
Catálogo FECHADO de 6 critérios: `ZONA_PREFERENCIAL_PRODUTO`,
`CONSOLIDACAO_PRODUTO_LOTE`, `CLASSE_ABC`, `MENOR_NIVEL`,
`MENOR_DISTANCIA_DOCA`, `MAIOR_OCUPACAO_ZONA`.
Semântica obrigatória: lista ORDENADA por armazém (`REC.CRITERIOS_PUTAWAY`);
**cada critério seguinte só desempata o anterior** (ordenação lexicográfica em
cascata, não soma de pesos). Empate final: menor `location.code`.
Saída: 1ª colocada como sugestão + as 4 seguintes como alternativas.

**Teste de regressão permanente (exemplo normativo do documento):**
critérios `[ZONA_PREFERENCIAL_PRODUTO, CLASSE_ABC, MENOR_NIVEL]`;
endereços aprovados E1 (zona pref., classe B, nível 03), E2 (zona pref.,
classe A, nível 04), E3 (outra zona, classe A, nível 00) →
**ordem E2, E1, E3; sugestão E2**. Não altere o valor esperado: se falhar,
o algoritmo está errado.

### 3. Override do operador (RN-REC-041)
`EST.PUTAWAY_OVERRIDE` permite escolher endereço FORA da sugestão, desde que
aprovado na Fase 1; exige motivo e gera auditoria com `action = OVERRIDE`.
Sem a permissão: somente a sugestão e as 4 alternativas são aceitas.
Teste obrigatório: override tentando endereço reprovado na Fase 1 é rejeitado
(cenário do §6 com produto INFLAMAVEL).

### 4. Execução das tarefas (RF-REC-042)
Geração de `putaway_task` por palete (estrutura já criada na 4A), fila por
prioridade e proximidade, atribuição a operador. Execução com **dupla leitura**
(LPN → endereço destino, RN-DAD-011); leitura de endereço divergente do
designado é rejeitada NO ATO sem permissão de override. Confirmação credita
`stock_balance` na parcela conforme o estado do lote e registra
`stock_movement` tipo `PUTAWAY` (catálogo DOC-05 RN-EST-001).
Preparado para execução offline (RNF-ARQ-050) — a tela é do DOC-15, aqui só
o serviço idempotente por `operation_id`.

### 5. Conclusão do recebimento (RF-REC-043)
Quando todos os paletes estiverem armazenados (ou em cross-docking), concluir
o Fluxo Operacional, liberar a doca e publicar `recebimento.concluido`.
Fechar o `[DEBITO: 4B]` da 4A: cancelamento de pedido com cross-docking gera
tarefas de putaway pelo motor padrão (RF-REC-051).

### 6. Testes de integração (contra containers reais)
Os 2 cenários de putaway do DOC-04 §6 (Fase 1 sem override; ranqueamento
determinístico E2/E1/E3) + os desta sessão:
- dupla leitura: endereço divergente rejeitado no ato;
- contenção RG-015: produto do cliente A não é sugerido para endereço do
  armazém lógico do cliente B, e o override não vence;
- capacidade: endereço com ocupação que não comporta o palete é filtrado;
- LIFO_PHYSICAL: produto FEFO só entra em canal de lote homogêneo;
- quarentena: lote QUARANTINE só recebe sugestão de zona QUARANTINE;
- cancelamento de cross-docking gera putaway padrão.
+ Regressão: todas as suítes anteriores verdes (121+).

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-4B-relatorio.md` com
matriz requisito → arquivo → teste, lacunas, débitos, e uma seção explicando
como cada um dos 6 filtros foi implementado e testado.

## FORA DE ESCOPO
Motor de seleção de saldo para SAÍDA (FEFO/FIFO/LIFO — Sessão 5B), inventário
(5C), telas de coletor (DOC-15), regras de expedição (DOC-06), task
interleaving e re-slotting (DOC-04 §8 / DOC-05 §8).
