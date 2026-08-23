// DOC-10 §6 (Sessão 7B) — teste de componente da trilha de etapas (RF-PAI-005)
// e do cartão do painel. jsdom + Testing Library: única forma de testar
// estados visuais/acessibilidade de um componente React sem um navegador
// real, mesmo padrão do resto do frontend Next.js.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
});
