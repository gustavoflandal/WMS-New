# ESTADO E ROTEIRO — WMS Enterprise 3PL
> Documento de retomada. Atualize ao final de cada sessão.
> Última atualização: 2026-08-25 (Sessão 10A)

---

## 1. Onde o projeto está

**MARCO ATINGIDO:** o sistema executa o ciclo operacional completo ponta a
ponta, com painel visual, opera com hardware real (periféricos DOC-11 e
coletores online/offline DOC-15), o DOC-08 (Fiscal, RG-014) está
**completo** — Estoque Fiscal (8A) + motor de emissão NF-e real (8B),
concluídos em 2026-08-24 — e o DOC-07 (Logística Reversa) está **completo**
— núcleo (9A) + integração real com Gate-in/Portaria e Recall (9B),
concluídos em 2026-08-25.

Ciclo comprovado por teste automatizado: agendamento → gate-in → doca →
recebimento com conferência e divergências → etiquetagem/LPN → putaway
dirigido → estoque com política de giro → pedido → liberação (validação
física e fiscal) → reserva → picking com corte → packing → pesagem →
expedição (documental + gatilho fiscal real para `EMISSAO_PROPRIA`/`HIBRIDO`,
não só `INTEGRADO_ERP`, com emissão de NF-e assíncrona DRAFT→SIGNED→
TRANSMITTED→AUTHORIZED via worker + simulador SEFAZ determinístico) →
carregamento → gate-out → `COMPLETED`, com o Painel de Operações e a trilha
verde/vermelho renderizando em tempo real. Operação de campo (coletor PWA)
cobre as 8 telas do catálogo fechado (T1–T8), online e offline-first, com
resolução determinística de conflitos de sincronização.

**Números (2026-08-25, pós Sessão 10A):** ver `docs/relatorios/SESSAO-10A-relatorio.md`
§2 para a saída real de `pnpm test`/`pnpm test:integration` (2 execuções
consecutivas) coladas na sessão — backend com **215 testes unitários** e
**330 testes de integração** (2 execuções consecutivas idênticas); 3 papéis
de backend saudáveis em Docker (`docker compose up -d --build` +
`curl localhost:3000/health/ready` → 200).

### Documentos implementados

| Doc | Módulo | Estado |
|---|---|---|
| DOC-01 | Arquitetura e infraestrutura | ✅ completo |
| DOC-02 | Modelo de dados e cadastros | ✅ completo |
| DOC-12 | Segurança, RBAC e auditoria | ✅ completo |
| DOC-03 | Portaria e pátio | ✅ completo |
| DOC-04 | Recebimento, docas e putaway | ✅ completo |
| DOC-05 | Estoque, seleção de saldo e inventários | ✅ completo |
| DOC-06 | Expedição | ✅ completo |
| DOC-10 | Painéis, tempo real e KPIs | ✅ completo |
| DOC-11 | Etiquetas e periféricos | ✅ completo |
| DOC-15 | Operação em campo (coletores) | ✅ completo — COL-1 (plataforma, commit `8940f99`) + COL-2A (motor offline servidor, `0fee971`) + COL-2B (telas de execução offline, `e865e3f`/`488d244`) |
| DOC-08 | Fiscal (RG-014) | ✅ **completo** — 8A (ciclo do Estoque Fiscal: modos, prazo, Nota de Armazenagem, ordem de consumo, Nota de Devolução, pendências) + 8B (motor de emissão NF-e real: DRAFT→SIGNED→TRANSMITTED→AUTHORIZED/REJECTED/DENIED, contingência SVC, cancelamento/CCe, certificados A1 cifrados, DANFE, inutilização), ver `docs/relatorios/SESSAO-8B-relatorio.md` |
| DOC-07 | Logística reversa | ✅ **completo** — 9A núcleo (Ordem de Devolução, Triagem, Destinação, gancho fiscal) + 9B (RN-REV-002 real no gate-in, `RECUSA_ENTREGA` automática, Recall RF-REV-030 completo), ver `docs/relatorios/SESSAO-9B-relatorio.md` |
| DOC-17 (10A/10C/10B) | Detalhe de etapas e Formulário de Campo | ✅ **10A concluída** (2026-08-25): contrato único de detalhe de etapa (RF-TEL-001/004), 4 modos (RN-TEL-002), catálogo de conteúdo por etapa (RF-TEL-003); ✅ **10C concluída** (2026-08-25): consumo real no frontend — `FlowTrail.tsx` implementa DOC-17 §2, `StepDetailPanel` novo; ✅ **10B concluída** (2026-08-25): Formulário de Campo (§7) — emissão/cancelamento/reemissão, Putaway (T-P1) ligado de ponta a ponta — falta Transcrição (§8) e Execução por Tela (§6), ver `docs/relatorios/SESSAO-10A-relatorio.md`, `SESSAO-10C-relatorio.md` e `SESSAO-10B-relatorio.md` |

### Não implementados

| Doc | Módulo | Observação |
|---|---|---|
| DOC-17 (Transcrição/Execução por Tela) | Detalhe de etapas — Parte B (restante) | **próximo**; depende só da 10B (concluída) — Transcrição (§8, dupla digitação, idempotência, segregação), Execução por Tela (§6, 8 telas T-P1..T-P8, `execution_channel`) |
| DOC-09 | Faturamento de serviços | receita do operador |
| DOC-13 | Integrações (API pública, ERP) | necessário no primeiro cliente com ERP |
| DOC-14 | Extensões futuras (IA local, workflow dinâmico) | **proposta**, não implementar |
| DOC-16 | Portal do cliente | 28 telas; `PORTAL-1` (C-01–C-17, C-24–C-28) pode antecipar, já que só depende do que está pronto; `PORTAL-2` depende de DOC-08/DOC-09 |

---

## 2. Roteiro recomendado

| Ordem | Sessão | Modelo | Status |
|---|---|---|---|
| 1 | **DOC-11** periféricos | médio | ✅ concluído |
| 2 | **COL-1** plataforma de coletor | médio | ✅ concluído (`8940f99`) |
| 3 | **COL-2A** motor offline (servidor) | médio-alto | ✅ concluído (`0fee971`) |
| 3 | **COL-2B** telas de execução offline (frontend) | médio | ✅ concluído (`e865e3f`/`488d244`) |
| — | *janela de piloto real recomendada* (§4 de `ROTEIRO-DESENVOLVIMENTO.md`) | — | em aberto, decisão do Gustavo |
| 4 | **DOC-08A** fiscal — ciclo do estoque | premium | ✅ concluído (Sessão 8A, 2026-08-24) |
| 4 | **DOC-08B** fiscal — motor de emissão | premium | ✅ concluído (Sessão 8B, 2026-08-25) |
| 5 | **DOC-07 9A** reversa — núcleo | econômico | ✅ concluído (Sessão 9A, 2026-08-25) |
| 5 | **DOC-07 9B** reversa — integração/recall | médio | ✅ concluído (Sessão 9B, 2026-08-25) |
| 6 | **DOC-17 10A** detalhe de etapa (Parte A) | médio | ✅ concluído (Sessão 10A, 2026-08-25) |
| 6 | **DOC-17 10C** consumo no frontend (§2, `StepDetailPanel`) | médio | ✅ concluído (Sessão 10C, 2026-08-25) |
| 6 | **DOC-17 10B** Formulário de Campo (§7) | médio | ✅ concluído (Sessão 10B, 2026-08-25) |
| 6 | **DOC-17** Transcrição (§8) + Execução por Tela (§6) | médio | **próximo** — depende só da 10B (concluída) |
| 7 | **DOC-09** faturamento | médio | aritmética half-even já validada |
| 8 | **DOC-13** integrações | médio | quando entrar cliente com ERP |
| — | RG-016 modos de operação | econômico | 4 itens pequenos de backend + UI (armazém próprio) |

Módulo grande vira A/B. Prompts de sessão em `docs/PROMPT-SESSAO-*.md`.

---

## 3. Débitos e lacunas abertos

Consolidar a partir da §6 dos relatórios de sessão. Conhecidos:

- `vehicle_type` como texto livre (DOC-03) — decidir se vira catálogo;
- convenção de dia da semana das janelas de agendamento (DOC-03);
- cobertura de teste do `DockService` (herdado da 4A);
- transbordo RG-015 item 3 — verificar se foi fechado na 5A;
- altura de palete e faixa de temperatura no modelo (DOC-02) — avaliar emenda;
- integração de conferência no recebimento inter-armazém (DOC-05/04);
- ~~container `frontend` e conflito de porta 3001 no host~~ — **resolvido em
  2026-08-23**: porta movida para 3002 (`infra/docker-compose.yml`,
  `Dockerfile.frontend`, `CORS_ORIGIN`, `.env.example`, README);
- T6 Transferência ad-hoc (RF-EST-050, DOC-15 COL-2B) não implementada no
  coletor — exige rota de busca de `locationId`/`productId` por código
  escaneado, inexistente no backend; Reposição dirigida está completa;
- T3 Picking via `OfflineSyncService`/coletor sem cenário de integração
  dedicado (COL-2A) nem tarefa semeada para screenshot (COL-2B) — fixture de
  onda/reserva completa tem custo alto, dispatch já implementado e compila;
- "Zona/estação" do RNF-COL-020 (estado permanente do coletor) sem campo
  correspondente em nenhuma API — cabeçalho mostra operador/armazém/
  conexão/fila, não zona/estação.
- `[DEBITO: 8A]` `FIS.PRAZO_ENTRADA_DIAS` (fallback GLOBAL, seed 10 dias) não
  está religado em `inbound-order.service.ts::createFromXml` (DOC-04) — esse
  método continua exigindo `client_warehouse_settings.inbound_invoice_
  deadline_days` configurado explicitamente; tocar nesse arquivo ficou fora
  do escopo declarado da 8A (é DOC-04, não DOC-08).
- `[DEBITO: 8A]` sem teste de integração dedicado para a trava de
  imutabilidade de `FiscalModeService.changeFiscalMode()` (RN-FIS-001), o
  caminho `MANUAL` de RN-FIS-030 com exceção `FIS.CONSUMO_MANUAL`, e
  `DispatchService.confirmFiscalDocuments` ponta a ponta para
  `EMISSAO_PROPRIA`/`HIBRIDO` dentro do fluxo completo de expedição — ver
  `docs/relatorios/SESSAO-8A-relatorio.md` §7 para o detalhe.
- `[LACUNA: DOC-08]` RN-FIS-010 item 4 (override de prazo expirado via
  exceção `FIS.PRAZO_ENTRADA_EXPIRADO`) — catálogo de exceção existe, ponto
  de integração exato do override em `outbound-order.service.ts::release()`
  não foi implementado (DOC-08 não detalha o mecanismo).
- `[DEBITO: 9A]` DOC-07: `REINTEGRAR` não aciona o motor de putaway dirigido
  (RN-REC-040) — credita direto na zona `RETURNS`; `AVARIA`/`DESCARTE`/
  `RETORNO_CLIENTE` sem cenário de integração dedicado; sem teste isolado
  para `deny()`/`cancel()` nem para o fluxo `REV.ITEM_NAO_EXPEDIDO`
  (aprovação de item fora do pedido de origem) — ver
  `docs/relatorios/SESSAO-9A-relatorio.md` §5.
- `[LACUNA: DOC-07]` upload de foto: nenhum módulo do projeto tem endpoint
  HTTP de upload multipart hoje — `photo_keys` da Triagem são assumidas já
  existentes no storage, mesma convenção de `checking.controller.ts`.
- `[DEBITO: 9B]` `retrySlotAllocation`/`resumeAfterExceptionDecision` (gate-in
  sem vaga de pátio no momento) não vinculam a Ordem de Devolução
  automaticamente quando a vaga libera depois — fallback manual sempre
  disponível (`POST /reversa/ordens/:id/chegada`), ver
  `docs/relatorios/SESSAO-9B-relatorio.md` §4.
- `[DEBITO: 9B]` sem endpoint HTTP dedicado para consultar
  `recall.shipped_orders_report` isoladamente — só no retorno síncrono de
  `POST /reversa/recall`.
- `[DEBITO: 10A]` modo **Bloqueada por exceção** (RN-TEL-002) e 12 das 16
  combinações de conteúdo por etapa (`step-content.resolvers.ts`) sem teste
  de integração dedicado — implementados, revisados manualmente contra o
  schema real, mas não exercitados por teste automatizado. Ver
  `docs/relatorios/SESSAO-10A-relatorio.md` §5. ~~Frontend não consome o
  novo contrato ainda~~ — **resolvido na Sessão 10C** (2026-08-25):
  `FlowTrail.tsx` implementa DOC-17 §2 (clique sempre abre), novo
  `StepDetailPanel` genérico consome os 4 modos, ver
  `docs/relatorios/SESSAO-10C-relatorio.md`.
- `[DEBITO: 10B]` Formulário de Campo (DOC-17 §7): reserva real de tarefa
  (RN-TEL-021) só para Putaway (T-P1) — Picking/Conferência/Contagem/
  Reposição-Transferência/Carregamento têm a função de conteúdo pronta e
  testada, sem tabela de tarefa vinculada; PDF só por download, sem
  integração com `PeripheralJobService.createJob('PRINT_PDF')`; expiração é
  lazy (na leitura), sem scheduler dedicado. Ver
  `docs/relatorios/SESSAO-10B-relatorio.md` §6.
- `[LACUNA: DOC-05]` "Contagem (inventário)" (RF-TEL-003 do DOC-17) não pode
  ser exposta pelo contrato de detalhe de etapa até o inventário abrir
  `wms.operation_flow` — pré-requisito de DOC-05, fora do escopo do DOC-17.

---

## 4. Pendências externas (não são código)

**Homologação contábil (DOC-08) — RESOLVIDA em 2026-08-23.** As 3 decisões
`[VALIDAR CONTABILIDADE]` deixaram de ser valor único nacional a homologar:
o Gustavo definiu que as três são **parâmetro de cadastro por cliente×
armazém**, com o valor do DOC-08 como seed/padrão de instalação — cada
cliente real recebe o prazo/ordem/CFOP do contrato dele no próprio cadastro,
não uma constante global.
1. **RN-FIS-030** — consumo do estoque fiscal FIFO por data de emissão da Nota
   de Armazenagem, independente do lote físico. Padrão `FIFO_EMISSAO`
   (já confirmado pelo contador em 2026-08-16 como o padrão correto).
2. **RN-FIS-010** — prazo de regularização da NF de entrada (padrão 10 dias
   corridos); ao expirar, bloqueia a SAÍDA (não a entrada física).
3. **RN-FIS-050** — CFOPs 5905/6905 (remessa) e 5906/6906 (retorno), padrão
   de instalação do regime de armazém geral.

Critério de aceite da Sessão 8A: os três precisam ser reconfiguráveis por
cliente×armazém via cadastro, sem migration nova para ajustar um cliente
específico — ver `docs/PROMPT-SESSAO-8A-fiscal-estoque.md`.

**✅ Critério de aceite CONFIRMADO na Sessão 8A** (2026-08-24): os três são
resolvidos em runtime via consulta ao banco com fallback explícito — prazo em
`client_warehouse_settings.inbound_invoice_deadline_days` (coluna já
editável via `ClientWarehouseSettingsService.update()`), ordem de consumo em
`app_parameter` escopo `CLIENT_WAREHOUSE` (`FIS.ORDEM_CONSUMO`), CFOP/natureza
em `wms.operation_nature` (tenant_id/warehouse_id preenchidos = override).
Nenhum dos três ficou hardcoded — ver
`docs/relatorios/SESSAO-8A-relatorio.md` §6 para o detalhe completo.

**Validação de compliance** — matriz de compatibilidade de espécies
(DOC-05 RN-EST-021): confirmar com responsável de segurança do trabalho quais
células são proibição legal (`L`) e quais são operacional (`O`).

**Premissa de volumetria** — confirmar que 20.000 posições é por armazém e que
os 2 milhões de SKUs são o catálogo global.

**Pergunta em aberto (DOC-08, reavaliar após operar):** quando o cliente exige
lote específico (quebra de FEFO aprovada), a nota de devolução deve citar a
nota que trouxe aquele lote? Hoje coberto pelo modo `MANUAL` com controle
humano. Não emendar sem dados reais.

---

## 5. Como retomar em conversa nova

Forneça ao assistente: este documento + `CLAUDE.md` + o documento do módulo a
implementar. Isso basta — o histórico de conversa não acrescenta nada que a
especificação e os relatórios não contenham.
