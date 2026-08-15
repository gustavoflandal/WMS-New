# PLANO DE EXECUÇÃO ECONÔMICA — WMS ENTERPRISE 3PL
## Conclusão do projeto com orçamento restrito

| Item | Valor |
|---|---|
| Documento | PLANO-EXEC |
| Versão | 1.0 |
| Data | 2026-08-15 |
| Premissa | Especificação COMPLETA (14 documentos). Resta implementação. |

---

## 1. PRINCÍPIO ORIENTADOR

A especificação já contém todo o raciocínio difícil: regras invioláveis, algoritmos
determinísticos, exemplos normativos e critérios de aceite. A implementação é, em
sua maior parte, **tradução mecânica de documento para código** — e tradução
mecânica não exige o modelo mais caro. O modelo premium fica reservado para os
poucos pontos de lógica densa e para depuração difícil.

---

## 2. REGRAS DE ECONOMIA (aplicar em TODA sessão)

### R1 — Contexto mínimo por sessão [a regra que mais economiza]
Cada sessão recebe SOMENTE:
- `DOC-00` (mestre — sempre);
- o documento do módulo da sessão;
- os relatórios das 2 sessões anteriores (não todos);
- os deltas de dados explicitamente citados.
**Nunca** carregar os 14 documentos. Custo de contexto é pago em CADA mensagem
da sessão — contexto inflado multiplica o custo por 10.

### R2 — Sessão curta, commit frequente
Máximo ~20 mensagens por sessão. Ao atingir o Definition of Done: commit, feche a
sessão, abra nova. Sessão longa reprocessa todo o histórico a cada mensagem.

### R3 — Diagnóstico humano antes de diagnóstico pago
Erros de build, dependência, import e configuração: leia a mensagem de erro você
mesmo primeiro. Se a causa for óbvia (host errado, pacote faltando, caminho),
corrija direto ou já entregue a causa no prompt. Pagar iterações de "diagnostique
e tente" em problema de infraestrutura é o maior vazamento identificado até agora.

### R4 — Prompt diretivo, não exploratório
Diga O QUE fazer e COMO validar, não "analise e proponha". Cada rodada de proposta
+ discussão + implementação custa 3× a implementação direta.

### R5 — Testes primeiro, mas só os do documento
Os cenários Gherkin já estão escritos nos documentos. Mande convertê-los
literalmente. É PROIBIDO a IA inventar suítes extensas de testes próprios
(gera tokens e manutenção sem valor especificado).

### R6 — Sem refatoração não solicitada
Incluir em todo prompt: "não refatore código existente que passa nos testes".

---

## 3. ALOCAÇÃO DE MODELO POR SESSÃO

Legenda: **ECONÔMICO** = modelo mais barato disponível (Haiku); **MÉDIO** = Sonnet;
**PREMIUM** = Opus/Fable, apenas quando indicado.

| # | Sessão | Escopo | Modelo | Justificativa |
|---|---|---|---|---|
| 1.6 | Fechar testes DOC-01 | análise das 21 falhas, migrations no setup de teste | ECONÔMICO | correção mecânica com causa já mapeada |
| 1.5 | Workers + rate limit | outbox-publisher, realtime-fanout, 429 | MÉDIO | concorrência entre réplicas exige cuidado |
| 2A | DOC-02 migrations (parte 1) | organização, estrutura física, endereços | ECONÔMICO | DDL a partir de dicionário de dados pronto |
| 2B | DOC-02 migrations (parte 2) | produtos, espécies, lotes, LPN, saldos, numeração | MÉDIO | LPN Mod-10, CHECKs de saldo, RLS por tabela |
| 3 | DOC-12 RBAC + auditoria | permissões, deny-por-omissão, exceções, audit_log | MÉDIO | segurança: erro aqui é caro |
| 4A | DOC-04 caminho feliz | ordem de recebimento, conferência simples, putaway | MÉDIO | — |
| 4B | DOC-04 motor de putaway | Fase 1 filtros + Fase 2 ranqueamento | **PREMIUM** | algoritmo denso, exemplo normativo |
| 5A | DOC-05 saldos e movimentações | catálogo de movimentações, bloqueios, transferências | MÉDIO | — |
| 5B | DOC-05 seleção de saldo | FEFO/FIFO/LIFO/JIT, shelf life, matriz de espécies | **PREMIUM** | núcleo lógico do WMS |
| 6A | DOC-06 fluxo + pedido | máquina de estados, liberação, reserva, navegação | **PREMIUM** | RG-002 é o coração do sistema |
| 6B | DOC-06 picking→carregamento | tarefas, packing, pesagem, carregamento | MÉDIO | — |
| 10 | DOC-10 painel + KPIs | painel de operações, tela do fluxo, agregados | MÉDIO | — |
| — | **MARCO: SISTEMA DEMONSTRÁVEL** | recebe, armazena, expede, com painel | — | — |
| 8 | DOC-08 fiscal | RG-014, NF-e, contingência | **PREMIUM** | risco fiscal/legal |
| 5C | DOC-05 inventários | 7 tipos, rodadas, ajustes | MÉDIO | — |
| 11 | DOC-11 periféricos | Edge Agent drivers, ZPL, balança | ECONÔMICO | protocolos bem especificados |
| 9 | DOC-09 faturamento | tarifação, snapshot, pré-fatura | MÉDIO | aritmética half-even validada |
| 7 | DOC-07 reversa | triagem, destinações, recall | ECONÔMICO | reutiliza módulos existentes |
| 13 | DOC-13 integrações | API pública, webhooks, reconciliação | MÉDIO | — |

**Se o orçamento acabar antes do fim:** pare no MARCO. Um WMS que recebe, armazena
e expede com painel é demonstrável e vendável; os módulos seguintes são
incrementos sobre uma base funcionando.

---

## 4. ORDEM DE PRIORIDADE (se precisar cortar)

**Indispensável (sem isso não há sistema):** 1.6, 1.5, 2A, 2B, 3, 4A, 5A, 6A, 6B, 10.
**Alto valor:** 4B (putaway), 5B (seleção de saldo) — sem eles o sistema funciona
com escolha manual de endereço/lote, aceitável em piloto.
**Pode esperar:** 8, 9, 7, 11, 13, 5C.

---

## 5. CONTROLE DE ORÇAMENTO

1. Antes de cada sessão: anote o saldo.
2. Depois de cada sessão: anote o consumo e o entregável.
3. Se uma sessão consumir mais que o dobro da anterior de porte similar,
   pare e investigue (quase sempre: contexto inflado ou sessão longa demais).
4. Consulte o painel de uso em console.anthropic.com e a página de preços
   (anthropic.com/pricing) — pode haver plano mais econômico que créditos avulsos
   para o seu padrão de uso.

---

## 6. TEMPLATE DE PROMPT ECONÔMICO

```markdown
# SESSÃO <n>: <título>
Contexto a carregar: docs/DOC-00.md, docs/DOC-<xx>.md, último relatório.
NÃO carregue outros documentos.

## Missão
<uma frase objetiva>

## Regras
- DOC-00 §1.2: [LACUNA] = informação ausente da ESPECIFICAÇÃO;
  [DEBITO: descrição + sessão-alvo] = dificuldade técnica adiada.
  Débito que bloqueia o Definition of Done NÃO pode ser adiado.
- Não refatore código existente que passa nos testes.
- Não crie testes além dos cenários Gherkin do documento.
- Referencie o ID do requisito em comentário no ponto de implementação.

## Entregáveis
<lista numerada e específica>

## Definition of Done
<comandos exatos que devem sair verdes>

## Fora de escopo
<lista explícita>
```
