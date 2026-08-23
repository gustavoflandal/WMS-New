# MARCO — Estado do Sistema (pós DOC-15 / COL-2B)

**Data**: 2026-08-23 (atualizado; texto original de 2026-08-19, pós Sessão 6B)
**Commit**: `488d244` (COL-2B) — ver também `0fee971` (COL-2A), `8940f99` (COL-1) e `docs/relatorios/SESSAO-8-relatorio.md` (DOC-11) para o histórico recente
**Propósito**: ponto de retomada e base de demonstração. Descreve o que o sistema faz hoje, o que falta, e onde estão as decisões pendentes de validação externa (contabilidade do cliente).

**Desde a última revisão completa deste texto (pós DOC-11)**: DOC-15 (Operação
em Campo) fechou em 3 sessões — COL-1 (plataforma PWA, leitura wedge/câmera,
PIN, telas T1/T7/T8 online), COL-2A (motor offline no servidor: Pacote de
Turno, fila de sincronização, as 4 decisões determinísticas de conflito
RN-ARQ-053) e COL-2B (telas de execução offline T2–T6, IndexedDB, sincronização
oportunista). O sistema agora opera com coletores de campo reais, online e
offline-first. Ver `SESSAO-COL1-relatorio.md`, `SESSAO-COL2A-relatorio.md`,
`SESSAO-COL2B-relatorio.md`. §1 abaixo (números e descrição módulo a módulo)
ainda reflete o estado pós-DOC-11 e não foi reescrito linha a linha — use
`ESTADO-E-ROTEIRO.md` para os números mais recentes (302 testes de integração
+ 193 unitários no backend).

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
- `[LACUNA: DOC-08]` gatilho fiscal da etapa Expedição só tem o caminho `INTEGRADO_ERP` (confirmação manual); `EMISSAO_PROPRIA`/`HIBRIDO` ficam bloqueados até o DOC-08 existir.
- `[LACUNA]` estorno de Picking é imediato/atômico, sem o fluxo de confirmação física por dupla leitura ("tarefa de devolução dirigida") que o texto normativo sugere — a atomicidade (parte INVIOLÁVEL) está garantida; a UX de confirmação física, não.
- `[LACUNA]` peso teórico de produto `is_weight_variable` fracionado entre volumes usa peso médio por unidade, não atribuição exata por volume.
- Fórmula de conclusão do Picking (RN-EXP-033) não soma cross-docking (sem ponto de gravação em `outbound_order_item` nesta base).

### DOC-11 (Etiquetas e Periféricos) — fechado na Sessão 8, ver `SESSAO-8-relatorio.md` §4 para o texto completo
- `[LACUNA]` RNF-PER-031 (PRINT_PDF): nenhum motor de geração de PDF no projeto — o template opcional `CONTEUDO_PALETE` fica em DRAFT; o job PRINT_PDF já aceita PDF pronto do chamador (base64/URL) quando esse chamador existir (DANFE/cartas são de outros DOCs, ainda não implementados).
- `[DEBITO]` RF-PER-004 (Estações): nenhum caller real usa a resolução por Estação ainda — portaria (cancela) e packing (balança) resolvem pelo primeiro dispositivo da função cadastrado no armazém, mesmo critério de simplicidade que o código anterior já usava para `edge_agent`.
- `[DEBITO]` Sem controller HTTP dedicado para consulta de sugestão de placa (RF-POR-010) por pista — a integração é só a nível de service; a tela de portaria fica para uma sessão futura de frontend.

### DOC-12 (Segurança)
- Sem débitos abertos identificados na sessão que o implementou (Sessão 3) além dos 9 papéis semente sem composição de permissões de domínio — **naturalmente resolvido** à medida que cada catálogo (`REC.*`, `POR.*`, `EXP.*`) nasceu nas sessões seguintes; `FIS.*` (DOC-08) ainda não existe, então os papéis fiscais (`FISCAL`) seguem sem composição.

### Achados transversais (infra, não ligados a um DOC específico)
- `[DEBITO]` `ALTER DEFAULT PRIVILEGES` da migration 0001/0010 concede `UPDATE` a toda tabela nova por padrão — cada tabela append-only precisa de `REVOKE UPDATE` explícito (padrão já seguido desde a 2A; reconfirmado na 6B com `package_content`/`loading_order`/`loading_scan`/`inventory_count`).
- Observação não bloqueante: `wms-frontend` não sobe no compose de dev (`ERR_PNPM_NO_SCRIPT_OR_SERVER`) — problema de empacotamento pré-existente, nunca tocado (todo o trabalho até aqui é backend).

---

## 3. Módulos ainda não implementados

| Documento | Escopo (uma linha) | Depende de | Observação |
|---|---|---|---|
| **DOC-07** | Logística reversa: autorização de devolução, recepção, triagem determinística (reintegrar/avaria/quarentena/descarte/retorno), recall de lote | DOC-03/04/05 (reutilizados), DOC-08/09 (ganchos) | Único caminho de "estorno após gate-out" previsto no sistema (hoje PROIBIDO por design em DOC-06). |
| **DOC-08** | Fiscal: modos por cliente, Estoque Fiscal completo (NF de entrada, prazo, Nota de Armazenagem, ordem de consumo, Nota de Devolução), motor de NF-e (emissão/cancelamento/CCe/inutilização), certificados | DOC-04/06/07/12 | Módulo hoje é stub vazio (`modules/fiscal`). Bloqueia o caminho `EMISSAO_PROPRIA`/`HIBRIDO` da etapa Expedição do DOC-06. **3 decisões pendentes de homologação contábil — ver §4.** |
| **DOC-09** | Faturamento de serviços: contratos/tarifas por cliente, apuração (snapshot diário + evento), fechamento, Pré-Fatura com contestação, envio ao ERP | DOC-01/02/05/13 | Sem gateway de pagamento/cobrança — só gera a Pré-Fatura para o ERP do operador. |
| ~~DOC-10~~ | ~~Painel, alertas, chat, dashboards~~ | — | **FECHADO** nas Sessões 7A/7B — ver `SESSAO-7-relatorio.md`, `SESSAO-7A-relatorio.md`, `SESSAO-7B-relatorio.md`. |
| ~~DOC-11~~ | ~~Edge Agent: drivers, GS1, templates ZPL~~ | — | **FECHADO** na Sessão 8 — ver `SESSAO-8-relatorio.md`. Impressão real de LPN, pesagem por balança integrada com evidência (RNF-PER-040) e cancela via Edge Agent real agora funcionam de ponta a ponta (protocolo WebSocket real + simulador de referência `@wms/edge-agent`). |
| **DOC-13** | API pública REST, webhooks assinados, contratos canônicos, conectores ERP plugáveis, reconciliação diária | DOC-01 (mensageria) | Hoje toda entrada de dados é via chamada direta de serviço (testes) ou rota HTTP interna — não há integração externa real. |
| ~~DOC-15~~ | ~~PWA de campo (coletor): leitura wedge/câmera, sessão/PIN, Pacote de Turno, sincronização offline, telas T1–T8~~ | — | **FECHADO** — COL-1 (`8940f99`), COL-2A motor offline servidor (`0fee971`), COL-2B telas de execução offline (`e865e3f`/`488d244`). Ver `SESSAO-COL1-relatorio.md`, `SESSAO-COL2A-relatorio.md`, `SESSAO-COL2B-relatorio.md`. |
| **DOC-14** | Extensões futuras — documento de PROPOSTA, não requisito aprovado | — | Não é um débito: é intencionalmente especulativo, fora do ciclo de implementação. |

---

## 4. DOC-08 — itens `[VALIDAR CONTABILIDADE]` pendentes de homologação (2 de 3/4 ainda em aberto)

DOC-08 está com status **"APROVADO PARA USO — itens marcados [VALIDAR CONTABILIDADE] pendentes de homologação contábil do cliente"**. Resolve LAC-007/008/009 com uma **posição padrão já adotada no texto**, mas que precisa ser confirmada pelo contador do cliente/operador antes de ir para produção. Prompts de sessão prontos: `docs/PROMPT-SESSAO-8A-fiscal-estoque.md` (com pausa obrigatória sobre este §4 logo no topo) e `docs/PROMPT-SESSAO-8B-fiscal-emissao.md`.

1. **`RN-FIS-010` — Prazo de regularização da NF de entrada** (resolve LAC-007). Posição padrão: 10 dias corridos a partir do gate-in (`FIS.PRAZO_ENTRADA_DIAS`), com alertas em 50/80/100% e bloqueio de SAÍDA fiscal (não de entrada física) ao expirar. *A validar: o prazo de 10 dias e a natureza do bloqueio (só saída vs. também recebimento).* **PENDENTE (2026-08-23).**

2. **`RN-FIS-030` — Ordem de consumo do Estoque Fiscal** (resolve LAC-008). Posição padrão: `FIFO_EMISSAO` (consome a Nota de Armazenagem mais antiga por data de emissão primeiro), independente do lote físico expedido — o vínculo fiscal é por quantidade, não por unidade física. ✅ **CONFIRMADO pelo contador em 2026-08-16** (ver `ESTADO-E-ROTEIRO.md` §4) — pode ser implementado com o valor padrão sem nova validação.

3. **`RN-FIS-050` — Tabela de naturezas de operação e CFOP** (resolve LAC-009). Posição padrão: CFOP 5905/6905 (remessa para armazém geral) e 5906/6906 (retorno), regime de armazém geral clássico. *A validar: se os CFOPs padrão e o enquadramento como armazém geral (vs. depósito fechado ou outro regime) correspondem à operação real de cada cliente.* **PENDENTE (2026-08-23).**

**Nota**: o texto do documento também marca `RN-FIS-041` (reversa e recomposição do Consumo Fiscal quando mercadoria retorna via DOC-07) com o mesmo selo `[VALIDAR CONTABILIDADE]`, embora o resumo executivo do DOC-00 só relacione formalmente os 3 acima às LACs originais. Como `RN-FIS-030` já foi confirmada, e `RN-FIS-041` depende diretamente dela, resta validar `RN-FIS-041` isoladamente (ou junto de `RN-FIS-010`/`RN-FIS-050`, que ainda estão em aberto).

---

## 5. Como retomar

- O ciclo operacional central (cadastro → portaria → recebimento/putaway → estoque/inventário → expedição) está **fechado** desde a 5C — não há mais débito estrutural pendente nessa cadeia.
- **DOC-10** (painéis, fluxo operacional verde/vermelho, alertas, chat, dashboards de KPI), **DOC-11** (Edge Agent, GS1, templates, drivers) e **DOC-15** (PWA de coletor, online e offline-first) estão **fechados**. O sistema agora tem rosto (painel real), periféricos reais (impressão de LPN, pesagem por balança, cancela) e opera com coletores de campo de ponta a ponta.
- **Próximo: DOC-08 (fiscal)**, posição 2 do roteiro — prompts 8A/8B prontos (ver §4). 2 dos 3/4 itens `[VALIDAR CONTABILIDADE]` ainda pendentes de homologação contábil real; a 8A tem pausa obrigatória no topo para confirmar isso antes de codar os valores de produção (o sistema não fica bloqueado — a posição padrão do próprio DOC-08 é implementável, só não deve ir para produção sem confirmação).
- Módulos restantes após o fiscal, sem pré-requisito técnico bloqueante entre si: **DOC-13** (integrações). **DOC-07** (reversa) e **DOC-09** (faturamento) dependem do DOC-08.
- Para "ligar" o fiscal de verdade: **DOC-08** é pré-requisito de tudo que depende dele (NF-e real na Expedição, DOC-07 reversa com recomposição, DOC-09 faturamento) — e exige a homologação contábil do §4 ANTES de ir para produção (a implementação em si pode começar com a posição padrão, ver prompt da 8A).
- Para uma demonstração completa do que já funciona: o teste de MARCO em `apps/backend/src/modules/expedicao/__tests__/picking-packing-carregamento.integration.spec.ts` é o roteiro ponta a ponta mais fiel (pedido → COMPLETED) disponível hoje.
