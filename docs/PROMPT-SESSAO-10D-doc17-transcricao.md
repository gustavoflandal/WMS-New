# PROMPT — Sessão 10D: DOC-17 §8 — Transcrição de Formulário de Campo

**Carregar**: DOC-00 (RG-003, RG-009, RG-011) + DOC-17 §8 completo
(RF-TEL-030, RN-TEL-031/032/033, RF-TEL-034), §9.1/§9.2 (máquinas de estado),
§4 (permissões e exceções TEL.*) e os cenários Gherkin de §10 sobre
transcrição + `docs/relatorios/SESSAO-10B-relatorio.md` (Formulário de Campo,
que esta sessão consome).

## Por que esta é a próxima, e não Execução por Tela (§6)

Sem §8 a entrega da 10B fica pela metade: o sistema **emite** o Formulário de
Campo e **nunca registra o que voltou do campo**. O rodapé do próprio
formulário diz "deve retornar para digitação" (RF-TEL-020) e não há para onde
digitar — mesma forma de beco sem saída que a auditoria REVISÃO-01 encontrou
no transbordo. Execução por Tela (§6) é independente disso e vem depois.

## Decisões de implementação

1. **Paridade real, não reimplementação (RN-TEL-011 [INVIOLÁVEL])**: a
   transcrição de uma linha de putaway chama
   `PutawayTaskService.executeTask()` — exatamente o mesmo serviço de domínio
   que o coletor chama. Ganha de graça a dupla validação de leitura
   (LPN + endereço), o override de RN-REC-041, o crédito de saldo pelo
   serviço único de movimentação e a idempotência de RNF-ARQ-050. É PROIBIDO
   criar caminho alternativo de efeito.
2. **A chave de idempotência da linha É a chave da operação**: RN-TEL-031
   item 1 manda gerar `form_line_id` na emissão (feito na 10B); esta sessão
   o usa como `operationId` de `executeTask`. Logo, reenviar a transcrição
   não duplica movimentação **pelo mecanismo que já existia**, sem inventar
   um segundo controle de idempotência.
3. **`origin = PAPEL`** (RN-TEL-012 item 3): `executeTask` fixava
   `origin: 'PWA'`. Passa a aceitar a origem do chamador (padrão `PWA`,
   preservando o coletor). O valor `PAPEL` foi adicionado ao enum do
   `audit_log` na migration 0076 (REVISÃO-01), já antecipando isto.
4. **Tarefa reservada por formulário e a guarda da 10B**: `assignTask`
   rejeita tarefa com `field_form_id` ("outro canal"). A transcrição NÃO é
   outro canal — é o canal daquele formulário. `assignTask` passa a aceitar
   `viaFieldFormId`, e só libera quando bate com o `field_form_id` da própria
   tarefa. A guarda continua valendo para todos os demais.
5. **`field_form.declared_executor_user_id`** (novo, anulável): RN-TEL-032
   fala em "o **usuário** que consta como executante", mas a 10B só gravava
   `declared_executor_name` (texto impresso no papel). Sem o vínculo com um
   usuário real a segregação de funções é inaplicável — a coluna existe para
   tornar a regra verificável. Quando nula (executante não é usuário do
   sistema), não há segregação a aferir e isso fica registrado na
   transcrição.
6. **Escopo de aplicação = PUTAWAY**: a 10B só ligou Putaway (T-P1) a uma
   tabela de tarefa real. A transcrição é genérica (linhas polimórficas), mas
   **aplica** apenas linhas `task_entity = 'putaway_task'`; linha de tipo sem
   hook real é rejeitada com erro determinístico, não silenciosamente
   ignorada. Mesmo `[DEBITO: 10B]` já registrado.
7. **Dupla digitação (RF-TEL-034)** vale para CONTAGEM e CONFERENCIA — que
   ainda não têm hook de tarefa. A regra é implementada como função pura
   testada e **exigida no serviço** para esses tipos; para PUTAWAY o próprio
   requisito não a exige. Fica correta onde se aplica, em vez de ser adiada
   inteira.
8. **Divergência (RN-TEL-033)**: linha cujo endereço difere do sugerido é
   tratada pelo módulo de origem — `executeTask` já exige
   `EST.PUTAWAY_OVERRIDE` + motivo (RN-REC-041). A transcrição não afrouxa
   nem duplica isso: repassa o motivo digitado e deixa o serviço decidir. É
   a leitura literal de "segue as regras do módulo de origem".

## Fora do escopo desta sessão

Execução por Tela inteira (§6: RN-TEL-010/011/012, RF-TEL-013, as 8 telas
T-P1..T-P8, `execution_channel`); frontend da tela de transcrição (backend
primeiro, mesmo padrão de DOC-06/DOC-07/10A); hook de tarefa real para os 5
tipos de formulário além de Putaway.

## Critérios de aceite

Cenários Gherkin do DOC-17 §10 aplicáveis: "Transcrição é idempotente",
"Linha de tarefa já concluída por outro canal é descartada" e "Segregação na
transcrição". "Dupla digitação em contagem" coberta em teste unitário da
função pura (o tipo CONTAGEM ainda não tem hook de aplicação).

DoD padrão do CLAUDE.md.
