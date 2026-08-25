# PROMPT — Sessão 10E: DOC-17 §6 — Execução por Tela (backend)

**Carregar**: DOC-00 (RG-002, RG-003, RG-013) + DOC-17 §6 completo
(RN-TEL-010, RN-TEL-011, RN-TEL-012, RF-TEL-013), §11 (RD-TEL-004) e §4
(permissões `TEL.EXECUCAO_TELA`, `TEL.MODO_EXECUCAO_CONFIGURAR`) +
`docs/relatorios/SESSAO-10D-relatorio.md`.

## Por que backend agora e as 8 telas depois

RF-TEL-013 lista 8 telas (T-P1..T-P8), mas as 8 **operações** já têm
controller e serviço de domínio no backend — foram construídas para o
coletor (DOC-15). Ou seja: RN-TEL-011 (paridade) já é estrutural, e o que
falta de backend é a **governança do canal**, não a operação.

O que é genuinamente novo aqui:
- RN-TEL-010 — parâmetro `TEL.MODO_EXECUCAO` e sua aplicação, incluindo a
  trava de canal cruzado que evita dupla contagem;
- RD-TEL-004 — `execution_channel` em tarefas e movimentações;
- RN-TEL-012 item 4 — permissão própria `TEL.EXECUCAO_TELA`;
- RN-TEL-012 item 3 — origem registrada (já parcialmente feito na 10D).

As **8 telas** são frontend: densidade desktop, estados de carregamento/
vazio/erro/sem-permissão, design system. É uma sessão de porte próprio —
mesmo padrão que o projeto já usou em COL-2A→COL-2B (motor offline → telas
offline) e 10A→10C (contrato → consumo). Misturar as duas coisas produziria
backend raso e telas apressadas.

## Decisões de implementação

1. **Guarda, não caminho de execução**: `ExecutionModeService` responde
   "este canal pode executar?" e "esta tarefa já foi iniciada por outro
   canal?". Quem executa continua sendo o serviço de domínio de cada módulo
   (RN-TEL-011). É PROIBIDO este service ganhar lógica de operação.
2. **A trava de canal cruzado vale em QUALQUER modo**, não só em HIBRIDO.
   Em COLETOR/TELA puros o outro canal já cai antes, mas aplicar sempre
   fecha o buraco de o modo do armazém MUDAR no meio de uma tarefa em curso
   — que é exatamente quando a dupla contagem aconteceria.
3. **A trava só morde depois de INICIADA**: enquanto a tarefa está no estado
   inicial (`CREATED`/`PENDING`/`OPEN`) o `execution_channel` é só o default
   e qualquer canal pode assumir. Travar antes impediria o primeiro
   atendimento.
4. **`FORMULARIO` segue a porta de `TELA`**: RN-TEL-010 define o modo `TELA`
   como "apenas telas **e formulários**". Mas para efeito da trava de dupla
   contagem os dois são canais distintos entre si — começar por tela e
   terminar no papel seriam dois registros do mesmo trabalho.
5. **Padrão COLETOR em tudo**: parâmetro e coluna nascem com `COLETOR`.
   Aplicar esta migration não muda o comportamento de quem já operava
   (DOC-15), e parâmetro ausente/corrompido não LIBERA canal novo por
   omissão.
6. **`TEL.EXECUCAO_TELA` não vai para todos os papéis operacionais**:
   RN-TEL-012 item 4 diz "concedida deliberadamente". Só GESTOR_ARMAZEM e
   LIDER_TURNO no seed; ampliar é ato explícito do cliente.

## Fora do escopo desta sessão

As 8 telas (frontend, sessão seguinte); `execution_channel` propagado a
partir dos serviços de domínio de todas as 8 operações — nesta sessão a
cadeia é ligada de ponta a ponta apenas em **putaway** (o único com hook
real desde a 10B), com o mapa origem→canal pronto para os demais.

## Critérios de aceite

RN-TEL-010 em seus dois efeitos (canal permitido por modo; trava de canal
cruzado), RN-TEL-012 item 4 (permissão própria) e RD-TEL-004 (canal gravado
em tarefa e movimentação, com a movimentação de papel nascendo
`FORMULARIO`). DoD padrão do CLAUDE.md.
