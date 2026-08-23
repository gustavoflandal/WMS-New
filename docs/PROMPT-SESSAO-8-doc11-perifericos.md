# SESSÃO 8: DOC-11 — ETIQUETAS E PERIFÉRICOS (WMS EDGE AGENT)
> Modelo recomendado: MÉDIO (Sonnet). Protocolos bem especificados; a
> dificuldade está na disciplina de idempotência e no retry assimétrico.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-11-etiquetas-perifericos.md`,
> `docs/relatorios/MARCO-estado-do-sistema.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Fechar as lacunas `[LACUNA: DOC-11]` espalhadas por recebimento, packing,
pesagem e portaria: protocolo do Edge Agent, drivers de impressora térmica,
documento, balança, cancela/catraca e LPR, templates ZPL e conteúdo GS1 dos
códigos.

## REGRAS
- Cite o §/ID do DOC-11 ao definir CADA driver, job, template, error_code e
  parâmetro. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]`; débito que bloqueia o DoD não é adiável.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`; mock
  de Postgres/Redis em integração; **acesso direto do navegador a hardware**
  (RG-008 — todo periférico passa pelo Edge Agent); **retry automático em
  pesagem ou cancela** (§5.1); declarar ✅ sem saída de comando real;
  asserção comparando resultados possivelmente vazios sem afirmar que são
  não-vazios.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Herde os padrões: `actor_user_id` do JWT; auditoria em escritas (impressão e
  reimpressão são `PRINT`, RN-SEG-032); permissão por rota; eventos via
  outbox; teste de contrato de permissões atualizado a cada tabela nova.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Migrations e catálogos
`peripheral_device`, `workstation` + `workstation_device`, `peripheral_job`
(particionada mensal, RNF-ARQ-090), `label_template`, `lpr_reading`
(RD-PER-001..005). O `edge_agent` já existe da Sessão 1 — estenda, não
duplique. Permissões `PER.*` (§3) e eventos `perifericos.*` (§4.8) nos
catálogos + mapeamento evento→tópico. Parâmetros `PER.*` (§7).

### 2. Protocolo do Edge Agent (§4.1) [INVIOLÁVEL]
RNF-PER-001 (conexão WebSocket **outbound** do agent, token de dispositivo,
heartbeat 15 s, 2 perdidos = OFFLINE com alerta),
RNF-PER-002 (envelope de job exatamente como o documento: `job_id`,
`job_type`, `device_code`, `timeout_ms`, `payload`; resposta com `status`,
`result`, `error_code` do catálogo fechado por driver; estados
`PENDENTE → ENVIADO → EXECUTANDO → CONCLUIDO | FALHA | EXPIRADO`;
**reenvio idempotente por `job_id`** — agent que já executou responde o
resultado original, sem segunda impressão),
RNF-PER-003 (telemetria a cada 60 s por dispositivo, com painel e alerta nas
transições para OFFLINE/ERRO),
RF-PER-004 (Estações: mapa estação × função × dispositivo; a tela resolve o
dispositivo pela Estação da sessão; função ausente = mensagem determinística
com instrução de configuração).

### 3. Retry assimétrico (§5.1) [INVIOLÁVEL]
Retry automático (máx. 3) **somente** para `PRINT_*`. `WEIGH` e `GATE_OPEN`
**nunca** têm retry automático — re-solicitação é humana. Motivo: retry de
cancela abre o portão duas vezes; retry de pesagem grava peso de outro volume.
Teste provando a assimetria.

### 4. Códigos e templates (§4.2, §4.3)
**RN-PER-010 [INVIOLÁVEL]** — um conteúdo, duas simbologias: GS1-128 com AI
(00) + SSCC de 18 dígitos e QR com **exatamente a mesma element string**
(`(00)129000000000012346`); endereço em Code 128 com o `location.code` literal
(RN-DAD-011) e QR idêntico; lote interno em GS1-128 `(01)(10)(17)`.
**RN-PER-020** — os 5 templates ZPL padrão (`LPN_PALETE` 100×150,
`LPN_VOLUME` 100×100, `ENDERECO` 100×50, `LOTE_INTERNO` 60×40,
`CONTEUDO_PALETE` A4/PDF) com os campos obrigatórios da tabela, versionados em
`label_template` com placeholders `${campo}`; **ativação de versão exige
impressão de teste aprovada**.
RF-PER-021 (fila com validade 30 min quando o agent está offline;
**reimpressão exige `PER.REIMPRESSAO` + motivo e sai marcada `RE1`, `RE2`…**,
auditada).

### 5. Drivers (§4.4–§4.7)
- **Impressora térmica** (RNF-PER-030): ZPL II por TCP 9100 raw; configuração
  por dispositivo (IP, porta, dpmm). Não-ZPL só em emulação — um idioma só.
- **Documento** (RNF-PER-031): `PRINT_PDF` com base64 ou URL S3 pré-assinada,
  via spooler do SO.
- **Balança** (RNF-PER-040): interface única `WEIGH` →
  `{ weight_kg, unit, stable, device_code, raw_frame }`; **somente Peso
  Estável** (5 leituras consecutivas dentro de 1 divisão; sem estabilidade em
  10 s = `FALHA/TIMEOUT`, nenhum peso gravado); drivers `TOLEDO_P05`,
  `FILIZOLA_CS` e `GENERICO_CONTINUO` (parser configurável por offset/tamanho/
  fator/caractere de estabilidade). O peso gravado no negócio SEMPRE carrega
  `device_code` e `raw_frame`.
- **Cancela/catraca** (RNF-PER-050): `GATE_OPEN` por relé IP (HTTP) ou Modbus
  TCP; resposta = comando aceito pelo controlador (a passagem é confirmada
  pelo operador, RF-POR-014).
- **LPR** (RNF-PER-060): recepção por push HTTP local ou polling; normalização
  `{ plate, confidence, lane, captured_at, image_ref }`; **abaixo de
  `PER.LPR_CONFIANCA_MIN` (0,85) é sugestão editável, nunca confirmação
  automática**; imagens no S3 com a retenção da portaria.

### 6. Fechar as lacunas dos módulos já construídos
Substituir os `[LACUNA: DOC-11]` existentes por chamadas reais:
recebimento/etiquetagem (RF-REC-030), packing (RF-EXP-040), pesagem
(RF-EXP-050 — a entrada manual continua existindo com `EXP.PESO_MANUAL` para
o caso de agent indisponível, RNF-ARQ-061), portaria (RF-POR-010 LPR e
RF-POR-014 cancela), e impressão de documentos (carta de divergência, termo de
descarte, DANFE quando houver). Liste no relatório cada lacuna fechada.

### 7. Simulador de Edge Agent para teste
Implementação de referência do agent (no pacote `apps/edge-agent`, já
existente como esqueleto) que conecta, responde heartbeat e executa jobs
simulados por driver — permite testar o ciclo completo sem hardware.
**Não é mock**: é um agent real falando o protocolo real, com dispositivos
simulados. Os testes de integração usam ele.

### 8. Testes de integração (cenários do DOC-11 §6, contra containers reais)
Job idempotente no reenvio (sem segunda etiqueta); conteúdo GS1 do LPN
idêntico em GS1-128 e QR, com dígito verificador validado; peso apenas estável
(oscilação → TIMEOUT, nada gravado); peso gravado com `device_code` e
`raw_frame`; reimpressão marcada `RE1` e auditada; fila de impressão com agent
offline (30 min, ordem preservada, expiração com alerta); LPR abaixo da
confiança não confirma sozinho; cancela sem retry automático.
+ Regressão: todas as suítes anteriores verdes (267+), 2 execuções.

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas
curl localhost:3000/health/ready
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-8-relatorio.md` com
matriz requisito → arquivo → teste, a lista das lacunas fechadas nos módulos
anteriores, lacunas e débitos.

## FORA DE ESCOPO (DOC-11 §8)
RFID; print & apply; balança rodoviária; PLC/esteiras/sorters; CFTV além das
capturas LPR; pad de assinatura; editor visual de etiqueta pelo usuário.
Também fora: telas de coletor (DOC-15), fiscal (DOC-08), reversa (DOC-07),
faturamento (DOC-09), integrações (DOC-13).
