# PROMPT — Sessão 10B: DOC-17 Parte B (fatia 1) — Formulário de Campo

**Carregar**: DOC-00 (RG-002, RG-003, RG-009, RG-013) + DOC-17 completo (objeto
desta sessão: §3 termos, §4 permissões/exceções, §7 Formulário de Campo
completo, §9.1 máquina de estados, Gherkin §10 cenários "Emissão...", "Cancela­
mento...", "Formulário de inventário não imprime saldo") + `docs/relatorios/
SESSAO-10A-relatorio.md` §5 (débito que esta sessão fecha parcialmente).

## Por que subdividir a Parte B de novo

A 10A já apontou (comentário da migration 0073 e §5 do relatório) que toda a
Parte B — Execução por Tela (§6), Formulário de Campo (§7), Transcrição (§8)
— ficaria para "10B". Na prática são 3 subsistemas com máquinas de estado,
tabelas e regras [INVIOLÁVEL] próprias, cada um do tamanho de uma sessão
inteira. Mesma lógica que separou 9A/9B e 10A/10C: cortar pela costura que o
próprio documento já desenha (§6/§7/§8), não por estimativa arbitrária.

**Escopo desta sessão (10B)**: só §7 (Formulário de Campo) — RF-TEL-020 a
RF-TEL-024, RN-TEL-021, RN-TEL-023, RD-TEL-001/002. **Transcrição (§8) fica
para uma sessão seguinte** (o campo de emissão faz sentido isolado: um
formulário emitido e nunca transcrito ainda é um estado real do sistema —
`EMITIDO`/`EXPIRADO`/`CANCELADO`/`SUBSTITUIDO`, todos anteriores a qualquer
transcrição). **Execução por Tela (§6, RN-TEL-010/011/012, telas T-P1..T-P8)
também fica para depois** — depende conceitualmente de `execution_channel`
(RD-TEL-004), que esta sessão não cria porque só faz sentido junto da
Transcrição (que é quem grava `origin = PAPEL`) e da tela (`origin = WEB`).

## Decisões de implementação

1. **Só a operação Putaway (T-P1/RF-TEL-022 linha "Putaway") é ligada de
   ponta a ponta a uma tabela de tarefa real** (`wms.putaway_task`) nesta
   sessão — reserva de tarefa na emissão (RN-TEL-021), exclusão da fila do
   coletor/tela (`putaway-task.service.ts::listQueue`), liberação no
   cancelamento/expiração. Escolhida por ser a tarefa mais simples e mais
   isolada (sem motor de onda/rota como Picking, sem cegueira dupla como
   Contagem). As outras 5 linhas do catálogo RF-TEL-022 (Picking, Conferência,
   Contagem, Reposição/Transferência, Carregamento) têm o `form_type`
   aceito pelo schema e a função de conteúdo (§7) implementada e testada de
   forma isolada, mas **sem** o hook de reserva contra a tabela de tarefa
   real — `[DEBITO: 10B]`, ver relatório §8.
2. **`wms.field_form` / `wms.field_form_line` genéricas e polimórficas** —
   mesmo padrão de `operation_flow`/`operation_flow_step` (`entity` texto +
   `entity_id` uuid) em vez de uma FK fixa por tipo de tarefa, porque o
   catálogo RF-TEL-022 já lista 6 tipos de origem diferentes e adicionar uma
   tabela nova para cada um replicaria a mesma tensão que motivou o padrão
   polimórfico do Fluxo Operacional.
3. **Numeração `FRM-<ARMAZÉM>-<SEQ8>` (RN-DAD-040)**: reaproveita
   `DocumentNumberingService` — adiciona `FIELD_FORM: 'FRM'` ao mapa de
   prefixos existente, mesma sequência atômica `document_sequence` já usada
   por todos os outros documentos numerados do sistema. Não inventa
   numeração própria.
4. **PDF via `pdf-lib`** (já é dependência do projeto — `DanfeService`,
   DOC-08/8B, é o precedente direto): mesmo padrão (`PDFDocument.create()`,
   página A4, `drawText` linha a linha, upload via `FileStorageService`).
   **Código de barras Code 128** (obrigatório, RF-TEL-020): não há biblioteca
   de barcode no projeto; em vez de adicionar uma dependência nova para um
   único símbolo 1D, implementa um codificador Code 128 (subconjunto B,
   checksum mod 103, start/stop) em `code128.util.ts`, testado contra vetores
   de referência conhecidos, e desenha as barras como retângulos via
   `page.drawRectangle` — mesma técnica de "desenho vetorial simples" que o
   `DanfeService` já usa para texto.
5. **Entrega do PDF**: só por download (`GET .../field-formularios/:id/pdf`),
   não por `PeripheralJobService.createJob` (`PRINT_PDF`) — aquele fluxo
   exige `edgeAgentId`/`peripheralDeviceId`/`deviceCode` de uma impressora já
   registrada, e a spec permite explicitamente "impresso... ou baixado"
   (RF-TEL-020). Acoplar a um dispositivo específico exigiria uma tela de
   seleção de impressora fora do escopo desta sessão — `[DEBITO: 10B]`.
6. **Reemissão (RF-TEL-024)**: mesma convenção de marca `RE1`, `RE2`... já
   usada pelas etiquetas (RF-PER-021, DOC-11) — campo `reissue_seq INT
   DEFAULT 0` em `field_form`, incrementado a cada reemissão e impresso no
   PDF como sufixo do número.
7. **Expiração (RN-TEL-021 "expiração... devolve as tarefas")**: verificação
   **lazy**, não scheduler novo — ao consultar ou ao tentar transcrever um
   formulário `EMITIDO` cuja validade (`TEL.FORMULARIO_VALIDADE_H`, padrão
   12h) já passou, o service transiciona para `EXPIRADO` e libera as tarefas
   na mesma leitura (mesmo padrão já usado para expiração de agendamento de
   pátio, DOC-03). Evita introduzir mais um job de scheduler para esta
   sessão; se o volume de formulários provar isso insuficiente, é debito
   documentado.
8. **Permissões desta sessão**: só `TEL.FORMULARIO_EMITIR`,
   `TEL.FORMULARIO_REEMITIR`, `TEL.FORMULARIO_CANCELAR` (as 3 que têm
   chamador real). `TEL.EXECUCAO_TELA`, `TEL.TRANSCREVER*`,
   `TEL.MODO_EXECUCAO_CONFIGURAR` ficam para as sessões de Execução por Tela
   e Transcrição — mesmo cuidado de "não declarar permissão sem chamador"
   já seguido em 10A (comentário da migration 0073).

## Fora do escopo desta sessão

Transcrição inteira (§8: RF-TEL-030, RN-TEL-031/032/033, RF-TEL-034),
Execução por Tela inteira (§6: RN-TEL-010/011/012, RF-TEL-013, `execution_
channel`), reserva real de tarefa para os 5 tipos de formulário além de
Putaway, impressão via Edge Agent (só download nesta sessão), scheduler
dedicado de expiração.

## Critérios de aceite

Gherkin §10 aplicáveis: "Emissão de formulário reserva as tarefas",
"Cancelamento devolve as tarefas", "Formulário de inventário não imprime
saldo" (RN-TEL-023 — testado no gerador de conteúdo, mesmo sem hook de
reserva real para Contagem). Os demais (transcrição, segregação, dupla
digitação, digitação de código, paridade) são de sessões seguintes.

DoD padrão do CLAUDE.md.
