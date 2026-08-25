# MARCO — Estado do Sistema (pós DOC-08A)

**Data**: 2026-08-24 (atualizado; texto original de 2026-08-19, pós Sessão 6B)
**Commit**: ver `docs/relatorios/SESSAO-8A-relatorio.md` (DOC-08A) — anterior a isso, `488d244` (COL-2B), `0fee971` (COL-2A), `8940f99` (COL-1) e `docs/relatorios/SESSAO-8-relatorio.md` (DOC-11) para o histórico recente
**Propósito**: ponto de retomada e base de demonstração. Descreve o que o sistema faz hoje, o que falta, e onde estão as decisões pendentes de validação externa (contabilidade do cliente).

**Desde a última revisão completa deste texto (pós DOC-11)**: DOC-15 (Operação
em Campo) fechou em 3 sessões — COL-1 (plataforma PWA, leitura wedge/câmera,
PIN, telas T1/T7/T8 online), COL-2A (motor offline no servidor: Pacote de
Turno, fila de sincronização, as 4 decisões determinísticas de conflito
RN-ARQ-053) e COL-2B (telas de execução offline T2–T6, IndexedDB, sincronização
oportunista). O sistema agora opera com coletores de campo reais, online e
offline-first. Em seguida, **DOC-08A (2026-08-24)** implementou o ciclo do
Estoque Fiscal completo (RG-014): modos fiscais, prazo de regularização da NF
de entrada, Nota de Armazenagem + crédito, ordem de consumo FIFO_EMISSAO/
LIFO_EMISSAO/MANUAL, Nota de Devolução de Armazenagem com consumo efetivado
só na autorização, recomposição por reversa (método isolado) e pendências
documentais de descarte/ajuste — `DispatchService.confirmFiscalDocuments`
(DOC-06) deixa de bloquear `EMISSAO_PROPRIA`/`HIBRIDO`. Falta só **DOC-08B**
(motor de emissão NF-e real). Ver `SESSAO-COL1-relatorio.md`,
`SESSAO-COL2A-relatorio.md`, `SESSAO-COL2B-relatorio.md`,
`SESSAO-8A-relatorio.md`. §1 abaixo (números e descrição módulo a módulo)
ainda reflete o estado pós-DOC-11 e não foi reescrito linha a linha — use
`ESTADO-E-ROTEIRO.md` para os números mais recentes (verifique
`SESSAO-8A-relatorio.md` §3 para a contagem exata de testes pós-8A).

---

## 1. O que o sistema faz hoje (ponta a ponta, em negócio)

O ciclo completo de um 3PL — do cadastro do cliente até a mercadoria sair pelo portão — funciona de ponta a ponta, com dado real (Postgres com RLS, filas Redis, eventos em tempo real), sem nenhum simulacro no caminho crítico.

**Cadastro** (DOC-02): clientes, armazéns, estrutura física (zona → rua → módulo → nível), equipamentos de armazenagem, produtos (com embalagens, código de barras, peso/dimensões, política de giro), lotes, paletes/LPN (SSCC de 18 dígitos), parâmetros por cliente×armazém (modo fiscal, política de giro padrão, conferência às cegas).

**Portaria e pátio** (DOC-03): agendamento por janela com capacidade, gate-in com validação de agendamento e HAZMAT, fila de pátio, chamada para doca, gate-out condicionado ao Fluxo Operacional da visita e à conferência de lacre — com bloqueio explícito e caminho de saída forçada auditado.

**Recebimento e putaway** (DOC-04): ordem de recebimento (própria ou por XML de NF-e), conferência (às cegas ou não), divergências com carta e decisão, cross-docking, etiquetagem, e o motor de putaway completo — 6 filtros invioláveis em cascata (Fase 1 legal/Fase 2 ranqueamento), execução com dupla leitura e override auditado.

**Estoque e movimentação** (DOC-05): serviço único de movimentação (18 tipos de efeito fechados, todo saldo passa por ele — travado por trigger de banco), bloqueio/desbloqueio/reclassificação com motivo tipificado, transferências entre armazéns, reposição kanban, alerta de vencimento, a Seleção de Saldo real (FEFO/FIFO/LIFO_PHYSICAL/JIT, shelf life mínimo, quebra de política auditada) que tanto o kanban quanto a expedição consomem, e **Inventários** (§4.7 — fechado na Sessão 5C): os 7 tipos de geração de escopo, congelamento de endereço, as 3 rodadas de contagem cega com decisão do líder de turno na 3ª, ajuste com alçada via o motor de exceção do DOC-12, e apuração de acuracidade por endereço/quantidade/cliente.

**Expedição** (DOC-06) — **fechada nesta sessão**: pedido → liberação (validação física + fiscal + bloqueio, reserva efetiva) → ondas → picking com rota serpenteada e dupla leitura (corte bloqueia saldo e agenda contagem automática) → packing com validação de conteúdo exato → pesagem com tolerância parametrizada → expedição documental (staging + gatilho fiscal) → carregamento (recusa volume estranho no ato) → saída integrada ao gate-out real do DOC-03 → pedido `COMPLETED`. Os 4 estornos por etapa e a cascata de cancelamento tardio revertem o efeito FÍSICO, não só o estado.

**Segurança e auditoria** (DOC-12): RBAC por papel×armazém×cliente, MFA, política de senha, auditoria imutável (before/after) em toda mutação de negócio, motor de workflow de aprovação (1 e 2 passos, segregação de funções, escalonamento por alçada, efeito suspensivo sobre o Fluxo Operacional).

**Infraestrutura** (DOC-01): multi-tenant com RLS forçada, outbox → Redis Streams → WebSocket (fanout em tempo real, ≤2s), particionamento mensal automático (stock_movement, audit_log, e as 3 filas de tarefa: putaway/replenishment/picking), rate limiting, métricas, health checks, 3 papéis de processo (api/worker/scheduler) rodando em containers separados.

**Números atuais**: 52 migrations aplicadas; backend com **161 testes unitários** e **240 testes de integração** (Postgres real, 2 execuções consecutivas idênticas) passando; `RN-SEG-012` (toda rota declara permissão) validado no boot.

---

## 2. Lacunas e débitos em aberto, por documento-alvo

Só o que **ainda está aberto** ao final da 6B (itens fechados por sessões posteriores foram removidos desta lista; o histórico completo de cada um vive no relatório da sessão que o declarou, em `docs/relatorios/SESSAO-*-relatorio.md`).

### DOC-02 (Cadastro)
- `[DEBITO]` sem teste de integração dedicado para RF-DAD-051 (desativação valida vínculos) em cada entidade — coberto indiretamente, não isoladamente.
- `[DEBITO]` `zone.allowed_species` não valida contra `product_species.code` (sem FK de array em Postgres).
- `[LACUNA]` algoritmo de intervalo/capacidade padrão por aisle/nível não definido pelo documento.
- `[DEBITO]` migração para UUIDv7 real (hoje `gen_random_uuid()` v4) — cosmético, sem urgência.

### DOC-03 (Portaria)
- Sem débitos abertos identificados nas sessões que o tocaram por último (3/4).

### DOC-04 (Recebimento)
- `[DEBITO]` `DockService` (RN-REC-001, RF-REC-002/003) sem teste de integração dedicado.
- `[DEBITO]` vínculo tardio de Ordem pré-chegada (ASN antes do gate-in) a uma visita — reenvio do mesmo XML falha com `NFE_ALREADY_REGISTERED` se nenhum vínculo foi achado na criação.
- `[LACUNA]` altura de palete montado, `allowed_species` vazio, faixa de temperatura por produto, par REFRIGERADO/CONGELADO×COLD/FROZEN, `batch.status`→parcela do saldo, CLASSE_ABC×giro, fronteira do "canal" — todas por ausência de definição normativa no DOC-02/DOC-04; decisões conservadoras adotadas e travadas por teste (ver §6 do relatório da 4B para o texto exato de cada uma).
- `[DEBITO]` `RN-REC-023` (recusa total → visita segue para gate-out) não é acionado automaticamente entre módulos — fronteira de DI respeitada, exige orquestração explícita quando for priorizado.

### DOC-05 (Estoque)
- `[DEBITO]` `RF-EST-051` — transferência entre armazéns não abre Ordem de Recebimento/Conferência formal no destino (credita saldo direto).
- `[DEBITO]` `RF-EST-031` — termo de descarte em PDF e notificação formal ao cliente não existem (só o evento de domínio).
- `[DEBITO]` `RF-EST-040/041` "todo evento de baixa" — só o job horário avalia estoque de segurança; não é acoplado a cada movimentação real.
- `[LACUNA]` arredondamento de reposição kanban para múltiplos de embalagem de picking; "endereço(s) de picking" tratado como singular.
- `[DEBITO]` fracionamento de reposição kanban em múltiplas origens (RD-EST-002 modela uma origem por tarefa).
- `[DEBITO]` permissão HTTP dedicada para reserva/consulta regular de seleção — hoje só a rota de quebra de política (`EST.QUEBRA_POLITICA_GIRO`) é exposta; o resto é consumo interno (kanban, picking).
- ~~consumo da reserva no picking~~ — **FECHADO pela 6B** (`stock_reservation` transiciona para `CONSUMED` no carregamento, `CANCELLED`/qty ajustada no corte e nos estornos).
- ~~Inventários (§4.7, RF-EST-060..064) não implementados~~ — **FECHADO pela 5C**. Débito residual: `[DÉBITO: 5A, achado pela 5C]` `expiration.service.ts` lê `app_parameter` GLOBAL por uma via que a RLS zera silenciosamente (mesmo bug corrigido em `InventoryPlanningService` nesta sessão) — não corrigido lá por estar fora do escopo do módulo de inventário; ver `docs/relatorios/SESSAO-5C-relatorio.md` §5.3/§6.

### DOC-06 (Expedição) — ver `docs/relatorios/SESSAO-6B-relatorio.md` §4 para o texto completo
- `[DEBITO: 5C]` `wms.inventory_count` (POR_ENDERECO) só é CRIADA pelo corte de picking; a execução (rodadas de contagem cega, ajuste com alçada) é da 5C.
- ~~`[LACUNA: DOC-08]` gatilho fiscal da etapa Expedição só tem o caminho `INTEGRADO_ERP`~~ — **FECHADO pela 8A**: `DispatchService.confirmFiscalDocuments` chama `StorageReturnInvoiceService.assembleAndAuthorizeForOrder` para `EMISSAO_PROPRIA`/`HIBRIDO` (RN-FIS-040), sem teste de integração ponta a ponta dedicado dentro do fluxo completo de expedição (`[DEBITO: 8A]`, ver `SESSAO-8A-relatorio.md` §7).
- `[LACUNA]` estorno de Picking é imediato/atômico, sem o fluxo de confirmação física por dupla leitura ("tarefa de devolução dirigida") que o texto normativo sugere — a atomicidade (parte INVIOLÁVEL) está garantida; a UX de confirmação física, não.
- `[LACUNA]` peso teórico de produto `is_weight_variable` fracionado entre volumes usa peso médio por unidade, não atribuição exata por volume.
- Fórmula de conclusão do Picking (RN-EXP-033) não soma cross-docking (sem ponto de gravação em `outbound_order_item` nesta base).

### DOC-11 (Etiquetas e Periféricos) — fechado na Sessão 8, ver `SESSAO-8-relatorio.md` §4 para o texto completo
- `[LACUNA]` RNF-PER-031 (PRINT_PDF): nenhum motor de geração de PDF no projeto — o template opcional `CONTEUDO_PALETE` fica em DRAFT; o job PRINT_PDF já aceita PDF pronto do chamador (base64/URL) quando esse chamador existir (DANFE/cartas são de outros DOCs, ainda não implementados).
- `[DEBITO]` RF-PER-004 (Estações): nenhum caller real usa a resolução por Estação ainda — portaria (cancela) e packing (balança) resolvem pelo primeiro dispositivo da função cadastrado no armazém, mesmo critério de simplicidade que o código anterior já usava para `edge_agent`.
- `[DEBITO]` Sem controller HTTP dedicado para consulta de sugestão de placa (RF-POR-010) por pista — a integração é só a nível de service; a tela de portaria fica para uma sessão futura de frontend.

### DOC-12 (Segurança)
- Sem débitos abertos identificados na sessão que o implementou (Sessão 3) além dos 9 papéis semente sem composição de permissões de domínio — **naturalmente resolvido** à medida que cada catálogo nasceu nas sessões seguintes; `FIS.*` (DOC-08) nasceu na 8A e já compõe `FISCAL` (`FIS.EMITIR`/`CANCELAR`/`CCE`/`INUTILIZAR`) e `GESTOR_ARMAZEM` (`FIS.CONFIG`/`CERTIFICADO`).

### DOC-08 (Fiscal) — 8A fechada, ver `docs/relatorios/SESSAO-8A-relatorio.md` §7 para o texto completo
- `[DEBITO: 8A]` `FIS.PRAZO_ENTRADA_DIAS` (fallback GLOBAL) não religado em `inbound-order.service.ts::createFromXml` (DOC-04) — fora do escopo declarado da 8A.
- `[DEBITO: 8A]` sem teste de integração dedicado para a trava de imutabilidade de `FiscalModeService` (RN-FIS-001), o caminho `MANUAL` de RN-FIS-030, e `DispatchService.confirmFiscalDocuments` ponta a ponta para `EMISSAO_PROPRIA`/`HIBRIDO` dentro do fluxo completo de expedição.
- `[LACUNA: DOC-08]` RN-FIS-010 item 4 — override de prazo expirado via exceção `FIS.PRAZO_ENTRADA_EXPIRADO` tem catálogo mas não tem ponto de integração implementado em `outbound-order.service.ts::release()`.

### Achados transversais (infra, não ligados a um DOC específico)
- `[DEBITO]` `ALTER DEFAULT PRIVILEGES` da migration 0001/0010 concede `UPDATE` a toda tabela nova por padrão — cada tabela append-only precisa de `REVOKE UPDATE` explícito (padrão já seguido desde a 2A; reconfirmado na 6B com `package_content`/`loading_order`/`loading_scan`/`inventory_count`).
- Observação não bloqueante: `wms-frontend` não sobe no compose de dev (`ERR_PNPM_NO_SCRIPT_OR_SERVER`) — problema de empacotamento pré-existente, nunca tocado (todo o trabalho até aqui é backend).

---

## 3. Módulos ainda não implementados

| Documento | Escopo (uma linha) | Depende de | Observação |
|---|---|---|---|
| **DOC-07** | Logística reversa: autorização de devolução, recepção, triagem determinística (reintegrar/avaria/quarentena/descarte/retorno), recall de lote | DOC-03/04/05 (reutilizados), DOC-08/09 (ganchos) | Único caminho de "estorno após gate-out" previsto no sistema (hoje PROIBIDO por design em DOC-06). |
| ~~DOC-08 (8A)~~ | ~~Fiscal: modos por cliente, Estoque Fiscal completo (NF de entrada, prazo, Nota de Armazenagem, ordem de consumo, Nota de Devolução, pendências)~~ | — | **FECHADO em 2026-08-24** — ver `SESSAO-8A-relatorio.md`. Caminho `EMISSAO_PROPRIA`/`HIBRIDO` da etapa Expedição do DOC-06 desbloqueado. |
| **DOC-08 (8B)** | Fiscal: motor de NF-e real (emissão/cancelamento/CCe/inutilização), certificados A1, guarda de XML, DANFE | 8A (concluída) | **Próximo da fila** — prompt pronto em `docs/PROMPT-SESSAO-8B-fiscal-emissao.md`. |
| **DOC-09** | Faturamento de serviços: contratos/tarifas por cliente, apuração (snapshot diário + evento), fechamento, Pré-Fatura com contestação, envio ao ERP | DOC-01/02/05/13 | Sem gateway de pagamento/cobrança — só gera a Pré-Fatura para o ERP do operador. |
| ~~DOC-10~~ | ~~Painel, alertas, chat, dashboards~~ | — | **FECHADO** nas Sessões 7A/7B — ver `SESSAO-7-relatorio.md`, `SESSAO-7A-relatorio.md`, `SESSAO-7B-relatorio.md`. |
| ~~DOC-11~~ | ~~Edge Agent: drivers, GS1, templates ZPL~~ | — | **FECHADO** na Sessão 8 — ver `SESSAO-8-relatorio.md`. Impressão real de LPN, pesagem por balança integrada com evidência (RNF-PER-040) e cancela via Edge Agent real agora funcionam de ponta a ponta (protocolo WebSocket real + simulador de referência `@wms/edge-agent`). |
| **DOC-13** | API pública REST, webhooks assinados, contratos canônicos, conectores ERP plugáveis, reconciliação diária | DOC-01 (mensageria) | Hoje toda entrada de dados é via chamada direta de serviço (testes) ou rota HTTP interna — não há integração externa real. |
| ~~DOC-15~~ | ~~PWA de campo (coletor): leitura wedge/câmera, sessão/PIN, Pacote de Turno, sincronização offline, telas T1–T8~~ | — | **FECHADO** — COL-1 (`8940f99`), COL-2A motor offline servidor (`0fee971`), COL-2B telas de execução offline (`e865e3f`/`488d244`). Ver `SESSAO-COL1-relatorio.md`, `SESSAO-COL2A-relatorio.md`, `SESSAO-COL2B-relatorio.md`. |
| **DOC-14** | Extensões futuras — documento de PROPOSTA, não requisito aprovado | — | Não é um débito: é intencionalmente especulativo, fora do ciclo de implementação. |

---

## 4. DOC-08 — itens `[VALIDAR CONTABILIDADE]` — RESOLVIDO em 2026-08-23, CONFIRMADO pela implementação da 8A em 2026-08-24

DOC-08 está com status **"APROVADO PARA USO — itens marcados [VALIDAR CONTABILIDADE] pendentes de homologação contábil do cliente"**, resolvendo LAC-007/008/009 com uma **posição padrão adotada no texto**. Em 2026-08-23 o Gustavo definiu o tratamento dos três: **não são valor único nacional a homologar antes de começar — são parâmetro de cadastro por cliente×armazém**, com a posição padrão do DOC-08 como seed/padrão de instalação. Cada cliente real recebe o valor do contrato/regime dele no próprio cadastro (feito por quem administra aquele cliente), não uma constante global que trava o sistema inteiro. Prompts de sessão prontos: `docs/PROMPT-SESSAO-8A-fiscal-estoque.md` e `docs/PROMPT-SESSAO-8B-fiscal-emissao.md` — nenhuma pausa bloqueia mais o início da 8A.

1. **`RN-FIS-010` — Prazo de regularização da NF de entrada** (resolve LAC-007). `client_warehouse_settings.inbound_invoice_deadline_days`, com `FIS.PRAZO_ENTRADA_DIAS` = 10 dias como seed global. Alertas em 50/80/100%, bloqueio de SAÍDA fiscal (não de entrada física) ao expirar.

2. **`RN-FIS-030` — Ordem de consumo do Estoque Fiscal** (resolve LAC-008). `FIS.ORDEM_CONSUMO` por cliente×armazém, `FIFO_EMISSAO` como seed — o vínculo fiscal é por quantidade, não por unidade física. ✅ Confirmado pelo contador em 2026-08-16 como o padrão correto para a maioria dos clientes.

3. **`RN-FIS-050` — Tabela de naturezas de operação e CFOP** (resolve LAC-009). Tabela `operation_nature` por cliente×armazém×tipo×âmbito, com CFOP 5905/6905 (remessa)/5906/6906 (retorno) — regime de armazém geral — como seed de instalação.

**Critério de aceite da Sessão 8A**: os três mecanismos precisam ser reconfiguráveis por cliente×armazém via cadastro, sem migration nova para ajustar um cliente específico — se algum ficar hardcoded como constante global, é bug da sessão, não pendência externa.

**✅ CONFIRMADO em 2026-08-24**: os três são resolvidos em runtime via
consulta ao banco com fallback explícito (prazo em `client_warehouse_
settings.inbound_invoice_deadline_days`; ordem de consumo em `app_parameter`
escopo `CLIENT_WAREHOUSE` `FIS.ORDEM_CONSUMO`; CFOP/natureza em `wms.
operation_nature` com tenant_id/warehouse_id preenchidos como override) —
nenhum hardcoded. Ver `docs/relatorios/SESSAO-8A-relatorio.md` §6.

**Nota**: `RN-FIS-041` (reversa e recomposição do Consumo Fiscal quando mercadoria retorna via DOC-07) tem o mesmo selo `[VALIDAR CONTABILIDADE]` e depende diretamente de `RN-FIS-030` (já confirmada) — segue o mesmo tratamento.

---

## 5. Como retomar

- O ciclo operacional central (cadastro → portaria → recebimento/putaway → estoque/inventário → expedição) está **fechado** desde a 5C — não há mais débito estrutural pendente nessa cadeia.
- **DOC-10** (painéis, fluxo operacional verde/vermelho, alertas, chat, dashboards de KPI), **DOC-11** (Edge Agent, GS1, templates, drivers), **DOC-15** (PWA de coletor, online e offline-first) e **DOC-08** completo (8A ciclo do Estoque Fiscal + 8B motor de emissão NF-e real) estão **fechados**. O sistema agora tem rosto (painel real), periféricos reais, opera com coletores de campo de ponta a ponta, e o fiscal (RG-014) é real de ponta a ponta — emissão, cancelamento, CCe, DANFE.
- **DOC-07 (Logística Reversa) completo em 2026-08-25** — 9A (núcleo: Ordem de Devolução, Triagem, Destinação, gancho fiscal real) + 9B (RN-REV-002 real no gate-in, `RECUSA_ENTREGA` automática, Recall RF-REV-030 completo), ver `docs/relatorios/SESSAO-9A-relatorio.md` e `docs/relatorios/SESSAO-9B-relatorio.md`. Os 6 cenários Gherkin do DOC-07 §6 estão cobertos. A divisão 9A/9B foi um achado de leitura de código (`DockService`/`GateInService` são hardcoded para `inbound_order`/agendamento), não uma estimativa a priori.
- **DOC-17 Parte A (Detalhe de Etapa) completa em 2026-08-25** — contrato único `GET .../fluxo-operacional/:entity/:entityId/steps/:stepCode/detail` (RF-TEL-001/004), os 4 modos Consulta/Execução/Previsão/Bloqueada (RN-TEL-002) e o catálogo de conteúdo por etapa (RF-TEL-003) para os 3 fluxos reais hoje existentes, ver `docs/relatorios/SESSAO-10A-relatorio.md`. **Consumo no frontend completo em 2026-08-25 (Sessão 10C)** — `FlowTrail.tsx` implementa DOC-17 §2 (o clique SEMPRE abre, nunca mais inerte), `StepDetailPanel` genérico novo em `@wms/ui` renderiza os 4 modos na tela da trilha, ver `docs/relatorios/SESSAO-10C-relatorio.md`.
- **DOC-17 Formulário de Campo (§7) completo em 2026-08-25 (Sessão 10B)** — emissão (RF-TEL-020, com PDF real via `pdf-lib` e código de barras Code 128 próprio), reserva de tarefa (RN-TEL-021), cancelamento e reemissão RE1/RE2 (RF-TEL-024), cegueira preservada no papel (RN-TEL-023), operação Putaway (T-P1) ligada de ponta a ponta a `wms.putaway_task`. Só API — sem tela de frontend ainda. Ver `docs/relatorios/SESSAO-10B-relatorio.md`.
- **DOC-17 Transcrição (§8) completa em 2026-08-25 (Sessão 10D)** — o formulário emitido no campo volta e é digitado: idempotência por linha (a chave gerada na emissão vira a chave da operação, RN-TEL-031), segregação de funções (RN-TEL-032), validade (RN-TEL-033) e dupla digitação (RF-TEL-034). Cada linha é efetivada pelos **mesmos serviços de domínio do coletor** (RN-TEL-011), sem caminho de regra paralelo. Ver `docs/relatorios/SESSAO-10D-relatorio.md`.
- **Próximo: DOC-17 Execução por Tela (§6)** — RN-TEL-010/011/012, as 8 telas T-P1..T-P8 e `execution_channel` (RD-TEL-004); é o que resta do DOC-17. Módulos restantes sem pré-requisito técnico bloqueante entre si: **DOC-13** (integrações), **DOC-09** (faturamento).
- Para uma demonstração completa do que já funciona: o teste de MARCO em `apps/backend/src/modules/expedicao/__tests__/picking-packing-carregamento.integration.spec.ts` é o roteiro ponta a ponta mais fiel (pedido → COMPLETED) disponível hoje; para a reversa, `apps/backend/src/modules/reversa/__tests__/return-order.integration.spec.ts` (núcleo) e `gate-in-devolucao.integration.spec.ts`/`recall/__tests__/recall.integration.spec.ts` (integração/recall) cobrem o ciclo completo; para o detalhe de etapa, `apps/backend/src/modules/telas/__tests__/step-detail.integration.spec.ts`.
