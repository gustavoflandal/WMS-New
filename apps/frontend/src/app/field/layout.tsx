// DOC-15 — casca da área `field` do PWA: registro de dispositivo
// (RNF-COL-003), bloqueio por inatividade com PIN (RF-COL-030/RF-SEG-004),
// navegação por T1/T7/T8 (RNF-COL-020: alvo ≥48dp, ações na metade inferior,
// tipografia ≥16, alto contraste).
//
// COL-2B: ganhou o "estado permanente visível no topo" (RNF-COL-020 —
// operador, armazém, conexão, tamanho da fila) e o carregamento/atualização
// do Pacote de Turno (RF-ARQ-051). `FieldStatusProvider` precisa envolver
// tudo que usa `useFieldStatus()` — por isso o registro de dispositivo
// (que agora também captura `versionBlocked`, RNF-COL-050) e a busca do
// Pacote de Turno foram movidos para `FieldShell`, um componente FILHO do
// Provider, em vez de ficarem no corpo de `FieldLayout` (que fica FORA do
// Provider). "Zona/estação" citada no prompt original não tem campo
// correspondente em `MyContext`/nenhuma API existente — [LACUNA]: não há
// como exibir zona/estação sem inventar um campo que a API não fornece.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ClipboardList, Search, RefreshCw, LogOut, Lock, Wifi, WifiOff, ShieldAlert } from 'lucide-react';
import { useAuth, ApiError } from '../../lib/auth-context';
import { getOrCreateFieldDeviceId } from '../../lib/field/device-id';
import { fieldApi } from '../../lib/field/field-api';
import { saveShiftPackage } from '../../lib/field/shift-package-store';
import { FieldStatusProvider, useFieldStatus } from '../../lib/field/field-status-context';

const INACTIVITY_LOCK_MS = 5 * 60 * 1000; // RF-SEG-004: 5 minutos
// COL.VERSAO_MINIMA (RNF-COL-050): versão enviada em todo registro/sincronização
// desta build — exportada para as telas de execução (T2-T6) usarem o MESMO valor.
export const APP_VERSION = '1.0.0';

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

/**
 * Filho do `FieldStatusProvider` — é aqui, e não em `FieldLayout`, que o
 * registro de dispositivo e a busca do Pacote de Turno acontecem, porque
 * ambos precisam de `useFieldStatus()` (captura de `versionBlocked` e a
 * leitura de `online`/`queueSize` para o cabeçalho, RNF-COL-020).
 */
function FieldShell({ children }: { children: React.ReactNode }): JSX.Element {
  const pathname = usePathname();
  const { context, warehouseId, logout } = useAuth();
  const status = useFieldStatus();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pkgLoading, setPkgLoading] = useState(false);
  const [pkgError, setPkgError] = useState<string | null>(null);

  // RNF-COL-003: registra o dispositivo assim que há sessão + armazém, e
  // captura `versionBlocked` (RNF-COL-050) na resposta.
  useEffect(() => {
    if (!warehouseId) return;
    let cancelled = false;
    getOrCreateFieldDeviceId().then((id) => {
      if (cancelled) return;
      setDeviceId(id);
      fieldApi
        .registerDevice(id, warehouseId, APP_VERSION)
        .then((response) => {
          if (!cancelled) status.setVersionBlocked(response.versionBlocked);
        })
        .catch(() => {
          // RNF-COL-003: dispositivo bloqueado ou erro de rede — não impede
          // o uso das telas já carregadas, só o registro/telemetria.
        });
    });
    return () => {
      cancelled = true;
    };
    // status.setVersionBlocked é o setter estável de useState — não entra nas deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  // RF-ARQ-051: busca o Pacote de Turno ao entrar autenticado com armazém
  // definido, e expõe um jeito manual de re-buscar (botão "Atualizar" — um
  // botão simples resolve o requisito, sem necessidade de gesto de swipe).
  const loadShiftPackage = useCallback(async (): Promise<void> => {
    if (!warehouseId) return;
    setPkgLoading(true);
    setPkgError(null);
    try {
      const pkg = await fieldApi.shiftPackage(warehouseId);
      await saveShiftPackage(pkg);
      await status.refreshQueueSize();
    } catch (err) {
      setPkgError(err instanceof ApiError ? err.message : 'Não foi possível atualizar o pacote de turno.');
    } finally {
      setPkgLoading(false);
    }
    // status.refreshQueueSize é estável (useCallback sem deps mutáveis).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  useEffect(() => {
    void loadShiftPackage();
    // dispara só uma vez por armazém — atualização manual é via botão.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  const warehouseCode = context?.warehouses.find((w) => w.id === warehouseId)?.code ?? warehouseId ?? '—';

  return (
    <div className="flex min-h-screen flex-col bg-surface-base">
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-subtitle text-text-primary">WMS Campo</span>
          <button
            type="button"
            onClick={() => logout('/field/login')}
            className="flex min-h-[48px] items-center gap-1.5 rounded-field px-3 text-base text-text-secondary"
          >
            <LogOut aria-hidden="true" className="h-5 w-5" />
            Sair
          </button>
        </div>
        {/* RNF-COL-020: estado permanente visível no topo (operador, armazém, conexão, fila). */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-4 py-1.5 text-label text-text-secondary">
          <span data-testid="field-operator">{context?.userId ?? '—'}</span>
          <span data-testid="field-warehouse">Armazém {warehouseCode}</span>
          <span className="flex items-center gap-1" data-testid="field-connection">
            {status.online ? (
              <Wifi aria-hidden="true" className="h-3.5 w-3.5 text-state-done" />
            ) : (
              <WifiOff aria-hidden="true" className="h-3.5 w-3.5 text-state-pending" />
            )}
            {status.online ? 'Online' : 'Offline'}
          </span>
          <span data-testid="field-queue-size">Fila: {status.queueSize}</span>
          <button
            type="button"
            onClick={() => void loadShiftPackage()}
            disabled={pkgLoading}
            className="ml-auto flex min-h-[32px] items-center gap-1 text-brand disabled:opacity-50"
          >
            <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${pkgLoading ? 'animate-spin' : ''}`} />
            {pkgLoading ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
        {pkgError ? (
          <p role="alert" className="px-4 pb-1 text-label text-state-pending">
            {pkgError}
          </p>
        ) : null}
        {status.executionBlocked && status.blockedMessage ? (
          <div className="flex items-center gap-2 bg-state-warning-bg px-4 py-2 text-label text-state-warning">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
            {status.blockedMessage}
          </div>
        ) : null}
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

export default function FieldLayout({ children }: { children: React.ReactNode }): JSX.Element | null {
  const router = useRouter();
  const { status, context, warehouseId, logout } = useAuth();
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
    <FieldStatusProvider warehouseId={warehouseId} appVersion={APP_VERSION}>
      <FieldShell>{children}</FieldShell>
    </FieldStatusProvider>
  );
}
