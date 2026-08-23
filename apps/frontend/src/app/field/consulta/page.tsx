// DOC-15 §4.5 T7 — Consulta. Somente leitura, exige conexão (não é
// aprovisionada offline — diferente das demais telas de campo). Leitura por
// wedge (RNF-COL-010) sem depender de campo focado, ou câmera (RNF-COL-011),
// ou digitação manual no campo de busca.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Search, Camera, AlertTriangle } from 'lucide-react';
import { useAuth, ApiError } from '../../../lib/auth-context';
import { fieldApi, StockSearchRowDto } from '../../../lib/field/field-api';
import { useWedgeScanner } from '../../../lib/field/use-wedge-scanner';
import { useCameraScanner } from '../../../lib/field/use-camera-scanner';

export default function FieldConsultaPage(): JSX.Element {
  const { warehouseId, context } = useAuth();
  const tenantId = context?.clients[0]?.id ?? null;
  const [codigo, setCodigo] = useState('');
  const [results, setResults] = useState<StockSearchRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  const camera = useCameraScanner();

  useEffect(() => {
    const goOnline = (): void => setOffline(false);
    const goOffline = (): void => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const runSearch = useCallback(
    async (code: string) => {
      if (!warehouseId || !tenantId || !code) return;
      setError(null);
      try {
        const rows = await fieldApi.searchStock(code, tenantId, warehouseId);
        setResults(rows);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Não foi possível consultar.');
      }
    },
    [warehouseId, tenantId]
  );

  useWedgeScanner((code) => {
    setCodigo(code);
    void runSearch(code);
  }, !camera.active);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void runSearch(codigo);
  };

  // DOC-15 §4.5: T7 exige conexão — não aprovisionada offline.
  if (offline) {
    return (
      <div className="flex flex-col items-center gap-3 pt-12 text-center">
        <AlertTriangle aria-hidden="true" className="h-10 w-10 text-state-warning" />
        <p className="text-base text-text-secondary">Consulta indisponível sem conexão. Verifique a rede e tente novamente.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text-primary">Consulta de saldo</h1>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          placeholder="SKU, EAN ou LPN"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          className="h-14 flex-1 rounded-field border-2 border-border-strong bg-surface-raised px-3 font-mono text-lg text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        <button type="submit" className="flex min-h-[56px] min-w-[56px] items-center justify-center rounded-field bg-brand text-white">
          <Search aria-hidden="true" className="h-6 w-6" />
        </button>
        {camera.supported ? (
          <button
            type="button"
            onClick={() => camera.start((code) => { setCodigo(code); void runSearch(code); camera.stop(); })}
            className="flex min-h-[56px] min-w-[56px] items-center justify-center rounded-field border-2 border-border-strong text-text-primary"
            aria-label="Ler por câmera"
          >
            <Camera aria-hidden="true" className="h-6 w-6" />
          </button>
        ) : null}
      </form>
      {camera.active ? <video ref={camera.videoRef} className="w-full rounded-card" muted playsInline /> : null}
      {error ? (
        <p role="alert" className="text-base text-state-pending">
          {error}
        </p>
      ) : null}
      {results !== null && results.length === 0 ? <p className="text-base text-text-secondary">Nenhum saldo encontrado para este código.</p> : null}
      {results && results.length > 0 ? (
        <table className="w-full border-collapse text-base">
          <thead className="bg-surface-sunken">
            <tr>
              <th className="p-2 text-left text-label text-text-secondary">Endereço</th>
              <th className="p-2 text-left text-label text-text-secondary">Zona</th>
              <th className="p-2 text-left text-label text-text-secondary">Lote/Val.</th>
              <th className="p-2 text-right text-label text-text-secondary">Qtd</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row, i) => (
              <tr key={i} className="border-t border-border-subtle">
                <td className="p-2 font-mono text-data">{row.locationCode}</td>
                <td className="p-2">{row.zoneCode}</td>
                <td className="p-2">{row.batchCode ?? '—'}{row.expirationDate ? ` · ${row.expirationDate}` : ''}</td>
                <td className="p-2 text-right font-mono tabular-nums">
                  {row.frozenByInventory ? (
                    <span className="rounded-full bg-state-blocked-bg px-2 py-1 text-label text-state-blocked">Endereço em contagem</span>
                  ) : (
                    row.qtyAvailable
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
