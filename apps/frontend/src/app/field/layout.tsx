// DOC-15 — casca da área `field` do PWA: registro de dispositivo
// (RNF-COL-003), bloqueio por inatividade com PIN (RF-COL-030/RF-SEG-004),
// navegação por T1/T7/T8 (RNF-COL-020: alvo ≥48dp, ações na metade inferior,
// tipografia ≥16, alto contraste).
'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ClipboardList, Search, RefreshCw, LogOut, Lock } from 'lucide-react';
import { useAuth, ApiError } from '../../lib/auth-context';
import { getOrCreateFieldDeviceId } from '../../lib/field/device-id';
import { fieldApi } from '../../lib/field/field-api';

const INACTIVITY_LOCK_MS = 5 * 60 * 1000; // RF-SEG-004: 5 minutos
const APP_VERSION = '1.0.0'; // COL.VERSAO_MINIMA (RNF-COL-050) — checagem completa fica para a COL-2

const NAV_ITEMS = [
  { href: '/field', label: 'Minhas Tarefas', icon: ClipboardList },
  { href: '/field/consulta', label: 'Consulta', icon: Search },
  { href: '/field/sincronizacao', label: 'Sincronização', icon: RefreshCw },
];

function PinLockOverlay({ warehouseId, onUnlocked, onFullLoginRequired }: { warehouseId: string; onUnlocked: () => void; onFullLoginRequired: () => void }): JSX.Element {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await fieldApi.verifyPin(pin, warehouseId);
      if (result.ok) {
        onUnlocked();
      } else {
        setError('PIN incorreto. Tente novamente.');
        setPin('');
      }
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === 'PIN_LOCKED_AFTER_FAILURES' || apiError?.code === 'PIN_LOCKED') {
        onFullLoginRequired();
      } else {
        setError(apiError?.message ?? 'Não foi possível verificar o PIN.');
        setPin('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-surface-base px-4">
      <Lock aria-hidden="true" className="h-12 w-12 text-brand" />
      <h1 className="text-title text-text-primary">Sessão bloqueada</h1>
      <p className="text-base text-text-secondary">Digite seu PIN de 6 dígitos para continuar</p>
      <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label="PIN"
          className="h-16 w-48 rounded-field border-2 border-border-strong bg-surface-raised text-center text-3xl font-mono tracking-[0.5em] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        {error ? (
          <p role="alert" className="text-base text-state-pending">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting || pin.length !== 6}
          className="min-h-[48px] w-48 rounded-field bg-brand text-base font-semibold text-white disabled:opacity-50"
        >
          {submitting ? 'Verificando…' : 'Desbloquear'}
        </button>
      </form>
    </div>
  );
}

export default function FieldLayout({ children }: { children: React.ReactNode }): JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const { status, context, warehouseId, logout } = useAuth();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/field/login');
  }, [status, router]);

  // RNF-COL-002: manifest instalável + Service Worker mínimo (precache do
  // shell estático — sem fila offline, ver public/field-sw.js).
  useEffect(() => {
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = '/field-manifest.json';
    document.head.appendChild(manifestLink);

    const themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    themeColorMeta.content = '#0B4F8F';
    document.head.appendChild(themeColorMeta);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/field-sw.js').catch(() => {});
    }

    return () => {
      manifestLink.remove();
      themeColorMeta.remove();
    };
  }, []);

  // RNF-COL-003: registra o dispositivo assim que há sessão + armazém.
  useEffect(() => {
    if (status !== 'authenticated' || !warehouseId) return;
    let cancelled = false;
    getOrCreateFieldDeviceId().then((id) => {
      if (cancelled) return;
      setDeviceId(id);
      fieldApi.registerDevice(id, warehouseId, APP_VERSION).catch(() => {
        // RNF-COL-003: dispositivo bloqueado ou erro de rede — não impede o
        // uso das telas já carregadas, só o registro/telemetria.
      });
    });
    return () => {
      cancelled = true;
    };
  }, [status, warehouseId]);

  // RF-COL-030/RF-SEG-004: bloqueio por 5 min de inatividade.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const markActivity = (): void => {
      lastActivityRef.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    events.forEach((event) => window.addEventListener(event, markActivity));
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= INACTIVITY_LOCK_MS) {
        setLocked(true);
      }
    }, 15000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, markActivity));
      clearInterval(interval);
    };
  }, [status]);

  if (status !== 'authenticated' || !context) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-base">
        <p className="text-base text-text-secondary">Carregando…</p>
      </main>
    );
  }

  if (!warehouseId) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-base px-4">
        <p className="text-base text-text-secondary">Nenhum armazém atribuído. Procure o administrador do sistema.</p>
      </main>
    );
  }

  if (locked) {
    return (
      <PinLockOverlay
        warehouseId={warehouseId}
        onUnlocked={() => {
          lastActivityRef.current = Date.now();
          setLocked(false);
        }}
        onFullLoginRequired={() => logout('/field/login')}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface-base">
      <header className="flex h-14 items-center justify-between border-b border-border-subtle bg-surface-raised px-4">
        <span className="text-subtitle text-text-primary">WMS Campo</span>
        <button
          type="button"
          onClick={() => logout('/field/login')}
          className="flex min-h-[48px] items-center gap-1.5 rounded-field px-3 text-base text-text-secondary"
        >
          <LogOut aria-hidden="true" className="h-5 w-5" />
          Sair
        </button>
      </header>
      <main className="flex-1 p-4 pb-24">{children}</main>
      {/* RNF-COL-020: ações principais na metade inferior da tela. */}
      <nav className="fixed bottom-0 left-0 right-0 flex border-t border-border-subtle bg-surface-raised">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-base ${
                active ? 'text-brand' : 'text-text-secondary'
              }`}
            >
              <item.icon aria-hidden="true" className="h-6 w-6" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <p className="fixed bottom-14 left-0 w-full bg-surface-sunken px-4 py-1 text-center text-label text-text-secondary" data-testid="device-id-footer">
        {deviceId ? `Dispositivo: ${deviceId.slice(0, 8)}…` : ''}
      </p>
    </div>
  );
}
