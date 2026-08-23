# ESTADO E ROTEIRO — WMS Enterprise 3PL
> Documento de retomada. Atualize ao final de cada sessão.
> Última atualização: 2026-08-23

---

## 1. Onde o projeto está

**MARCO ATINGIDO:** o sistema executa o ciclo operacional completo ponta a
ponta, com painel visual, **e agora também opera com hardware real**:
periféricos (DOC-11) e coletores online/offline (DOC-15) concluídos.

Ciclo comprovado por teste automatizado: agendamento → gate-in → doca →
recebimento com conferência e divergências → etiquetagem/LPN → putaway
dirigido → estoque com política de giro → pedido → liberação (validação
física e fiscal) → reserva → picking com corte → packing → pesagem →
expedição → carregamento → gate-out → `COMPLETED`, com o Painel de Operações
e a trilha verde/vermelho renderizando em tempo real. Operação de campo
(coletor PWA) cobre as 8 telas do catálogo fechado (T1–T8), online e
offline-first, com resolução determinística de conflitos de sincronização.

**Números (2026-08-23):** 302 testes de integração do backend + 193
unitários (verdes em duas execuções consecutivas), 35 testes unitários/
componente do frontend; 3 papéis de backend saudáveis em Docker.

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

### Não implementados

| Doc | Módulo | Observação |
|---|---|---|
| DOC-08 | Fiscal (RG-014, NF-e) | **próximo**; 2 de 3 itens ainda pendentes de homologação contábil (ver §4) — prompts prontos em `docs/PROMPT-SESSAO-8A-fiscal-estoque.md`/`8B-fiscal-emissao.md` |
| DOC-07 | Logística reversa | reutiliza muito do já construído; depende do DOC-08 |
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
| 4 | **DOC-08A** fiscal — ciclo do estoque | premium | **próximo** — prompt pronto, pausa de homologação contábil no topo |
| 4 | **DOC-08B** fiscal — motor de emissão | premium | depende da 8A |
| 5 | **DOC-07** reversa | econômico | depende do DOC-08 |
| 6 | **DOC-09** faturamento | médio | aritmética half-even já validada |
| 7 | **DOC-13** integrações | médio | quando entrar cliente com ERP |
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

---

## 4. Pendências externas (não são código)

**Homologação contábil (DOC-08)** — 3 decisões marcadas
`[VALIDAR CONTABILIDADE]`, com posição padrão adotada:
1. **RN-FIS-030** — consumo do estoque fiscal FIFO por data de emissão da Nota
   de Armazenagem, independente do lote físico. *Confirmado pelo contador em
   2026-08-16.*
2. **RN-FIS-010** — prazo de 10 dias corridos para regularização da NF de
   entrada; ao expirar, bloqueia a SAÍDA (não a entrada física). *Pendente.*
3. **RN-FIS-050** — CFOPs 5905/6905 (remessa) e 5906/6906 (retorno).
   *Pendente.*

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
