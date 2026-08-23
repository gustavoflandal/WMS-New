// DOC-15 RF-COL-013 — feedback de leitura <100ms: flash de borda + vibração
// a cada leitura aceita/rejeitada. Sem asset de áudio disponível no
// repositório — feedback sonoro fica documentado como parcial no relatório
// (vibração + flash visual cobrem o requisito de forma perceptível).
// `navigator.vibrate` é opcional (`?.`) porque é uma API de conveniência sem
// efeito no negócio, não uma dependência de configuração — não se enquadra
// na proibição de optional chaining do CLAUDE.md (que veda esconder
// dependência de negócio não injetada).
'use client';

import { useCallback, useRef, useState } from 'react';

export type ScanFeedbackTone = 'ok' | 'error';

export interface ScanFeedback {
  flash: ScanFeedbackTone | null;
  trigger: (tone: ScanFeedbackTone) => void;
}

export function useScanFeedback(durationMs = 150): ScanFeedback {
  const [flash, setFlash] = useState<ScanFeedbackTone | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useCallback(
    (tone: ScanFeedbackTone) => {
      setFlash(tone);
      if (typeof navigator !== 'undefined') {
        navigator.vibrate?.(tone === 'ok' ? 50 : [30, 30, 30]);
      }
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setFlash(null), durationMs);
    },
    [durationMs]
  );

  return { flash, trigger };
}

/** Classe de borda a aplicar no cartão de leitura ativo, conforme o flash atual. */
export function scanFeedbackBorderClass(flash: ScanFeedbackTone | null): string {
  if (flash === 'ok') return 'border-state-done ring-2 ring-state-done';
  if (flash === 'error') return 'border-state-pending ring-2 ring-state-pending';
  return 'border-border-strong';
}
