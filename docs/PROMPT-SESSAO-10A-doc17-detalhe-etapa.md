# PROMPT — Sessão 10A: DOC-17 Parte A — Detalhe de Etapa (drill-down)

**Carregar**: DOC-00 (RG-002, RG-003, RG-013) + DOC-17 completo (só a Parte A
é objeto desta sessão: §2, §5, §9.2 tabela "Consulta/Execução/Previsão/
Bloqueada" e o Gherkin §10 cenários 1-2) + `docs/relatorios/SESSAO-9B-relatorio.md`
(estado atual do Fluxo Operacional/`return_order`).

## Por que Parte A / Parte B (o próprio DOC-17 já sugere)

DOC-17 §13 propõe explicitamente a alternativa "Parte A antes... Parte B na
posição acima" — Parte A é aditiva e somente-leitura sobre o que já existe;
Parte B é um subsistema novo inteiro (Formulário de Campo, Transcrição com
dupla digitação e idempotência, `execution_channel`, 8 telas de execução) com
risco e superfície muito maiores. Mesma lógica de separação que 9A/9B usou
para DOC-07.

**Escopo desta sessão (10A)**: só RF-TEL-001 a RF-TEL-004 (Parte A). RN-TEL-010
em diante (Parte B) fica para a 10B.

## Decisões de implementação

1. **Rota**: `GET /fluxo-operacional/:entity/:entityId/steps/:stepCode/detail`
   — MESMO prefixo do endpoint já existente (`OperationFlowController`,
   `core/operation-flow`), mas em controller/módulo NOVO e de camada de
   negócio (`modules/telas`), não dentro do `core`. Motivo: o contrato de
   detalhe precisa ler tabelas de `recebimento`/`expedicao`/`reversa`
   diretamente — um módulo `core` não pode depender de módulos de negócio
   (inverteria a direção de dependência estabelecida em todo o projeto).
   `TelasModule` importa `OperationFlowModule` (não o contrário).
2. **Acesso a dados por etapa**: SQL direto contra as tabelas de cada módulo
   (mesmo padrão já usado por `putaway-engine.service.ts` lendo
   `location`/`zone` fora do seu próprio domínio) — não injeta os SERVICES
   de outros módulos, só `DatabaseService` com o contexto de tenant. É
   leitura pura, sem efeito colateral; não precisa do aparato de
   validação/transação dos services de escrita.
3. **Modo da etapa (RN-TEL-002)** derivado 100% de `OperationFlowService.
   getFlowState()` (já existe, é o contrato usado pelo painel DOC-10) —
   nenhuma lógica de ordem/bloqueio duplicada:
   - `opens_read_only` (DONE) → **Consulta**
   - `is_blocked` → **Bloqueada por exceção**
   - `is_actionable` → **Execução**
   - nenhum dos três → **Previsão**
4. **"Ações disponíveis" é consultivo, não autoritativo** — mesmo espírito da
   resolução da RG-002 no próprio DOC-17 §2 ("a guarda de ordem permanece no
   serviço, não na interface"): a lista aqui é uma dica de UI (ex.:
   `ESTORNAR` quando a etapa está `DONE` e o módulo tem reversão conhecida),
   nunca a fonte de verdade — a chamada de mutação real sempre revalida.
5. **`return_order` entra na UNION do painel de operações** — achado durante
   a sessão: `operations-board.service.ts` tinha um comentário desatualizado
   dizendo "reversa não abre operation_flow ainda", mas a 9A já implementou
   `createFlow()` para `return_order` há duas sessões. Corrigido aqui por
   ser exatamente o mesmo tipo de leitura polimórfica que este contrato
   introduz.
6. **Catálogo de conteúdo por etapa (RF-TEL-003)**: implementado para as 16
   combinações reais de `step_code` que hoje existem nos 3 fluxos (`inbound_
   order`, `outbound_order`, `return_order`), incluindo a etapa dinâmica
   `DIVERGENCIAS` (inserida por `checking.service.ts::insertDynamicStep`).
   `FIM` não tem conteúdo específico (fluxo concluído).
7. **Visibilidade de executante (RF-PAI-020)**: parâmetro `hideExecutors`
   aceito pelo service (default `false`); nenhuma rota de portal chama isto
   ainda nesta sessão — quando o Portal do Cliente (DOC-16) existir, chama
   com `true`. Não é [LACUNA]: é o mesmo padrão de "campo aditivo pronto,
   sem chamador ainda" já usado em outras sessões.

## Fora do escopo desta sessão (Parte B / 10B)

Formulário de Campo (emissão, impressão via Edge Agent, PDF), Transcrição
(dupla digitação, idempotência por linha, segregação de funções), as 8 telas
de execução (T-P1..T-P8), coluna `execution_channel`, parâmetro
`TEL.MODO_EXECUCAO`. Consumo do novo endpoint pelo frontend (`FlowTrail.tsx`
hoje trata etapa futura como inerte — DOC-17 pede que abra em modo previsão;
telas reais de detalhe por etapa) também fica para uma sessão de frontend
dedicada, mesmo padrão de DOC-06/DOC-07 (backend primeiro).

## Critérios de aceite

Cenários Gherkin do DOC-17 §10 aplicáveis à Parte A: "Etapa futura abre em
modo previsão sem executar" e "Etapa concluída abre em consulta com quem e
quando". Os demais cenários (formulário, transcrição, dupla digitação,
segregação, digitação de código) são Parte B.

DoD padrão do CLAUDE.md.
