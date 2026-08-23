// RNF-ARQ-004: Next.js App Router root layout.
// Tipografia do sistema de design (.claude/skills/wms-design-system/SKILL.md
// §3): Inter para interface, JetBrains Mono para dados/códigos — via
// next/font (self-hosted, sem dependência de rede em runtime).
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ReactNode } from 'react';
import './globals.css';
import { AuthProvider } from '../lib/auth-context';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'WMS Enterprise 3PL',
  description: 'Warehouse Management System for 3PL Operators',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans text-body">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
