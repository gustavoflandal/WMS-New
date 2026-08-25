// DOC-17 RN-TEL-010 [INVIOLÁVEL] — Modo de Execução.
//
// Função pura: dado o modo do armazém e o canal de quem está executando,
// diz se a execução é permitida. Fica isolada aqui porque é a regra que
// separa "armazém sem coletor" de "armazém sem telas" — e um erro nela
// libera o canal errado em silêncio, sem nada quebrar visivelmente.
export type ExecutionMode = 'COLETOR' | 'TELA' | 'HIBRIDO';
export type ExecutionChannel = 'COLETOR' | 'TELA' | 'FORMULARIO';

export const EXECUTION_MODES: ExecutionMode[] = ['COLETOR', 'TELA', 'HIBRIDO'];
export const EXECUTION_CHANNELS: ExecutionChannel[] = ['COLETOR', 'TELA', 'FORMULARIO'];

/**
 * RN-TEL-010: `COLETOR` (apenas dispositivos), `TELA` (apenas telas e
 * formulários), `HIBRIDO` (ambos).
 *
 * FORMULARIO é canal de papel: pertence ao mundo "sem coletor", então segue
 * a mesma porta de TELA — é literalmente o que a regra diz ao definir
 * `TELA` como "apenas telas E FORMULÁRIOS".
 */
export function isChannelAllowed(mode: ExecutionMode, channel: ExecutionChannel): boolean {
  if (mode === 'HIBRIDO') return true;
  if (mode === 'COLETOR') return channel === 'COLETOR';
  return channel === 'TELA' || channel === 'FORMULARIO';
}

/**
 * RN-TEL-010 [INVIOLÁVEL], 2ª parte: "Em HIBRIDO, uma tarefa já iniciada em
 * um modo NÃO pode ser concluída no outro — evita dupla contagem."
 *
 * `startedChannel` é o canal gravado na tarefa quando ela começou; null =
 * ainda não iniciada, qualquer canal pode assumir.
 *
 * Note que a trava vale para QUALQUER modo, não só HIBRIDO: em COLETOR ou
 * TELA puros o outro canal já estaria barrado por `isChannelAllowed`, e
 * aplicar a mesma checagem sempre evita um buraco caso o modo do armazém
 * mude no meio de uma tarefa em curso — que é justamente quando a dupla
 * contagem aconteceria.
 */
export function isSameChannelContinuation(startedChannel: ExecutionChannel | null, channel: ExecutionChannel): boolean {
  if (startedChannel === null) return true;
  return startedChannel === channel;
}

/** Converte o valor cru do parâmetro; qualquer coisa inesperada cai no padrão seguro. */
export function parseExecutionMode(raw: string | null): ExecutionMode {
  if (raw && (EXECUTION_MODES as string[]).includes(raw)) return raw as ExecutionMode;
  // RN-TEL-010 não define fallback. COLETOR é o padrão adotado porque é o
  // modo que o sistema já operava antes do DOC-17 (DOC-15): parâmetro
  // ausente ou corrompido não deve LIBERAR um canal novo por omissão.
  return 'COLETOR';
}
