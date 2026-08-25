# ROTEIRO DE DESENVOLVIMENTO — MÓDULOS RESTANTES
## WMS Enterprise 3PL

| Metadado | Valor |
|---|---|
| Documento | ROTEIRO-DESENVOLVIMENTO |
| Versão | 1.8 |
| Data | 2026-08-25 |
| Situação de partida | MARCO atingido; DOC-11, DOC-15 (COL-1/COL-2A/COL-2B), DOC-08 completo (8A+8B), DOC-07 completo (9A+9B) e DOC-17 Parte A (10A, detalhe de etapa) concluídos; DOC-17 Parte B (10B) é a próxima |
| Complementa | `CLAUDE.md` (método) e `ESTADO-E-ROTEIRO.md` (estado consolidado) |

---

## 1. Propósito

Registrar a **ordem de desenvolvimento dos módulos restantes e a justificativa
de cada posição**. A ordem não é preferência: decorre de dependências técnicas
reais entre módulos. Alterá-la é possível, mas exige entender o que se perde —
cada item traz a dependência que o posiciona.

Regra geral que rege todo o roteiro: **um módulo não deve ser construído antes
daquele de que ele depende, sob pena de nascer com lacuna no ponto mais
importante.**

---

## 2. Situação de partida

**Concluídos:** DOC-01 (arquitetura), DOC-02 (dados), DOC-12 (segurança),
DOC-03 (portaria), DOC-04 (recebimento e putaway), DOC-05 (estoque, seleção de
saldo e inventários), DOC-06 (expedição), DOC-10 (painéis e KPIs), DOC-11
(etiquetas e periféricos), DOC-15 (operação em campo — COL-1 + COL-2A + COL-2B).

**MARCO:** o ciclo operacional completo roda ponta a ponta, com painel e
trilha verde/vermelho, comprovado por teste automatizado — e agora também com
hardware real (periféricos) e coletores (online e offline-first).

**Próximo:** DOC-07 (Logística Reversa), posição 3 deste roteiro. DOC-08
fechou por completo em 2026-08-25 — 8A (ciclo do Estoque Fiscal, 2026-08-24)
+ 8B (motor de emissão NF-e, 2026-08-25) — ver `docs/relatorios/SESSAO-8A-relatorio.md`
e `docs/relatorios/SESSAO-8B-relatorio.md`. `StorageReturnInvoiceService.reverseConsumption()`
(RN-FIS-041) já existe e está testável isoladamente, pronto para o DOC-07
chamar — falta só o gatilho real.

---

## 3. Sequência

### Posição 0 — DOC-11 · Etiquetas e Periféricos ✅ *(concluído)*
**Modelo:** médio · **Sessões:** 1

Fecha as lacunas `[LACUNA: DOC-11]` espalhadas por recebimento (etiqueta de
palete), packing (etiqueta de volume), pesagem (balança) e portaria (cancela e
LPR). Entrega o protocolo do Edge Agent, os drivers, os templates ZPL e o
simulador de agent para teste sem hardware.

---

### Posição 1 — DOC-15 · Operação em Campo (coletores) ✅ *(concluído)*
**Modelo:** médio · **Sessões:** 3 (COL-1 plataforma, COL-2A motor offline
servidor, COL-2B telas de execução offline — o offline-first precisou de
dupla sessão backend/frontend, não estimado no roteiro original)

**Por que aqui:** depende diretamente do DOC-11 — as telas de campo precisam de
impressão de etiqueta e do validador de leitura entregues na posição 0. E o
motor de inventário (DOC-05 §4.7) já está pronto no servidor, de modo que a
tela de contagem (T5) nasce completa, atendendo a prioridade declarada pelo
cliente.

- **COL-1:** registro de dispositivo, leitura por leitor físico (modo teclado)
  e câmera, validador universal de códigos, sessão com PIN, telas T1/T7/T8
  online.
- **COL-2:** Pacote de Turno, fila de sincronização em IndexedDB, resolução
  determinística de conflitos (RN-ARQ-053) no servidor, telas T2–T6 offline,
  atualização controlada de versão.

**Ao final desta posição** o armazém opera de fato com hardware: coletores,
impressoras e balanças. Ver §4 (janela de piloto).

---

### Posição 2 — DOC-08 · Fiscal ✅ *(concluído)*
**Modelo:** premium · **Sessões:** 2 (8A ciclo do estoque fiscal ✅, 8B motor de emissão ✅ — ambas concluídas)
**Prompts:** `docs/PROMPT-SESSAO-8A-fiscal-estoque.md`, `docs/PROMPT-SESSAO-8B-fiscal-emissao.md` (ambos concluídos)

**Por que aqui:** é o divisor entre "sistema que funciona" e "sistema que pode
operar 3PL". Antes da 8A a etapa Expedição só concluía para clientes
`INTEGRADO_ERP` com confirmação manual; `EMISSAO_PROPRIA` e `HIBRIDO`
permaneciam bloqueados por lacuna explícita.

- **8A ✅ (concluída 2026-08-24):** registro da NF de entrada e prazo de
  regularização (RN-FIS-010, reaproveitando `wms.inbound_invoice` do DOC-04),
  Nota de Armazenagem e crédito do estoque fiscal (RF-FIS-020/RN-FIS-021),
  ordem de consumo (RN-FIS-030), Nota de Devolução de Armazenagem com uma
  linha por (produto × nota consumida) e consumo efetivado apenas na
  autorização (RN-FIS-040 — "autorização" nesta sessão é um método explícito,
  substituto testável da SEFAZ real), recomposição por reversa isolada
  (RN-FIS-041, sem gatilho — DOC-07 não existe ainda), pendências documentais
  de descarte e ajuste (RN-FIS-070). `DispatchService.confirmFiscalDocuments`
  (DOC-06) já chama o motor real para `EMISSAO_PROPRIA`/`HIBRIDO`, não mais
  bloqueia. Ver `docs/relatorios/SESSAO-8A-relatorio.md` para a matriz
  completa, débitos e decisões.
- **8B ✅ (concluída 2026-08-25):** motor de emissão NF-e real —
  DRAFT→SIGNED→TRANSMITTED→AUTHORIZED/REJECTED/DENIED (DOC-08 §5.1 completo),
  numeração sequencial-sem-lacunas com reserva atômica, simulador SEFAZ
  determinístico (usado pelos testes) + adaptador SOAP real (estrutural,
  fora do caminho testado — mesma decisão do Edge Agent), contingência SVC
  (3 falhas → CONTINGENCIA_SVC, monitor de disponibilidade reverte),
  cancelamento e CCe (reaproveitando `reverseConsumption()` da 8A),
  certificados A1 cifrados (AES-256-GCM, primeiro utilitário de cifragem do
  projeto), DANFE via `pdf-lib`, inutilização mensal de número pulado.
  `DispatchService.confirmFiscalDocuments` deixou de autorizar sincronamente
  — só monta, o worker assíncrono assume. Débitos abertos: XML-DSig sem
  canonicalização C14N, tabela de endpoints SEFAZ por UF incompleta (só SP),
  guarda de XML sem object-lock real — ver `docs/relatorios/SESSAO-8B-relatorio.md`
  §7 para a lista completa e justificativa de cada um.

**Homologação contábil — resolvida em 2026-08-23, critério de aceite
CONFIRMADO pela 8A em 2026-08-24:** os três itens `[VALIDAR CONTABILIDADE]`
(prazo RN-FIS-010, ordem de consumo RN-FIS-030, CFOPs RN-FIS-050) não são
valor único nacional a homologar — são parâmetro de cadastro por
cliente×armazém, com os valores do DOC-08 como seed/padrão de instalação (10
dias, `FIFO_EMISSAO`, 5905/6905/5906/6906). A 8A implementou e confirmou que
os três são resolvidos em runtime (consulta ao banco + fallback), nenhum
hardcoded — ver `docs/relatorios/SESSAO-8A-relatorio.md` §6.

---

### Posição 3 — DOC-07 · Logística Reversa
**Modelo:** econômico→médio · **Sessões:** 2 (9A núcleo ✅ concluída 2026-08-25, 9B integração+recall)

**Por que aqui:** dependência real do DOC-08. A RN-REV-023 exige que a etapa
Destinação só conclua com o tratamento fiscal registrado, e a recomposição do
estoque fiscal (estorno do consumo, RN-FIS-041) é regra do módulo fiscal.
Construída antes, a reversa nasceria com lacuna justamente no ponto que a torna
correta. `StorageReturnInvoiceService.reverseConsumption()` (RN-FIS-041) já
existe desde a 8A, testável isoladamente e pronto para o DOC-07 chamar — a 9A
já a chama de verdade (`ReturnTriageService.recomposeFiscal`).

**Por que virou 2 sessões (achado real, não estimativa a priori):** a
premissa "reutiliza portaria, doca, conferência" só é verdadeira em espírito.
Leitura de código na 9A mostrou que `DockService.dockVehicle()` é hardcoded
para `wms.inbound_order` e `GateInService.registerGateIn()` valida contra
`wms.appointment` — nenhum dos dois é genérico por entidade. A 9A implementou
a mecânica de doca/descarga própria (sem alterar DOC-04) e um vínculo de
chegada MANUAL (sem alterar DOC-03); a 9B fica com a integração real
(devolução sem agendamento, `REV.SEM_AUTORIZACAO` automático no gate-in,
`RECUSA_ENTREGA` automática) e o Recall (RF-REV-030). Ver
`docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md` e
`docs/relatorios/SESSAO-9A-relatorio.md`.

---

### Posição 4 — DOC-17 · Detalhe de Etapas e Execução por Tela
**Modelo:** médio · **Sessões:** 2 (10A Parte A — detalhe/drill-down, ✅ concluída 2026-08-25; 10B Parte B — execução por tela + formulários de campo)
**Documento:** `docs/DOC-17-detalhe-etapas-execucao-por-tela.md` (aprovado 2026-08-16, registrado no roteiro em 2026-08-24)

**Por que aqui, e não na posição sugerida pelo próprio §13 do documento**
("logo após COL-1 e antes de COL-2"): a tabela "Depende de" do DOC-17 lista
DOC-07 como dependência real — RF-TEL-003 tem uma linha de detalhe para
"Triagem/Destinação (reversa)" que só existe depois da Posição 3. O §13 foi
escrito em 2026-08-16, antes do DOC-08/DOC-07 serem reordenados para as
Posições 2 e 3 atuais; a lista de dependências declarada no próprio documento
é o critério mais confiável, não a posição em prosa. Fica antes do DOC-09 e
DOC-13 porque não depende de nenhum dos dois.

**Por que importa não adiar demais:** DOC-17 §2 emenda formalmente DOC-06
RN-EXP-011 item 3 e DOC-10 RF-PAI-005 item 4 — o comportamento hoje em
produção ("clique em etapa futura é inerte") passa a ser "abre em modo
previsão, sem controles de execução". A 10A entregou o CONTRATO backend
(`GET .../fluxo-operacional/:entity/:entityId/steps/:stepCode/detail`) que
torna isso possível, mas `FlowTrail.tsx` (frontend) ainda não o consome —
o comportamento "inerte" continua em produção até uma sessão de frontend
(dedicada, mesmo padrão de DOC-06/DOC-07: backend primeiro) ligar os dois.

Parte A (detalhe) foi de fato aditiva e barata: 1 sessão, sem tocar em
nenhum service de escrita existente. Parte B (execução por tela +
formulários impressos) é o subsistema novo e maior — Formulário de Campo,
Transcrição com dupla digitação e idempotência por linha, `execution_
channel`, as 8 telas T-P1..T-P8 — amplia o alcance comercial para clientes
sem coletores e serve de contingência quando o parque de coletores falha —
reaproveita os mesmos serviços de domínio já prontos (RN-TEL-011), sem
caminho de regra paralelo. Ver `docs/relatorios/SESSAO-10A-relatorio.md`.

---

### Posição 5 — DOC-09 · Faturamento de Serviços
**Modelo:** médio · **Sessões:** 1

**Por que aqui:** é independente dos demais e pode ser antecipado se a receita
do operador se tornar urgente. Fica depois da reversa porque o item tarifável
`MOV_REVERSA_ITEM` passa a ter origem real, e o snapshot diário já encontra
todos os tipos de movimentação em uso — a apuração nasce completa.

Contratos e tabelas de tarifa versionadas, apuração determinística (snapshot
diário + eventos), fechamento de período, Pré-Fatura com conferência e
contestação do cliente, envio ao ERP do operador.

---

### Posição 6 — DOC-13 · Integrações
**Modelo:** médio · **Sessões:** 1

**Por que por último entre os módulos:** só é necessário quando entrar o
primeiro cliente com ERP a integrar, e a reconciliação diária de saldo faz
mais sentido com todos os módulos que alteram saldo já existentes. Os
contratos canônicos também ficam mais estáveis com o sistema completo — uma
API publicada cedo demais engessa o que ainda vai mudar.

API pública versionada com idempotência obrigatória, webhooks assinados,
contratos canônicos, arquitetura de conectores plugáveis por cliente,
reconciliação diária (WMS é fonte de verdade do estoque físico).

---

### Posição 7 — RG-016 (modos de operação) e faxinão de débitos
**Modelo:** econômico · **Sessões:** 1 (meia sessão para cada bloco)

Encaixável em qualquer momento; agrupado aqui por conveniência.

- **RG-016 — modo `PROPRIO`:** parâmetro `APP.MODO_OPERACAO`, rejeição de
  segundo cliente ativo, validação da troca de modo, resolução de `client_id`
  no servidor, e ocultação de seletores de Cliente na interface.
- **Débitos acumulados:** `vehicle_type` como texto livre (DOC-03), convenção
  de dia da semana das janelas, cobertura de teste do `DockService`, conflito
  da porta 3001 no host, altura de palete e faixa de temperatura no modelo
  (DOC-02), integração de conferência no recebimento inter-armazém, permissão
  de consulta de inventário em andamento e custo do produto para valor de
  ajuste de inventário (RN-EST-063, DOC-05 — reverificados em 2026-08-24, ver
  `docs/relatorios/ANALISE-5C-debitos-vs-codigo-atual.md`).

---

### Fora do roteiro — DOC-14 · Extensões futuras
**Status:** proposta (v0.1.0), **não implementar**.

Assistente de IA local para operadores e workflow dinâmico com construtor
visual. Exigem emendas formais ao DOC-00/04/06/12 antes de qualquer código.
Reavaliar após o roteiro acima concluído. Ordem recomendada quando chegar a
hora: workflow dinâmico primeiro, assistente depois.

---

## 4. Janela recomendada de piloto real

Ao final da **Posição 1** (coletores), o sistema opera um armazém completo:
recebe, armazena com endereçamento dirigido, conta, expede, com hardware e
painel. **Recomenda-se rodar um piloto real nesse ponto**, antes do DOC-08.

Motivo: seis semanas de operação real ensinam mais sobre prioridades do que
qualquer roteiro, e o módulo fiscal é construído com muito mais precisão
sabendo quais casos realmente ocorrem na operação — em vez de implementar
todos os cenários previstos com o mesmo peso.

Um piloto em modo `PROPRIO` (RG-016) dispensa o fiscal de armazém geral e é
viável imediatamente.

---

## 5. Resumo

| # | Módulo | Modelo | Sessões | Status |
|---|---|---|---|---|
| 0 | DOC-11 periféricos | médio | 1 | ✅ concluído |
| 1 | DOC-15 coletores | médio | 3 (COL-1/COL-2A/COL-2B) | ✅ concluído |
| — | *piloto real recomendado* | — | — | decisão do Gustavo, não bloqueia |
| 2 | DOC-08 fiscal | premium | 2 (8A/8B) | ✅ concluído (8A 2026-08-24, 8B 2026-08-25) |
| 3 | DOC-07 reversa | econômico→médio | 2 (9A núcleo/9B integração+recall) | ✅ concluído (9A 2026-08-25, 9B 2026-08-25) |
| 4 | DOC-17 detalhe/execução por tela | médio | 2 (10A Parte A/10B Parte B) | 10A ✅ concluída (2026-08-25); 10B pronta para começar |
| 5 | DOC-09 faturamento | médio | 1 | aguarda DOC-07 |
| 6 | DOC-13 integrações | médio | 1 | aguarda sistema completo |
| 7 | RG-016 + débitos | econômico | 1 | encaixável a qualquer momento |

Total estimado: **13 sessões** até a especificação integralmente
implementada (o offline-first do DOC-15 exigiu dividir COL-2 em backend/
frontend; o DOC-07 — achado real de código na 9A, não estimativa a priori —
precisou dividir em núcleo (9A) e integração com portaria/recall (9B):
`DockService`/`GateInService` são hardcoded para `inbound_order`/
agendamento, sem generalização segura dentro do orçamento de uma sessão só;
o DOC-17 (aprovado em 2026-08-16) fica em 2 sessões (10A Parte A concluída,
10B Parte B), a divisão que o próprio documento já sugeria em seu §13). Ver
`docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md` e
`docs/PROMPT-SESSAO-10A-doc17-detalhe-etapa.md`.

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0 | 2026-08-16 | Versão inicial — sequência definida após o MARCO |
| 1.1 | 2026-08-23 | DOC-11 e DOC-15 (COL-1/COL-2A/COL-2B) marcados concluídos; prompts da Posição 2 (DOC-08 8A/8B) adicionados; total de sessões ajustado de 9 para 10 |
| 1.2 | 2026-08-24 | DOC-08A (ciclo do Estoque Fiscal) marcado concluído — ver `docs/relatorios/SESSAO-8A-relatorio.md`; DOC-08B (motor de emissão) passa a ser o próximo item da fila |
| 1.3 | 2026-08-24 | Débitos acumulados (então Posição 6, hoje Posição 7) recebem 2 itens reverificados da Sessão 5C (permissão de consulta de inventário, custo do produto para ajuste) — ver `docs/relatorios/ANALISE-5C-debitos-vs-codigo-atual.md` |
| 1.4 | 2026-08-24 | DOC-17 (Detalhe de Etapas e Execução por Tela, aprovado 2026-08-16, achado avulso sem registro anterior no roteiro) inserido como nova Posição 4, entre DOC-07 e DOC-09 — sua tabela "Depende de" exige DOC-07, embora o §13 do próprio documento sugerisse uma posição mais cedo; DOC-09, DOC-13 e RG-016+débitos deslocam para as Posições 5, 6 e 7 |
| 1.5 | 2026-08-25 | DOC-08B (motor de emissão NF-e) marcado concluído — ver `docs/relatorios/SESSAO-8B-relatorio.md`; DOC-08 fecha por completo (8A+8B); DOC-07 (reversa) passa a ser o próximo item da fila |
| 1.6 | 2026-08-25 | DOC-07 dividido em 9A (núcleo: Ordem de Devolução, Triagem, Destinação, gancho fiscal) e 9B (integração com Gate-in/Portaria, Recall) — achado de código, não estimativa a priori (`DockService`/`GateInService` hardcoded para `inbound_order`/agendamento). 9A concluída — ver `docs/relatorios/SESSAO-9A-relatorio.md`. Total de sessões ajustado de 11–12 para 12–13 |
| 1.7 | 2026-08-25 | DOC-07 9B (RN-REV-002 real no gate-in, RF-REV-001 `RECUSA_ENTREGA` automática, RF-REV-030 Recall completo) concluída — ver `docs/relatorios/SESSAO-9B-relatorio.md`. DOC-07 fecha por completo (9A+9B), os 6 cenários Gherkin do DOC-07 §6 cobertos. DOC-17 passa a ser o próximo item da fila |
| 1.8 | 2026-08-25 | DOC-17 dividido em 10A (Parte A — detalhe de etapa) e 10B (Parte B — execução por tela + formulários), mesma divisão que o §13 do próprio documento já sugeria. 10A concluída — ver `docs/relatorios/SESSAO-10A-relatorio.md`; achado no caminho: `wms_worker` sem GRANT em `wms.return_order` (migration 0074), `return_order` faltando na UNION do painel de operações (comentário desatualizado desde a 9A) |
