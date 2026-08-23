# ROTEIRO DE DESENVOLVIMENTO — MÓDULOS RESTANTES
## WMS Enterprise 3PL

| Metadado | Valor |
|---|---|
| Documento | ROTEIRO-DESENVOLVIMENTO |
| Versão | 1.0 |
| Data | 2026-08-16 |
| Situação de partida | MARCO atingido; DOC-11 em desenvolvimento |
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
saldo e inventários), DOC-06 (expedição), DOC-10 (painéis e KPIs).

**MARCO:** o ciclo operacional completo roda ponta a ponta, com painel e
trilha verde/vermelho, comprovado por teste automatizado.

**Em desenvolvimento:** DOC-11 (etiquetas e periféricos).

---

## 3. Sequência

### Posição 0 — DOC-11 · Etiquetas e Periféricos *(em andamento)*
**Modelo:** médio · **Sessões:** 1

Fecha as lacunas `[LACUNA: DOC-11]` espalhadas por recebimento (etiqueta de
palete), packing (etiqueta de volume), pesagem (balança) e portaria (cancela e
LPR). Entrega o protocolo do Edge Agent, os drivers, os templates ZPL e o
simulador de agent para teste sem hardware.

---

### Posição 1 — DOC-15 · Operação em Campo (coletores)
**Modelo:** médio · **Sessões:** 2 (COL-1 plataforma, COL-2 offline)

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

### Posição 2 — DOC-08 · Fiscal
**Modelo:** premium · **Sessões:** 2 (8A ciclo do estoque fiscal, 8B motor de emissão)

**Por que aqui:** é o divisor entre "sistema que funciona" e "sistema que pode
operar 3PL". Hoje a etapa Expedição só conclui para clientes
`INTEGRADO_ERP` com confirmação manual; `EMISSAO_PROPRIA` e `HIBRIDO`
permanecem bloqueados por lacuna explícita.

- **8A:** registro da NF de entrada e prazo de regularização (RN-FIS-010),
  Nota de Armazenagem e crédito do estoque fiscal, ordem de consumo
  (RN-FIS-030), Nota de Devolução de Armazenagem com uma linha por
  (produto × nota consumida) e consumo efetivado apenas na autorização,
  pendências documentais de descarte e ajuste.
- **8B:** motor de emissão NF-e (montagem, assinatura, transmissão,
  contingência SVC, cancelamento, CCe, inutilização), certificados A1
  cifrados, guarda de XML com object-lock, DANFE.

**Pré-requisito externo obrigatório:** homologação contábil dos itens
`[VALIDAR CONTABILIDADE]` ainda pendentes — prazo de regularização
(RN-FIS-010) e CFOPs (RN-FIS-050). A ordem de consumo (RN-FIS-030) já foi
confirmada pelo contador em 2026-08-16. **Emitir com CFOP errado é caro de
desfazer.**

---

### Posição 3 — DOC-07 · Logística Reversa
**Modelo:** econômico · **Sessões:** 1

**Por que aqui:** dependência real do DOC-08. A RN-REV-023 exige que a etapa
Destinação só conclua com o tratamento fiscal registrado, e a recomposição do
estoque fiscal (estorno do consumo, RN-FIS-041) é regra do módulo fiscal.
Construída antes, a reversa nasceria com lacuna justamente no ponto que a torna
correta.

Custo baixo porque reutiliza portaria, doca, conferência, movimentações e
motor de putaway já prontos: o módulo especifica basicamente triagem,
matriz de destinação e recall.

---

### Posição 4 — DOC-09 · Faturamento de Serviços
**Modelo:** médio · **Sessões:** 1

**Por que aqui:** é independente dos demais e pode ser antecipado se a receita
do operador se tornar urgente. Fica depois da reversa porque o item tarifável
`MOV_REVERSA_ITEM` passa a ter origem real, e o snapshot diário já encontra
todos os tipos de movimentação em uso — a apuração nasce completa.

Contratos e tabelas de tarifa versionadas, apuração determinística (snapshot
diário + eventos), fechamento de período, Pré-Fatura com conferência e
contestação do cliente, envio ao ERP do operador.

---

### Posição 5 — DOC-13 · Integrações
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

### Posição 6 — RG-016 (modos de operação) e faxinão de débitos
**Modelo:** econômico · **Sessões:** 1 (meia sessão para cada bloco)

Encaixável em qualquer momento; agrupado aqui por conveniência.

- **RG-016 — modo `PROPRIO`:** parâmetro `APP.MODO_OPERACAO`, rejeição de
  segundo cliente ativo, validação da troca de modo, resolução de `client_id`
  no servidor, e ocultação de seletores de Cliente na interface.
- **Débitos acumulados:** `vehicle_type` como texto livre (DOC-03), convenção
  de dia da semana das janelas, cobertura de teste do `DockService`, conflito
  da porta 3001 no host, altura de palete e faixa de temperatura no modelo
  (DOC-02), integração de conferência no recebimento inter-armazém.

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

| # | Módulo | Modelo | Sessões | Dependência que o posiciona |
|---|---|---|---|---|
| 0 | DOC-11 periféricos | médio | 1 | — (em andamento) |
| 1 | DOC-15 coletores | médio | 2 | precisa de impressão e leitura (DOC-11) |
| — | *piloto real recomendado* | — | — | sistema operacional completo |
| 2 | DOC-08 fiscal | premium | 2 | homologação contábil pendente |
| 3 | DOC-07 reversa | econômico | 1 | recomposição fiscal (DOC-08) |
| 4 | DOC-09 faturamento | médio | 1 | tarifação de reversa (DOC-07) |
| 5 | DOC-13 integrações | médio | 1 | contratos estáveis com sistema completo |
| 6 | RG-016 + débitos | econômico | 1 | encaixável a qualquer momento |

Total estimado: **9 sessões** até a especificação integralmente implementada.

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0 | 2026-08-16 | Versão inicial — sequência definida após o MARCO |
