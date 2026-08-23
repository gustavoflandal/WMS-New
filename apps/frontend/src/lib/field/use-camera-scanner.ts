// DOC-15 RNF-COL-011 — leitura por câmera (fallback universal, ONDE não
// houver leitor físico). `BarcodeDetector` nativo quando disponível
// (Chrome Android ≥ 120, RNF-ARQ-005); sem polyfill nesta sessão — quando
// indisponível, a tela deve orientar o uso do leitor físico ou digitação
// manual (EST.DIGITACAO_LPN), não travar.
'use client';

import { useCallback, useRef, useState } from 'react';

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => {
      detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
    };
  }
}

const SUPPORTED_FORMATS = ['code_128', 'ean_13', 'ean_8', 'qr_code', 'itf'];

export function useCameraScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [active, setActive] = useState(false);
  const [supported] = useState(() => typeof window !== 'undefined' && !!window.BarcodeDetector);

  const start = useCallback(async (onDetect: (code: string) => void) => {
    if (!supported || !window.BarcodeDetector) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setActive(true);

    const detector = new window.BarcodeDetector({ formats: SUPPORTED_FORMATS });
    const tick = async (): Promise<void> => {
      if (!videoRef.current || !streamRef.current) return;
      try {
        const results = await detector.detect(videoRef.current);
        if (results.length > 0) {
          onDetect(results[0].rawValue);
          return; // para após a primeira leitura — o chamador decide se reabre
        }
      } catch {
        // frame não decodificável — tenta o próximo
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [supported]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setActive(false);
  }, []);

  return { videoRef, supported, active, start, stop };
}
