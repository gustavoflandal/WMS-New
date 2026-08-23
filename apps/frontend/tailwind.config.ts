// RG-013 — Sistema de Design WMS (.claude/skills/wms-design-system/SKILL.md):
// tokens de cor mapeados a partir das variáveis CSS de globals.css (nunca hex
// solto em componente), tipografia (Inter + JetBrains Mono via next/font),
// escala de espaçamento de 4px, e as classes de estado semântico.
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          base: 'var(--surface-base)',
          raised: 'var(--surface-raised)',
          sunken: 'var(--surface-sunken)',
        },
        border: {
          subtle: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          disabled: 'var(--text-disabled)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          subtle: 'var(--brand-subtle)',
        },
        focus: {
          ring: 'var(--focus-ring)',
        },
        state: {
          done: 'var(--state-done)',
          'done-bg': 'var(--state-done-bg)',
          pending: 'var(--state-pending)',
          'pending-bg': 'var(--state-pending-bg)',
          warning: 'var(--state-warning)',
          'warning-bg': 'var(--state-warning-bg)',
          blocked: 'var(--state-blocked)',
          'blocked-bg': 'var(--state-blocked-bg)',
          neutral: 'var(--state-neutral)',
          'neutral-bg': 'var(--state-neutral-bg)',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        display: ['1.75rem', { lineHeight: '2.125rem', fontWeight: '600' }],
        title: ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        subtitle: ['1rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        body: ['0.875rem', { lineHeight: '1.25rem', fontWeight: '400' }],
        label: ['0.75rem', { lineHeight: '1rem', fontWeight: '500', letterSpacing: '.02em' }],
        data: ['0.875rem', { lineHeight: '1.25rem', fontWeight: '500' }],
        'data-lg': ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
      },
      spacing: {
        // escala de 4px do sistema de design — os valores padrão do Tailwind
        // já batem com ela (4=1rem/4, 8=2, 12=3, 16=4, 24=6, 32=8, 48=12);
        // nenhuma extensão necessária, mantido como documentação.
      },
      borderRadius: {
        field: '4px',
        card: '6px',
      },
      boxShadow: {
        elevated: '0 1px 2px rgba(16,24,40,.06)',
      },
    },
  },
  plugins: [],
};

export default config;
