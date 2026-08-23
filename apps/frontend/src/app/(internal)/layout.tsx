// Casca da área interna: cabeçalho com navegação, seletor de armazém (RN-
// SEG-011 — um usuário pode ter atribuição em mais de um) e badge de
// alertas não lidos (RF-PAI-010). Redireciona para /login se não
// autenticado — nenhuma tela filha precisa repetir essa checagem.
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AlertTriangle, LayoutGrid, MessageSquare, BarChart3, LogOut } from 'lucide-react';
import { cn } from '@wms/ui';
import { useAuth } from '../../lib/auth-context';
import { apiClient } from '../../lib/api-client';

const NAV_ITEMS = [
  { href: '/painel', label: 'Painel', icon: LayoutGrid },
  { href: '/alertas', label: 'Alertas', icon: AlertTriangle },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/RECEBIMENTO', label: 'Dashboard', icon: BarChart3 },
];

export default function InternalLayout({ children }: { children: React.ReactNode }): JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const { status, context, warehouseId, setWarehouseId, logout } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    if (status !== 'authenticated' || !warehouseId) return;
    let cancelled = false;
    const fetchCount = (): void => {
      apiClient
        .get<{ count: number }>(`/paineis/alertas/nao-lidos/contagem?warehouse_id=${warehouseId}`)
        .then((r) => {
          if (!cancelled) setUnreadCount(r.count);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, warehouseId]);

  if (status !== 'authenticated' || !context) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-body text-text-secondary">Carregando…</p>
      </main>
    );
  }

  if (context.warehouses.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <p className="text-body text-text-secondary">
          Nenhum armazém atribuído a este usuário. Procure o administrador do sistema.
        </p>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border-subtle bg-surface-raised px-4">
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname?.startsWith(item.href.split('/').slice(0, 2).join('/'));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 rounded-field px-3 py-1.5 text-body',
                  active ? 'bg-brand-subtle text-brand' : 'text-text-secondary hover:bg-surface-sunken'
                )}
              >
                <item.icon aria-hidden="true" className="h-4 w-4" />
                {item.label}
                {item.href === '/alertas' && unreadCount > 0 ? (
                  <span
                    data-testid="alert-unread-badge"
                    className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-state-warning px-1 text-label text-white"
                  >
                    {unreadCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">
          {context.warehouses.length > 1 ? (
            <select
              aria-label="Armazém"
              value={warehouseId ?? ''}
              onChange={(e) => setWarehouseId(e.target.value)}
              className="h-8 rounded-field border border-border-strong bg-surface-raised px-2 text-body text-text-primary"
            >
              {context.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-body text-text-secondary">{context.warehouses[0]?.name}</span>
          )}
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-1.5 rounded-field px-2 py-1.5 text-body text-text-secondary hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Sair
          </button>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
