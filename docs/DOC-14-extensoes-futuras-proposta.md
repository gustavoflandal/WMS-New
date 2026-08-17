# DOC-14 — EXTENSÕES FUTURAS (PROPOSTA)
## Assistente de IA Local para Operadores · Workflow Dinâmico com Construtor Visual

| Metadado | Valor |
|---|---|
| Código do documento | DOC-14 |
| Versão | 0.1.0 (RASCUNHO DE PROPOSTA) |
| Status | **PROPOSTA — NÃO IMPLEMENTAR. Este documento NÃO autoriza geração de código.** |
| Data | 2026-08-16 |
| Pré-requisito de execução | MARCO atingido (sistema demonstrável: DOC-03/04/05/06/10 em produção-piloto) |
| Precedência | Subordinado ao DOC-00. Em conflito, o DOC-00 vigente PREVALECE até emenda formal. |

---

## 0. INSTRUÇÃO PARA A IA GERADORA

```
INSTRUÇÃO-IA-DOC14: Este documento descreve funcionalidades FUTURAS.
É PROIBIDO implementar qualquer item daqui durante as sessões dos
DOC-01 a DOC-13. Referências a este documento em código = erro.
A promoção deste documento para "APROVADO" exige: (a) emenda formal
do DOC-00 nos pontos listados em §1.3 e §2.3; (b) versão 1.0.0 deste
documento com requisitos no padrão do DOC-00 §7.
```

---

# PARTE 1 — ASSISTENTE DE IA LOCAL PARA OPERADORES

## 1.1 Visão

Um assistente conversacional embutido no chat operacional existente (DOC-10
§4.4), executando **modelo de linguagem local** (on-premises, na rede do
armazém ou em servidor central do operador), para auxiliar operadores em
tarefas do dia a dia: consultar procedimentos, interpretar erros do sistema,
localizar saldos e documentos, orientar sobre o próximo passo de um fluxo,
responder dúvidas sobre regras (FEFO, segregação, prazos fiscais) citando a
especificação.

**Motivação para IA local (não API externa):** dados operacionais e pessoais
de clientes 3PL não saem do perímetro do operador (LGPD, contratos de
confidencialidade); operação continua funcional sem internet; custo por
consulta zero após o investimento em hardware.

## 1.2 Princípios de projeto (herdam força de regra quando aprovado)

**P1-IA — Assistente CONSULTA, nunca OPERA [proposta de regra inviolável]**
O assistente NÃO executa nenhuma ação de negócio: não conclui etapas, não
aprova exceções, não movimenta estoque, não emite documentos. Esta é a
extensão natural da RN-PAI-031 (chat não aciona operações), que permanece
válida. Toda resposta que envolva ação termina indicando ONDE o operador
executa a ação na interface — nunca executando por ele.

**P2-IA — Respostas ancoradas, nunca inventadas**
O assistente responde com base em RAG (retrieval-augmented generation) sobre
fontes controladas: os documentos DOC-00 a DOC-13, procedimentos operacionais
do armazém (POPs cadastrados), e consultas SOMENTE-LEITURA ao sistema via a
API existente. QUANDO a resposta depender de dado do sistema, o assistente
DEVE citar a fonte (documento §, ou o registro consultado). QUANDO não houver
fonte, DEVE dizer que não sabe — é PROIBIDO responder regra de negócio "de
memória" do modelo.

**P3-IA — Mesmo RBAC, mesma RLS, mesma auditoria**
As consultas do assistente ao sistema executam COM O TOKEN DO OPERADOR
autenticado: ele só enxerga o que o operador enxerga (RN-SEG-011, RG-001).
Perguntas e respostas são registradas (nova ação de auditoria `AI_QUERY`),
com retenção própria. Dados pessoais mascarados para o operador permanecem
mascarados para o assistente (RN-SEG-051).

**P4-IA — Transparência**
Toda resposta é identificada visualmente como gerada por IA, com aviso
permanente de que pode conter erros e de que decisões operacionais seguem os
fluxos formais.

## 1.3 Emendas necessárias ao DOC-00 (pré-condição)

| Ponto | Emenda |
|---|---|
| §2.2 Stack congelada | Adicionar o runtime de inferência local (ex.: Ollama ou vLLM servindo modelo aberto quantizado) e um banco vetorial (pgvector, mantendo PostgreSQL) como componentes autorizados. Sem emenda, a implementação viola a stack congelada. |
| DOC-10 RN-PAI-031 | Estender: "mensagens do assistente de IA seguem as mesmas proibições" + nova regra P1-IA. |
| DOC-12 §4.4 | Nova ação de auditoria `AI_QUERY` no enum da RD-SEG-030. |
| DOC-12 §4.6 LGPD | Incluir o tratamento "consultas ao assistente" no inventário, com base legal e retenção. |

## 1.4 Arquitetura proposta (alto nível)

```
Coletor/Desktop → chat existente (sala "assistente", 1 por usuário)
      → backend: módulo `assistente` (novo módulo NestJS)
          → RAG: pgvector (embeddings dos DOC-* e POPs, reindexação por versão)
          → Ferramentas somente-leitura: consultas tipadas à API interna
            (saldo por SKU, situação de pedido/fluxo, validade de lote,
             fila de pátio) — catálogo FECHADO de ferramentas
          → Inferência: serviço local (GPU) via API interna, com fila e
            timeout; SEM chamadas a provedores externos
```

- **Catálogo fechado de ferramentas:** cada ferramenta declara a permissão
  RBAC exigida e é somente-leitura por construção (mesma disciplina do
  deny-por-omissão RN-SEG-012).
- **Hardware de referência (a validar):** 1 GPU de 24 GB atende dezenas de
  operadores simultâneos com modelo 7–14B quantizado; dimensionamento real é
  fase 0 do projeto.

## 1.5 Casos de uso da versão 1 (escopo fechado)

| # | Caso | Exemplo |
|---|---|---|
| UC-1 | Dúvida de procedimento | "Como registro uma avaria na conferência?" → resposta citando DOC-04 RN-REC-022/023 + caminho na tela |
| UC-2 | Interpretação de erro | "O que significa FLOW_STEP_ORDER_VIOLATION?" → explica RG-002 e indica a etapa pendente do documento em questão |
| UC-3 | Consulta operacional | "Onde tem saldo do SKU X com validade acima de 90 dias?" → consulta somente-leitura com RLS do operador |
| UC-4 | Próximo passo | "O que falta no pedido PED-SP01-00001234?" → lê o fluxo e lista a primeira etapa pendente |
| UC-5 | Regra fiscal/estoque | "Posso expedir o lote L-9 que vence em 30 dias?" → calcula shelf life pela RN-EST-012 e cita o resultado |

**Fora de escopo da v1:** geração de documentos, sugestões de otimização de
layout, previsões, voz, qualquer escrita.

## 1.6 Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Alucinação de regra de negócio | P2-IA (RAG obrigatório + "não sei" + citação de fonte); avaliação automatizada com perguntas-gabarito derivadas dos exemplos normativos dos DOC-* |
| Vazamento entre tenants via assistente | P3-IA (token do operador, RLS intacta); testes de isolamento específicos |
| Operador seguir orientação errada | P4-IA + P1-IA (a ação formal continua nos fluxos com suas validações — o sistema rejeita o que for inválido, como sempre) |
| Custo de hardware subestimado | Fase 0 de PoC com medição de latência/throughput antes de compromisso |

## 1.7 Fases

- **F0 — PoC (1 sessão):** runtime local + RAG sobre os DOC-*; 20 perguntas-
  gabarito; medir latência e acerto. Sem integração ao sistema.
- **F1 — Consulta de especificação (UC-1/UC-2):** chat integrado, sem
  ferramentas de sistema.
- **F2 — Ferramentas somente-leitura (UC-3/4/5):** catálogo fechado + RBAC +
  auditoria `AI_QUERY`.
- **F3 — POPs do armazém:** ingestão de procedimentos próprios por armazém.

---

# PARTE 2 — WORKFLOW DINÂMICO COM CONSTRUTOR VISUAL

## 2.1 Visão

Permitir que o operador logístico **configure os Fluxos Operacionais por
cliente × armazém × tipo de documento**, em uma tela de construção visual
(arrastar-e-soltar), em vez das sequências fixas hoje especificadas
(RF-REC-020 para recebimento; RN-EXP-010 para expedição). Exemplos de uso
real: cliente que dispensa a etapa de Pesagem; armazém que insere uma etapa
"Fumigação" entre Descarga e Conferência; fluxo de reversa com etapa extra de
"Laudo fotográfico".

## 2.2 O que NÃO muda (invariantes preservados)

A RG-002 permanece INVIOLÁVEL e é o contrato que o construtor deve respeitar,
não substituir:

1. Sequência estrita: verde/vermelho, apenas a primeira pendente acionável,
   sem salto de etapas (interface E API);
2. Exceções mantêm efeito suspensivo (RN-SEG-042);
3. Estornos continuam por etapa, com o custo crescente definido (RN-EXP-070);
4. O painel (DOC-10) renderiza qualquer fluxo, fixo ou dinâmico, do mesmo jeito.

**O que muda:** a ORIGEM da sequência — de código fixo para um TEMPLATE
versionado e validado.

## 2.3 Emendas necessárias ao DOC-00/DOC-12 (pré-condição)

| Ponto | Emenda |
|---|---|
| DOC-12 §8 (fora de escopo) | Remover "Motor de workflow genérico configurável pelo usuário final" do fora-de-escopo — é exatamente o que esta parte introduz. Emenda MAJOR. |
| DOC-06 RN-EXP-010 / DOC-04 RF-REC-020 | Passam a definir os TEMPLATES PADRÃO (imutáveis, de fábrica) em vez da sequência única. Emenda MAJOR dos dois documentos. |
| DOC-00 §4.5 | Novos termos: Template de Fluxo (`flow_template`), Etapa Obrigatória (`mandatory_step`), Etapa Customizada (`custom_step`). |

## 2.4 Modelo conceitual

**`flow_template`** (TENANT ou padrão de fábrica)
- tipo de documento (`INBOUND_ORDER`, `OUTBOUND_ORDER`, `RETURN_ORDER`,
  `TRANSFER`), cliente (NULL = padrão do armazém), armazém, versão, status
  (`DRAFT` → `PUBLISHED` → `RETIRED`).
- **Imutabilidade por versão:** template `PUBLISHED` nunca é editado; edição
  gera nova versão. Documento em andamento conclui no template com que nasceu
  (sem migração de fluxo em voo na v1).

**`flow_template_step`**
- ordem, nome de exibição, tipo:
  - `SYSTEM_STEP` — etapa executável do sistema (Picking, Pesagem, Expedição
    fiscal...), vinculada a um HANDLER do catálogo fechado de etapas
    implementadas; carrega suas pré-condições e efeitos originais;
  - `CUSTOM_CHECKLIST` — etapa criada pelo usuário: checklist com itens
    (texto, foto obrigatória, leitura de código, assinatura de permissão),
    concluída manualmente por operador com a permissão configurada;
- flags: `mandatory` (não removível), `skippable_by_exception` (pulável
  somente via workflow de aprovação — nunca por clique).

**Regras de validação do construtor [propostas de regra inviolável]:**

- **V1 — Etapas obrigatórias por lei/integridade não podem ser removidas nem
  reordenadas para depois de seus dependentes:** para `OUTBOUND_ORDER` com
  cliente de emissão própria: `Expedição (fiscal)` antes de `Carregamento`
  antes de `Saída` (RG-014/RN-POR-040); `Conferência` obrigatória em
  recebimento e reversa (base das divergências); `Saída` sempre final.
  O catálogo de obrigatoriedades por tipo de documento é FECHADO e definido
  na promoção deste documento.
- **V2 — Toda `SYSTEM_STEP` presente carrega suas pré-condições originais:**
  incluir "Pesagem" traz a RN-EXP-051 junto; não existe "Pesagem sem
  tolerância".
- **V3 — Publicação exige simulação:** o construtor valida o grafo (linear na
  v1 — sem ramos/paralelismo) e executa uma simulação de ciclo completo antes
  de permitir `PUBLISHED`.
- **V4 — Publicar template é operação auditada e com permissão sensível**
  (`FLX.TEMPLATE_PUBLICAR`), com alçada de 2 aprovadores quando remover etapa
  de um template em uso.

## 2.5 Tela de construção (requisitos de UX)

- Lista vertical de etapas (a mesma metáfora visual do fluxo verde/vermelho
  do painel — o usuário monta exatamente o que o operador verá);
- Arrastar para reordenar; paleta lateral com as `SYSTEM_STEP` disponíveis
  para o tipo de documento e o botão "nova etapa de checklist";
- Etapas `mandatory` exibidas com cadeado, arrastáveis apenas dentro dos
  limites válidos (V1) — o construtor IMPEDE o arranjo inválido em vez de
  só avisar depois;
- Diff visual entre versões do template; botão "simular" (V3);
- Acessibilidade RG-013 (não só cor; teclado).

## 2.6 Compatibilidade com o já construído

- `operation_flow`/`flow_step` (RD-EXP-002) já são instâncias genéricas —
  o modelo atual foi desenhado para isso; a mudança principal é a FÁBRICA de
  instâncias passar a ler o template publicado aplicável (cliente → armazém →
  padrão de fábrica, nesta ordem de resolução).
- KPIs do DOC-10 que citam etapas (K-02, K-03, K-07) passam a referenciar
  etapas por HANDLER (`SYSTEM_STEP`), não por posição — etapas customizadas
  não quebram os KPIs, apenas não entram neles.
- Faturamento (DOC-09): etapas customizadas PODEM ser tarifáveis como
  `SRV_OUTROS` — decisão a tomar na promoção.

## 2.7 Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Usuário montar fluxo ilegal (sem fiscal antes da saída) | V1 com catálogo fechado de obrigatoriedades imposto pelo construtor E pelo backend na publicação |
| Explosão de variações impossíveis de suportar | v1 restrita a fluxo LINEAR, sem ramos nem paralelismo; limite de N etapas customizadas por template (parâmetro) |
| Documento em voo durante troca de template | Imutabilidade por versão: documento conclui no template de nascimento |
| Divergência painel × template | Renderização do painel lê exclusivamente a instância `flow_step` — nenhuma lógica duplicada |

## 2.8 Fases

- **F0 — Emendas formais** (DOC-00/04/06/12) + catálogo de etapas obrigatórias
  por tipo de documento — trabalho de ESPECIFICAÇÃO, sem código.
- **F1 — Motor:** `flow_template` + fábrica de instâncias lendo template;
  templates de fábrica reproduzindo EXATAMENTE os fluxos atuais (prova: toda a
  suíte de testes existente permanece verde sem alteração).
- **F2 — Etapas `CUSTOM_CHECKLIST`** com permissão e auditoria.
- **F3 — Tela de construção visual** (drag-and-drop, validação V1–V3, diff,
  simulação).
- **F4 — Tarifação de etapas customizadas** (decisão DOC-09).

---

## 3. ORDEM RECOMENDADA E DEPENDÊNCIAS ENTRE AS DUAS EXTENSÕES

1. Ambas exigem o MARCO atingido — não desviar sessões antes disso.
2. **Workflow dinâmico primeiro** (Parte 2): é extensão direta do núcleo já
   construído e destrava valor comercial imediato (personalização por cliente
   é argumento de venda 3PL). O assistente (Parte 1) se beneficia de vir
   depois: com os templates existindo, ele também responde "qual é o fluxo
   DESTE cliente".
3. A F1 da Parte 2 tem um teste de ouro embutido: os templates de fábrica
   reproduzem os fluxos atuais com a suíte inteira verde — refatoração sem
   regressão comprovada.

## 4. O QUE ESTE DOCUMENTO NÃO DECIDE (aberto para a promoção a v1.0.0)

- Modelo de linguagem específico, tamanho e hardware (F0 da Parte 1 decide).
- Se etapas customizadas entram no faturamento (§2.6).
- Ramificação/paralelismo de fluxo (explicitamente adiado; avaliar após 6
  meses de uso da v1 linear).
- Migração de fluxo em voo entre versões de template (adiado; imutabilidade
  por versão cobre a v1).

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 0.1.0 | 2026-08-16 | Rascunho de proposta — assistente IA local e workflow dinâmico |
