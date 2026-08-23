---
name: wms-design-system
description: Sistema de design do WMS Enterprise 3PL. Use ao criar ou alterar QUALQUER interface do projeto — telas internas, portal do cliente, telas de coletor, componentes de @wms/ui, painéis, dashboards, formulários e tabelas. Define tokens de cor, tipografia, densidade, padrões de componente, estados semânticos (trilha verde/vermelho, severidades, estados de doca e saldo) e as regras de acessibilidade da RG-013. Responda sempre em português do Brasil.
---

# Sistema de Design — WMS Enterprise 3PL

## 0. Antes de qualquer coisa

Este é um **sistema operacional de armazém**, não um site institucional. A tela
é usada 8 horas por dia por operadores, conferentes e gestores — muitos em pé,
alguns com luvas, sob luz forte de galpão, às vezes daltônicos, sempre com
pressa. A beleza aqui é **densidade legível e ausência de ambiguidade**, não
decoração.

Três perguntas antes de desenhar qualquer tela:
1. Qual decisão a pessoa precisa tomar nesta tela?
2. Qual informação ela precisa ver para tomar essa decisão sem abrir outra tela?
3. O que acontece quando dá errado — e isso está visível?

**Proibições absolutas (RG-013 e DOC-01):**
- Comunicar estado APENAS por cor — sempre cor + ícone + rótulo textual;
- Ícones fora do conjunto Lucide;
- Biblioteca de componentes fora de `@wms/ui` (construída sobre Radix + Tailwind);
- `localStorage`/`sessionStorage` para dados de negócio — preferências vão para
  a API;
- Animação decorativa. Movimento só quando comunica algo (mudança de estado,
  chegada de item novo, progresso).

---

## 1. Direção estética

**Referência mental:** instrumento industrial de precisão — painel de controle
de equipamento sério, não dashboard de startup. Pense em sinalização de
aeroporto e em terminal de operação: informação hierarquizada, contraste alto,
zero ruído.

**O que evitar (parece template genérico):** fundo creme com serifada de
contraste e acento terracota; fundo quase-preto com um acento verde-ácido;
cartões arredondados com gradiente e sombra difusa; numeração decorativa
01/02/03 onde não há sequência real; ilustrações vazias em telas de erro.

**A assinatura visual deste sistema é a trilha de etapas** (§5). É o elemento
pelo qual o produto é reconhecido. Todo o resto ao redor fica quieto e
disciplinado para que ela se destaque.

---

## 2. Tokens de cor

Definir como variáveis CSS em `@wms/ui` e mapear no `tailwind.config`. Nunca
usar hex solto em componente.

### Superfícies e texto (tema claro — padrão de galpão)

| Token | Valor | Uso |
|---|---|---|
| `--surface-base` | `#F7F8FA` | fundo da aplicação |
| `--surface-raised` | `#FFFFFF` | cartões, tabelas, painéis |
| `--surface-sunken` | `#ECEFF3` | cabeçalho de tabela, áreas de agrupamento |
| `--border-subtle` | `#DDE2E8` | divisórias, bordas de tabela |
| `--border-strong` | `#9AA4B0` | bordas de campo, foco não interativo |
| `--text-primary` | `#111827` | texto e números principais |
| `--text-secondary` | `#4B5563` | rótulos, metadados |
| `--text-disabled` | `#9CA3AF` | desabilitado (nunca para informação relevante) |

### Marca e ação

| Token | Valor | Uso |
|---|---|---|
| `--brand` | `#0B4F8F` | azul industrial — ações primárias, links, seleção |
| `--brand-hover` | `#083F73` | estado hover da ação primária |
| `--brand-subtle` | `#E7EFF8` | fundo de item selecionado, badge informativo |
| `--focus-ring` | `#1D7DD9` | anel de foco de teclado (SEMPRE visível, 2px) |

### Estados semânticos (o núcleo do sistema)

| Token | Valor | Significado ÚNICO |
|---|---|---|
| `--state-done` | `#0F7B44` | etapa concluída, operação bem-sucedida, saldo disponível |
| `--state-done-bg` | `#E3F3EA` | fundo do estado concluído |
| `--state-pending` | `#B42318` | etapa pendente, bloqueio, rejeição, saldo indisponível |
| `--state-pending-bg` | `#FDE8E6` | fundo do estado pendente |
| `--state-warning` | `#B54708` | atraso, alerta WARN, tolerância no limite |
| `--state-warning-bg` | `#FEF0E3` | fundo de aviso |
| `--state-blocked` | `#6941C6` | bloqueado/quarentena/aguardando aprovação (≠ pendente) |
| `--state-blocked-bg` | `#F1EBFC` | fundo de bloqueio |
| `--state-neutral` | `#4B5563` | rascunho, inativo, não iniciado |
| `--state-neutral-bg` | `#EEF1F4` | fundo neutro |

**Regra inviolável:** `--state-done` e `--state-pending` significam SEMPRE a
mesma coisa em todo o sistema. Nunca use verde para "novo" ou vermelho para
"urgente" — urgência é `--state-warning`.

**Verificação de daltonismo:** o par done/pending foi escolhido com diferença
de luminosidade além do matiz (verde mais escuro, vermelho mais claro no fundo),
mas isso NÃO dispensa ícone e rótulo. Teste toda tela em escala de cinza: se a
informação sumir, o desenho está errado.

---

## 3. Tipografia

| Papel | Fonte | Uso |
|---|---|---|
| Interface | `Inter` (fallback: system-ui) | tudo que é texto de tela |
| Dados e códigos | `JetBrains Mono` (fallback: ui-monospace) | LPN, código de endereço, chave de NF-e, números de documento, quantidades em tabela |

**Por que monoespaçada para dados:** LPN de 18 dígitos, endereço `A1-012-03-02`
e chave de 44 dígitos são lidos por comparação visual. Fonte proporcional
dificulta conferir dígito a dígito e alinhar colunas numéricas.

### Escala

| Nome | Tamanho / linha | Peso | Uso |
|---|---|---|---|
| `display` | 28 / 34 | 600 | número do documento na tela da operação |
| `title` | 20 / 28 | 600 | título de tela e de seção |
| `subtitle` | 16 / 24 | 600 | título de cartão, cabeçalho de bloco |
| `body` | 14 / 20 | 400 | texto padrão da interface |
| `label` | 12 / 16 | 500, `letter-spacing: .02em` | rótulos de campo e de coluna |
| `data` | 14 / 20 mono, `tabular-nums` | 500 | quantidades, códigos, LPN |
| `data-lg` | 18 / 24 mono | 600 | quantidade em destaque (conferência, contagem) |

Números de quantidade SEMPRE com `font-variant-numeric: tabular-nums` — colunas
desalinhadas causam erro de leitura em contagem.

---

## 4. Densidade e espaçamento

Escala de 4px: `4, 8, 12, 16, 24, 32, 48`. Nada fora disso.

- **Densidade padrão (desktop de gestão):** linha de tabela 40px, padding de
  célula 8/12, cartão com padding 16.
- **Densidade confortável (tablet e telas de execução):** linha 48px, padding
  12/16, alvo de toque mínimo 44×44.
- **Coletor (DOC-15):** regras próprias — alvo ≥ 48×48, tipografia ≥ 16, ações
  na metade inferior. Não aplique a densidade de gestão em tela de coletor.

Raio de borda: `4px` em campos e botões, `6px` em cartões, `0` em tabelas.
Sombra: apenas `0 1px 2px rgba(16,24,40,.06)` em elementos elevados
(dropdown, modal, toast). Sem sombra difusa colorida.

---

## 5. A trilha de etapas (assinatura do sistema)

Componente **único e reutilizável** — serve pedido, recebimento, reversa,
transferência e inventário sem variação por tipo (RF-PAI-005 / RN-EXP-011).

Anatomia de cada etapa:

```
┌─────────────────────┐
│ [ícone]  NOME       │   ← ícone Lucide + nome da etapa
│ Concluída · 14:32   │   ← RÓTULO TEXTUAL DO ESTADO + timestamp
│ João Silva          │   ← executante (etapas concluídas)
└─────────────────────┘
```

| Estado | Cor | Ícone Lucide | Rótulo | Interação |
|---|---|---|---|---|
| Concluída | `--state-done` sobre `--state-done-bg` | `check-circle-2` | "Concluída · HH:MM" | abre em consulta |
| Pendente acionável | `--state-pending` sobre `--state-pending-bg`, borda 2px | `circle-dot` | "Pendente · iniciar" | abre a operação |
| Pendente futura | `--state-pending` a 45% de opacidade | `circle` | "Aguardando etapa anterior" | **inerte** — clique exibe "conclua a etapa anterior" |
| Bloqueada por exceção | `--state-blocked` | `shield-alert` | "Bloqueada · aguardando aprovação" | abre a exceção (se houver alçada) |

Requisitos de acessibilidade (inviolável):
- `aria-current="step"` na etapa acionável; `aria-disabled` nas futuras;
- navegação por Tab apenas nas etapas interativas;
- `role="list"` na trilha, `role="listitem"` em cada etapa;
- foco visível de 2px em `--focus-ring`;
- `prefers-reduced-motion` respeitado — sem transição de cor quando ativo.

Em telas estreitas, a trilha vira vertical mantendo a mesma semântica.

---

## 6. Padrões de componente

### Tabela operacional (o componente mais usado do sistema)
Cabeçalho fixo em `--surface-sunken`; zebra desligada (use `--border-subtle`
entre linhas); colunas numéricas alinhadas à direita com `tabular-nums`;
coluna de código em `data` (mono); linha inteira clicável quando há detalhe;
seleção múltipla com checkbox à esquerda; ordenação indicada por seta + rótulo
`aria-sort`. Estado vazio com uma frase que diz o que fazer, nunca ilustração.

### Cartão de operação (painel)
Número do documento em `data`; tipo e cliente em `label`; etapa atual com o
ícone do estado; tempo na etapa em `body`; marcas de atraso (`--state-warning`)
e de exceção (`--state-blocked`) como badges com texto. Sem sombra; borda
esquerda de 3px na cor do estado mais crítico.

### Badge de estado
Texto sempre presente; ícone à esquerda; fundo `-bg` e texto na cor do estado;
altura 22px; nunca só um ponto colorido.

### Formulário
Rótulo acima do campo (nunca placeholder como rótulo); mensagem de erro abaixo,
em `--state-pending`, dizendo o que fazer ("Informe o lote — obrigatório para
medicamentos"), não o que aconteceu; campos numéricos com teclado numérico e
`inputmode`; campos de código com fonte mono e `autocapitalize=characters`.

### Feedback de ação
Confirmação em toast de 4s, canto inferior direito, com o verbo no passado do
botão acionado ("Pedido liberado" para o botão "Liberar pedido"). Erro de API
em alerta persistente com a mensagem legível da RFC 9457, nunca stack trace.

### Estados de carregamento
Skeleton com a forma do conteúdo real (não spinner central) em tabelas e
cartões; para ações, botão em estado ocupado com rótulo "Liberando…".

---

## 7. Escrita de interface

- Nomeie pelo que a pessoa controla, não pela implementação: "Divergência de
  contagem", nunca "discrepancy record".
- Verbo no infinitivo no botão, passado no resultado: "Liberar pedido" →
  "Pedido liberado".
- Vocabulário obrigatório: use os termos de exibição do glossário do DOC-00
  §4. **Sinônimo proibido no glossário é proibido na tela.**
- Erro diz o que fazer: "Saldo fiscal insuficiente: disponível 600 de 700.
  Registre a nota de armazenagem para liberar." — não "Erro de validação".
- Vazio é convite: "Nenhuma operação pendente neste armazém." + ação, se houver.
- Sentence case em tudo (não Title Case, não CAPS exceto em códigos).

---

## 8. Processo ao criar uma tela nova

1. Identifique a decisão da tela (§0) e qual documento a especifica.
2. Liste os estados possíveis do conteúdo: carregando, vazio, com dados, erro,
   sem permissão. Desenhe os cinco — não só o feliz.
3. Escolha o padrão de §6 que serve; **não invente componente novo** se um
   existente serve com variação de props.
4. Verifique: teste em escala de cinza (a informação sobrevive?); navegue só
   com teclado (chega em tudo?); reduza a janela para 1280 e para tablet.
5. Se criou algo novo em `@wms/ui`, documente o componente e seus estados.

**Antes de entregar, remova um acessório:** olhe a tela e tire o elemento
decorativo que menos serve à decisão da §0.
