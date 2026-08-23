// DOC-12 RF-SEG-006 — login interno (área INTERNAL; portal fica fora do
// escopo desta sessão). Sistema de design §6 "Formulário": rótulo acima do
// campo, erro abaixo em --state-pending dizendo o que aconteceu (a API
// já devolve mensagem RFC 9457 legível — não reformulamos aqui).
'use client';

import React, { useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@wms/ui';
import { useAuth, ApiError } from '../../lib/auth-context';

export default function LoginPage(): JSX.Element {
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
      await login(email, password);
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
          <CardTitle className="text-title">WMS Enterprise 3PL</CardTitle>
          <p className="text-body text-text-secondary">Entrar na área interna</p>
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
                className="h-10 rounded-field border border-border-strong bg-surface-raised px-3 text-body text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                className="h-10 rounded-field border border-border-strong bg-surface-raised px-3 text-body text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            {error ? (
              <p role="alert" className="text-body text-state-pending">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={submitting} className="mt-2">
              {submitting ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
