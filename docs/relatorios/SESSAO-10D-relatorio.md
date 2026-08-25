# Sessão 10D — DOC-17 §8: Transcrição de Formulário de Campo

**Data**: 2026-08-25
**Prompt**: `docs/PROMPT-SESSAO-10D-doc17-transcricao.md`
**Escopo**: DOC-17 §8 completo — RF-TEL-030, RN-TEL-031 (idempotência),
RN-TEL-032 (segregação de funções), RN-TEL-033 (validade e divergência),
RF-TEL-034 (dupla digitação), RD-TEL-003.

Fecha o ciclo aberto pela 10B: o sistema emitia o Formulário de Campo e não
tinha para onde digitar o que voltava do campo — o rodapé do próprio
formulário diz "deve retornar para digitação" (RF-TEL-020).

---

## 1. Matriz requisito → arquivo → teste

| Requisito | Arquivo | Teste |
|---|---|---|
| RF-TEL-030 — localizar pelo número, capturar linha a linha, efetivar pelos serviços de domínio | `transcription.service.ts`, `transcription.controller.ts` | `transcricao.integration.spec.ts` (caminho feliz + `findByNumber`) |
| RN-TEL-031 item 1 — chave de idempotência por linha | `transcription.service.ts::applyLine` (usa `form_line_id` como `operationId`) | idempotência coberta pelo cenário abaixo |
| RN-TEL-031 item 2 [INVIOLÁVEL] — transcrição única, replay devolve o original | `transcription.service.ts` + `UNIQUE (field_form_id)` na migration 0078 | "Transcrição é idempotente" (§10) |
| RN-TEL-031 item 3 — linha já concluída por outro canal é descartada | `applyLine` (status `DONE` → `DESCARTADA_DUPLICIDADE`) | "linha de tarefa já concluída por outro canal" (§10) |
| RN-TEL-031 item 4 — parcial permitida e retomável | `transcribe` (`PARCIALMENTE_TRANSCRITO`) | teste de linha não preenchida |
| RN-TEL-032 — segregação de funções | `assertSegregation` + `field_form.declared_executor_user_id` (0078) | "Segregação na transcrição" (§10) + 2 testes complementares |
| RN-TEL-033 — validade e divergência | `assertValidity`, tratamento de erro em `applyLine` | 2 testes (expirado abre exceção; divergência vira `REJEITADA_REGRA`) |
| RF-TEL-034 — dupla digitação | `double-entry.util.ts`, `assertDoubleEntry` | `double-entry.util.spec.ts` (10 testes, inclui o cenário 95×96 de §10) |
| RD-TEL-003 — `form_transcription` | `infra/postgres/migrations/0078-doc17-transcricao.sql` | exercitada por toda a suíte de integração |

## 2. Decisão central: paridade real, não reimplementação

RN-TEL-011 [INVIOLÁVEL] exige que a execução por papel chame **os mesmos
serviços de domínio** do coletor. A transcrição de uma linha de putaway
chama `PutawayTaskService.executeTask()` — o mesmo método que o coletor usa.
Consequências que vieram de graça, sem código novo:

- dupla validação de leitura (LPN + endereço digitados, RN-TEL-012 item 1);
- override de endereço divergente exigindo `EST.PUTAWAY_OVERRIDE` + motivo
  (RN-REC-041) — a transcrição não afrouxa nem duplica a regra;
- crédito de saldo pelo serviço único de movimentação (RN-EST-001);
- **idempotência**: `operationId = form_line_id`, a chave que RN-TEL-031
  item 1 já mandava gerar na emissão. Reprocessar não duplica efeito pelo
  mecanismo de RNF-ARQ-050 que já existia — não foi preciso inventar um
  segundo controle.

Os testes conferem o **efeito real** (saldo creditado, uma única
movimentação), não apenas o status devolvido pela linha.

## 3. Defeito real encontrado e corrigido durante a sessão

**Fail-open no controle de segregação de funções.** A primeira versão de
`assertSegregation` fazia `if (required !== 'true') return;` — ou seja, se o
parâmetro `TEL.EXIGE_SEGREGACAO_TRANSCRICAO` não estivesse configurado, a
segregação **desligava em silêncio**. É exatamente o oposto do que a regra
pede: RN-TEL-032 diz "padrão **true**", e o controle existe porque, no papel,
"quem anota e quem digita ser a mesma pessoa elimina a única verificação
independente restante" — é antifraude.

Numa instalação nova, ainda não parametrizada, o controle nasceria desligado.
Corrigido para falhar fechado: só o valor explícito `'false'` desliga.

Foi pego pelos testes de segregação, que falharam porque `cleanTestData()`
limpa `app_parameter` depois das migrations (comportamento conhecido do
harness) — a falha do teste expôs um defeito de projeto real, não um problema
de fixture.

## 4. Outras decisões

- **`field_form.declared_executor_user_id`** (novo, anulável): RN-TEL-032
  fala em "o **usuário** que consta como executante", mas a 10B só gravava o
  nome impresso no papel. Sem vínculo com usuário real a segregação é
  inaplicável. Nulo = executante não é usuário do sistema (terceiro,
  temporário) e não há segregação a aferir.
- **Guarda de RN-TEL-021 da 10B**: `assignTask` rejeita tarefa reservada por
  formulário ("outro canal"). A transcrição daquele mesmo formulário não é
  outro canal — passa `viaFieldFormId`, que só atravessa a guarda quando bate
  com o `field_form_id` da própria tarefa. Para todo o resto a guarda segue
  igual.
- **`origin = PAPEL`** (RN-TEL-012 item 3): `executeTask` fixava `'PWA'`;
  passa a aceitar a origem do chamador, com `PWA` de padrão (coletor
  intacto). O valor já tinha sido adicionado ao CHECK do `audit_log` na
  migration 0076 (REVISÃO-01); aqui o tipo `AuditOrigin` do TypeScript foi
  alargado junto — estava dessincronizado do banco.
- **Escopo de aplicação = PUTAWAY**: a 10B só ligou Putaway (T-P1) a uma
  tabela de tarefa real. Linha de tipo sem hook é **rejeitada com motivo
  explícito**, não ignorada em silêncio — o digitador precisa saber que a
  linha não foi aplicada.
- **Dupla digitação** implementada como função pura e exigida para os tipos
  que a regra cita (CONTAGEM/CONFERENCIA). Para PUTAWAY o próprio RF-TEL-034
  não a exige. Fica correta onde se aplica, em vez de adiada inteira.

## 5. Saída real dos comandos

```
$ pnpm build
 Tasks:    5 successful, 5 total

$ pnpm test
@wms/backend:test:  Test Files 26 passed (26) | Tests 248 passed (248)
@wms/ui:test:       Test Files 3 passed (3)   | Tests 22 passed (22)
@wms/frontend:test: Test Files 7 passed (7)   | Tests 37 passed (37)

$ pnpm test:integration   (execução 1/2)
 Test Files 81 passed (81) | Tests 358 passed (358)

$ pnpm test:integration   (execução 2/2)
 Test Files 81 passed (81) | Tests 358 passed (358)

$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-backend-api Started   (... todos healthy)

$ curl localhost:3000/health/ready
{"status":"ok","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ curl -X POST localhost:3000/transcricoes/formularios/abc -d '{}'
401   # rota protegida pelo PermissionGuard (não 404)
```

Backend: 238 → 248 unitários (+10 dupla digitação). Integração: 348 → 358
(+10 transcrição).

O contrato de grants (`grants-contract.integration.spec.ts`) reprovou a
primeira execução por `form_transcription` não estar declarada — exatamente
a função dele. Declarada e reexecutado.

## 6. Sem tela nesta sessão

A tela de transcrição (RF-TEL-030 na interface) é frontend e segue o padrão
do projeto de backend primeiro (DOC-06/DOC-07/10A). Por isso não há
`screenshots/sessao-10d/`.

## 7. Lacunas e débitos

**Fechado nesta sessão**: DOC-17 §8 inteiro para o fluxo Putaway; os 3
cenários Gherkin de §10 sobre transcrição + o de dupla digitação (unitário,
já que CONTAGEM ainda não tem hook de aplicação).

**Em aberto:**
- `[DEBITO: 10B]` linhas de Picking/Conferência/Contagem/Reposição/
  Carregamento não são aplicáveis por transcrição — falta o hook de tarefa
  real desses tipos (herdado da 10B, agora com efeito visível: a transcrição
  as rejeita com motivo).
- `[DEBITO: 10D]` fechamento do saldo remanescente de uma transcrição
  parcial "com motivo" (RN-TEL-031 item 4, parte final) não tem endpoint
  próprio: hoje o formulário fica `PARCIALMENTE_TRANSCRITO` indefinidamente.
- `[DEBITO: 10D]` `TEL.TRANSCRICAO_DIVERGENTE` está no catálogo (0078) mas
  ainda não é aberta automaticamente: a divergência hoje vira
  `REJEITADA_REGRA` com o motivo do domínio. Abrir a exceção exige mapear
  quais rejeições do módulo de origem são "aprováveis" — decisão que o
  DOC-17 delega ao módulo de origem e que merece sessão própria.
- Tela de transcrição (frontend).
- **Execução por Tela (§6)** inteira: RN-TEL-010/011/012, RF-TEL-013 (as 8
  telas T-P1..T-P8), `execution_channel` (RD-TEL-004). É o que resta do
  DOC-17.
