# SESSÃO 7B: DOC-10 FRONTEND — PAINEL, TRILHA DE ETAPAS E DASHBOARD
> Modelo recomendado: MÉDIO (Sonnet). Primeira sessão majoritariamente de UI.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-10-paineis-dashboards-tempo-real.md`,
> `docs/relatorios/SESSAO-7A-relatorio.md`.
> NÃO carregue outros documentos.
> **Antes de começar:** libere a porta 3001 no host (o container `frontend`
> não sobe por conflito). `netstat -ano | findstr :3001`.

---

## MISSÃO
Dar rosto ao sistema: a tela do Fluxo Operacional verde/vermelho, o Painel de
Operações com tempo real, centro de alertas, chat e dashboard. Consome
exclusivamente os endpoints da 7A e o contrato de fluxo da 6A.

## REGRAS
- Cite o §/ID do DOC-10 ao definir CADA comportamento de tela.
- É PROIBIDO: **comunicar estado apenas por cor** (RF-PAI-005 item 3);
  criar biblioteca de componentes nova (use `@wms/ui`); usar ícones fora do
  Lucide (RG-013); `localStorage`/`sessionStorage` para dados de negócio;
  **criar uma segunda leitura das etapas** — consuma o contrato único da 6A;
  declarar ✅ sem evidência real (screenshot ou teste de componente).
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- Stack: Next.js App Router (área `internal`), Tailwind, `@wms/ui`, Lucide.
  Sem novas dependências de UI sem justificativa em ADR.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Componente da trilha de etapas (RF-PAI-005) [O CORAÇÃO]
Trilha horizontal das etapas do Fluxo Operacional, na ordem, cada uma com:
- `DONE`: verde + ícone de check + rótulo textual do estado;
- `PENDING` acionável (primeira pendente): vermelho com realce, cursor de
  ação, rótulo textual;
- `PENDING` posterior: vermelho esmaecido, desabilitado, rótulo textual;
- **acessibilidade [INVIOLÁVEL]**: ícone + texto além da cor (WCAG 2.1 AA);
  navegável por teclado; `aria-*` adequados;
- clique conforme RN-EXP-011: acionável abre a tela da operação; **posterior é
  inerte exibindo "conclua a etapa anterior"**; concluída abre modo consulta;
- indicador de exceção bloqueante sobre a etapa, com acesso à exceção para
  quem tem alçada;
- detalhe da etapa concluída: timestamp e executante (RG-003).
Componente reutilizável: serve pedido, recebimento, reversa, transferência e
inventário sem variação por tipo.

### 2. Painel de Operações (RF-PAI-001..004)
Lista de cartões (número, tipo, cliente, etapa atual e tempo nela, indicador
de exceção, marca de atraso), filtros combináveis e ordenação padrão
(atrasados primeiro, depois maior tempo na etapa), preferências persistidas
via endpoint da 7A (**não** em storage do navegador).
**RF-PAI-003 — tempo real:** assinatura do tópico `painel_operacoes` via
WebSocket (ponte já corrigida na 7); atualização do cartão sem recarga em
≤ 2 s; **sem reordenação brusca enquanto o usuário interage** — reposicionar
apenas em re-render explícito ou rolagem. Indicador visível de modo degradado
quando cair para SSE/polling (DOC-01 §5.1).

### 3. Centro de alertas e chat
Alertas com badge de não lidos no cabeçalho, agrupamento por severidade,
marcação de lido e navegação ao objeto de origem.
Chat: sala do armazém-turno e sala da operação (aberta a partir do cartão/
tela do fluxo), menções, anexo de imagem. **Sem nenhuma ação operacional na
interface do chat** (RN-PAI-031).

### 4. Dashboard (RF-PAI-040, RF-PAI-043)
Quatro grupos (Recebimento, Expedição, Pátio & Portaria, Estoque); filtros de
período e cliente; por KPI: cartão de valor com comparativo de 7 dias e seta
de tendência, série temporal e ranking top-5; botão de exportação CSV.
Layout fixo (edição pelo usuário é fora de escopo). Estados de carregamento e
de "sem dados" tratados explicitamente — nunca gráfico vazio sem explicação.

### 5. Qualidade de interface (RG-013)
Componentes padronizados de `@wms/ui`; contraste AA; responsivo para desktop e
tablet (o coletor é o DOC-15, fora daqui); feedback de ação em < 100 ms;
tratamento de erro da API com mensagem legível (nunca stack trace na tela).

### 6. Testes
- Teste de componente da trilha: estados visuais; **etapa posterior inerte
  com o aviso**; rótulo textual presente em cada estado; navegação por
  teclado; contraste AA.
- Teste de componente do cartão: exibição de atraso e de exceção bloqueante.
- Teste de integração de tela (a definir a ferramenta — se não houver, `[DEBITO:
  ferramenta de teste de UI + sessão-alvo]`, mas os testes de componente são
  obrigatórios).
- Evidência visual: capturas do painel, da trilha (com etapas verdes e
  vermelhas) e do dashboard, com dados do seed, anexadas ao relatório.
+ Regressão: todas as suítes de backend continuam verdes.

## DEFINITION OF DONE
```bash
docker compose up -d --build      # inclusive o container frontend, porta livre
pnpm build && pnpm test && pnpm test:integration
# abrir o frontend, autenticar, navegar: painel → cartão → trilha → dashboard
curl localhost:3000/health/ready
git commit && git push   # inclua o prompt desta sessão
```
Cole a saída REAL e as evidências visuais. Relatório
`docs/relatorios/SESSAO-7B-relatorio.md` com matriz requisito → arquivo →
teste, lacunas, débitos, e nota sobre o container `frontend`.

## FORA DE ESCOPO
Portal do cliente (§4.3), telas de coletor (DOC-15), dashboards editáveis,
drill-down além dos rankings, exportação agendada, push nativo, e tudo do
DOC-10 §8.
