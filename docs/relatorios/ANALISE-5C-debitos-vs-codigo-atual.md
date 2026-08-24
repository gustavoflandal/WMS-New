# Análise — PROMPT-SESSAO-5C-inventario.md vs. código atual

| Metadado | Valor |
|---|---|
| Motivo | `docs/PROMPT-SESSAO-5C-inventario.md` nunca foi commitado (Sessão 5C fechou sem incluí-lo, contra a convenção `docs/PROMPT-SESSAO-*` do CLAUDE.md); antes de commitá-lo agora junto de outros arquivos soltos, era preciso confirmar se o texto do prompt ainda corresponde ao que está implementado. |
| Data | 2026-08-24 |
| Método | Comparação direta entre `PROMPT-SESSAO-5C-inventario.md` (o pedido original), `docs/relatorios/SESSAO-5C-relatorio.md` (já commitado, §6 "Lacunas e débitos") e inspeção do código atual (`inventory-count-execution.service.ts`, migration `0044-estoque-catalogo.sql`). |

---

## 1. Escopo do prompt — implementado e fechado

Todo o núcleo do prompt (§2.1–§2.7, §3, §4, §6) está implementado e coberto por
teste desde a Sessão 5C: os 7 tipos de escopo (RF-EST-060), máquina de estado
(§5.1 DOC-05), rodadas de contagem com os 2 exemplos normativos (RN-EST-062),
congelamento de endereço (RN-EST-061), acuracidade (RF-EST-064), sorteio
reprodutível, RLS e eventos via outbox. Nada de novo a fazer aqui — ver
`docs/relatorios/SESSAO-5C-relatorio.md` §3 e §7 para a matriz e a saída real
dos testes (161/161 unit, 240/240 integração, 2 execuções consecutivas).

O grão de dado ficou `endereço × produto × lote` (célula), diferente do
`endereço` isolado que a §3.1 do prompt esboça — decisão documentada e
justificada no próprio relatório da 5C (§2), não uma lacuna.

## 2. Itens do relatório da 5C — status verificado hoje

O relatório da 5C (§6) listou 3 pendências ao fechar. Reverifiquei cada uma
contra o código atual:

### 2.1 `[LACUNA]` rota/permissão de consulta de inventário em andamento — **ainda aberta**

`infra/postgres/migrations/0044-estoque-catalogo.sql:16-18` só declara
`EST.INVENTARIO_PLANEJAR`, `EST.INVENTARIO_CONTAR` e
`EST.INVENTARIO_APROVAR_AJUSTE`. Nenhuma migration posterior adicionou
permissão de leitura/consulta. Continua valendo a disciplina já registrada
pela 5B: não inventar código de permissão fora do catálogo do DOC-05 §3.

### 2.2 `[LACUNA]` custo do produto para valor do ajuste (RN-EST-063) — **ainda aberta**

`inventory-count-execution.service.ts:24-25` mantém `unitCostBrl?: number`
como campo opcional em `DecideAdjustmentInput`, com o comentário original
("não existe coluna de custo em product/batch"). Nenhum fluxo popula esse
campo automaticamente — quem chama `decideAdjustment()` precisa informá-lo
manualmente, se tiver o dado.

### 2.3 `[DÉBITO: DOC-08]` ajuste NEGATIVO reflete no Estoque Fiscal — **FECHADO, não anotado até agora**

O relatório da 5C deixou isso explicitamente para "quando o DOC-08 existir".
A Sessão 8A (commit `3e772c3`, 2026-08-24) implementou o gancho real:
`inventory-count-execution.service.ts:294-308` injeta `WriteOffPendingService`
(`../../fiscal/write-off/write-off-pending.service.ts`) e chama
`applyPendingWriteoffInTransaction()` sempre que `movementType ===
'AJUSTE_INVENTARIO_NEG'`, na mesma transação do efeito físico — exatamente o
requisito RN-EST-063/RN-FIS-070. Já está listado na matriz da
`SESSAO-8A-relatorio.md` (linha "RN-FIS-070"), mas o relatório da 5C nunca foi
atualizado para marcar esse débito como fechado — este documento registra o
fechamento formalmente.

---

## 3. Recomendação

Nenhuma ação de código necessária agora. Os dois itens de §2.1/§2.2
permanecem como débito legítimo — registrados em
`docs/relatorios/ROTEIRO-DESENVOLVIMENTO.md` (Posição 6, "Débitos
acumulados") para não se perderem antes da sessão de faxina.
