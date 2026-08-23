# ESTADO E ROTEIRO — WMS Enterprise 3PL
> Documento de retomada. Atualize ao final de cada sessão.
> Última atualização: 2026-08-16

---

## 1. Onde o projeto está

**MARCO ATINGIDO:** o sistema executa o ciclo operacional completo ponta a
ponta, com painel visual.

Ciclo comprovado por teste automatizado: agendamento → gate-in → doca →
recebimento com conferência e divergências → etiquetagem/LPN → putaway
dirigido → estoque com política de giro → pedido → liberação (validação
física e fiscal) → reserva → picking com corte → packing → pesagem →
expedição → carregamento → gate-out → `COMPLETED`, com o Painel de Operações
e a trilha verde/vermelho renderizando em tempo real.

**Números:** ~267 testes de integração + ~200 unitários, verdes em duas
execuções consecutivas; 3 papéis de backend saudáveis em Docker.

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

### Não implementados

| Doc | Módulo | Observação |
|---|---|---|
| DOC-11 | Etiquetas e periféricos | **próximo**; fecha lacunas em recebimento, packing, pesagem e portaria |
| DOC-15 | Operação em campo (coletores) | COL-1 (plataforma) + COL-2 (offline); inventário já pronto no servidor |
| DOC-08 | Fiscal (RG-014, NF-e) | 3 itens pendentes de homologação contábil (ver §4) |
| DOC-07 | Logística reversa | reutiliza muito do já construído |
| DOC-09 | Faturamento de serviços | receita do operador |
| DOC-13 | Integrações (API pública, ERP) | necessário no primeiro cliente com ERP |
| DOC-14 | Extensões futuras (IA local, workflow dinâmico) | **proposta**, não implementar |

---

## 2. Roteiro recomendado

| Ordem | Sessão | Modelo | Por quê |
|---|---|---|---|
| 1 | **DOC-11** periféricos | médio | fecha lacunas espalhadas; coletores nascem completos |
| 2 | **COL-1** plataforma de coletor | médio | leitura wedge/câmera, sessão, telas online |
| 3 | **COL-2** offline | médio | Pacote de Turno, fila, resolução de conflitos |
| 4 | **DOC-08** fiscal | premium | exige homologação contábil antes de produção |
| 5 | **DOC-07** reversa | econômico | reutiliza módulos existentes |
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
- container `frontend` e conflito de porta 3001 no host.

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
