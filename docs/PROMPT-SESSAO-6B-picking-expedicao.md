# SESSÃO 6B: PICKING → CARREGAMENTO → SAÍDA (DOC-06 §4.4–§4.7)
> Modelo recomendado: MÉDIO (Sonnet). Fecha o DOC-06 e a operação de saída.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-06-expedicao.md`, `docs/relatorios/SESSAO-6A-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Completar o DOC-06: picking com corte, packing, pesagem com tolerância,
expedição documental, carregamento, saída, e os estornos que ficaram como
`[DEBITO: 6B]` na 6A. Última sessão antes do MARCO.

## REGRAS
- Cite o §/ID do DOC-06 ao definir CADA etapa, estado, permissão, exceção e
  evento. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **relaxar a RG-002, a tolerância de pesagem
  ou a atomicidade do estorno para fazer teste passar**; declarar ✅ sem saída
  de comando real; **estorno que marca etapa como desfeita sem desfazer**.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria `before`+`after`;
  permissão por rota; eventos via outbox; **serviço único de movimentação
  (5A)** para todo saldo; **`StockSelectionService` (5B)** para escolher saldo;
  `operation_flow` consolidado (6A) para o fluxo; teste de contrato de
  permissões atualizado a cada tabela nova.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Migrations e catálogos
`picking_task` (particionada como task), `package` + `package_content`,
`loading` + `loading_scan` (RD-EXP-004..006). RLS nas de tenant; enums como
CHECK com os valores exatos do §5.2. Declarar as tabelas novas no teste de
contrato de permissões. Eventos restantes do §4.9 (`tarefa_picking_concluida`,
`corte_registrado`, `volume_criado`, `volume_pesado`, `divergencia_peso`,
`documentos_autorizados`, `volume_carregado`, `pedido_concluido`) no catálogo
tipado + mapeamento evento→tópico.

### 2. Picking (§4.4)
RF-EXP-030 (tarefas a partir das reservas da 6A; **sequenciamento da rota**:
zona → rua serpenteando (ruas alternadas em ordem crescente/decrescente de
módulo) → módulo → nível; atribuição por fila ou designação),
RF-EXP-031 (execução com dupla leitura endereço → produto/LPN → quantidade;
quantidade ≠ sugerida exige motivo; produto `is_weight_variable` exige pesagem
por unidade/volume — job de balança fica `[LACUNA: DOC-11]`, aceite peso
manual com permissão `EXP.PESO_MANUAL` auditada; destino = posição de
consolidação em zona `PACKING`; idempotente por `operation_id` para offline),
**RN-EXP-032 [INVIOLÁVEL] — corte:** abre `EXP.CORTE_PICKING`, **bloqueia o
saldo divergente** (`BLOQUEIO` motivo `DIVERGENCIA`, serviço da 5A) e **cria
inventário `POR_ENDERECO` automático** para o endereço (a execução da contagem
é 5C — crie o documento de inventário e marque `[DEBITO: 5C executa]`);
decisão: re-seleção via `StockSelectionService` (nova tarefa) OU corte
definitivo com notificação ao cliente. Etapa permanece VERMELHA enquanto
pendente.
RN-EXP-033 (conclusão quando Σ separado + Σ cross-dock + Σ cortes = Σ pedido,
sem exceções pendentes; cortes definitivos saem do pedido e ficam registrados
para o OTIF do DOC-10).

### 3. Packing (§4.5)
RF-EXP-040: formação de Volumes com LPN (serviço da 2B), tipo de embalagem com
tara (`EXP.EMBALAGENS_VOLUME`), conteúdo declarado por leitura. **A etapa só
conclui com conteúdo total EXATAMENTE igual ao separado** — nem mais, nem
menos, com a diferença listada quando divergir. Etiqueta de volume enfileirada
(`[LACUNA: DOC-11]` para o ZPL), com pedido, sequência `n/N` e destinatário.

### 4. Pesagem (§4.6)
RF-EXP-050 (peso por volume; balança via Edge Agent fica `[LACUNA: DOC-11]` —
aceite entrada manual com `EXP.PESO_MANUAL` + motivo, auditada, gravando a
origem do peso),
**RN-EXP-051 [INVIOLÁVEL] — tolerância:** `EXP.TOLERANCIA_PESO_PCT` (padrão 2%)
sobre o Peso Teórico (Σ qty × `gross_weight_kg` + tara). Fora da faixa abre
`EXP.DIVERGENCIA_PESO` bloqueando o volume; decisão: aceitar o lido com motivo
OU devolver o volume ao packing (estorno da volumação daquele volume apenas).
Produtos `is_weight_variable` usam o peso apurado no picking como teórico.
**Teste de regressão permanente (exemplo normativo):** 10 UN × 1,200 kg +
tara 0,350 = 12,350 kg; tolerância 2% → faixa 12,103–12,597; leitura 12,480 →
aprovado; 12,900 → exceção. Aritmética decimal, não float.

### 5. Expedição, carregamento e saída (§4.7)
RF-EXP-060 (consolidação em staging `DISPATCH` por leitura; disparo dos
gatilhos fiscais conforme `fiscal_mode` — **a emissão e a alocação por nota
são do DOC-08**: implemente o ponto de integração e, enquanto não existir,
`fiscal_mode = INTEGRADO_ERP` conclui a etapa com confirmação manual
registrada e `EMISSAO_PROPRIA`/`HIBRIDO` ficam bloqueados com
`[LACUNA: DOC-08]` explícito na etapa — nunca conclua sem documento),
RF-EXP-061 (carregamento com leitura de cada Volume; **volume estranho à carga
é recusado no ato identificando o pedido de origem**; conclusão efetiva
`SAIDA_EXPEDICAO` — baixa definitiva do saldo via serviço único),
RF-EXP-062 (Saída conclui pelo gate-out do DOC-03 (RN-POR-040) — integre os
dois módulos; `Fim` automático, pedido `COMPLETED`, evento
`expedicao.pedido_concluido`).

### 6. Estornos pendentes (§4.8) — fecha o `[DEBITO: 6B]` da 6A
Implementar os quatro estornos que hoje recusam, com **atomicidade** (nunca
parcial), conforme a tabela RN-EXP-070:
- Picking: tarefas de devolução dirigida com dupla leitura, reservas
  recompostas;
- Embalagem: volumes desfeitos (LPNs cancelados), conteúdo volta à consolidação;
- Pesagem: pesos invalidados (sem exceção exigida);
- Carregamento: volumes descarregados por leitura, `SAIDA_EXPEDICAO` revertida
  (exige `EXP.ESTORNO_POS_FISCAL`, 2 passos; o cancelamento fiscal em si é
  `[LACUNA: DOC-08]`).
Estorno após `GATE_OUT` continua PROIBIDO (já implementado na 6A).

### 7. Testes de integração (cenários do DOC-06 §6 desta parte)
Corte bloqueia saldo e agenda contagem; re-seleção após corte aprovado; packing
valida conteúdo exato; **tolerância de pesagem (exemplo normativo)**; volume
estranho no carregamento; estorno de carregamento desfaz a baixa integralmente;
+ picking com dupla leitura rejeitando endereço divergente; conclusão do pedido
publicando o evento; ciclo COMPLETO ponta a ponta (pedido → liberação →
picking → packing → pesagem → expedição → carregamento → gate-out → COMPLETED)
como **teste de MARCO**.
+ Regressão: todas as suítes anteriores verdes (215+).

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-6B-relatorio.md` com
matriz requisito → arquivo → teste, lacunas, débitos, e uma seção declarando o
estado do ciclo ponta a ponta (o teste de MARCO).

## FORA DE ESCOPO
Emissão de NF-e e alocação fiscal por nota (DOC-08); painel e KPIs (DOC-10);
execução de inventário (5C); telas de coletor (DOC-15); drivers de balança e
impressora (DOC-11); e tudo do DOC-06 §8 (TMS, roteirização, cubagem de carga,
voice picking, put-wall, etiquetas de transportadora, batch picking com sorting).
