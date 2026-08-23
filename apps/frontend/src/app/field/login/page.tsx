// DOC-15 RF-COL-030 — login individual da área field. Reaproveita
// /auth/login (mesmo backend, mesmo useAuth) — a única diferença é o
// redirecionamento pós-login (/field, não /painel) e a tipografia/alvo de
// toque ≥16sp/48dp exigidos para tela de coletor (RNF-COL-020).
'use client';

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@wms/ui';
import { useAuth, ApiError } from '../../../lib/auth-context';

export default function FieldLoginPage(): JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password, '/field');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-base px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-title">WMS Campo</CardTitle>
          <p className="text-base text-text-secondary">Entrar no coletor</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="email" className="text-label text-text-secondary">
                E-mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-14 rounded-field border-2 border-border-strong bg-surface-raised px-3 text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-label text-text-secondary">
                Senha
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-14 rounded-field border-2 border-border-strong bg-surface-raised px-3 text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            {error ? (
              <p role="alert" className="text-base text-state-pending">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 min-h-[56px] rounded-field bg-brand text-lg font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
