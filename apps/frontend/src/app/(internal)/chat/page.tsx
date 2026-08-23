// DOC-10 RF-PAI-030, RN-PAI-031 [INVIOLÁVEL] — chat operacional da sala
// "armazém · turno" (RF-PAI-030(a): "uma por armazém, persistente"). Esta
// tela é PURAMENTE informativa: nenhum botão aqui aciona operação alguma
// (RN-PAI-031), o mesmo que o backend garante estruturalmente (ChatService
// não injeta nenhum service de negócio).
//
// [DÉBITO: RF-PAI-030 menções (@usuário) — não existe endpoint de
// diretório de usuários nesta sessão para montar um seletor; o campo
// mentioned_user_ids fica sem UI própria. Anexo de imagem — não existe
// endpoint HTTP de upload (FileStorageService é só interno); o campo
// attachment_url aceita uma URL já hospedada em vez de um seletor de
// arquivo, até que um endpoint de upload exista.]
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../lib/auth-context';
import { apiClient } from '../../../lib/api-client';
import { useRealtime } from '../../../lib/use-realtime';

interface ChatRoom {
  id: string;
  tenant_id: string | null;
  warehouse_id: string;
  room_type: string;
}

interface ChatMessage {
  id: string;
  room_id: string;
  sender_user_id: string;
  sender_name: string | null;
  body: string;
  attachment_url: string | null;
  created_at: string;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ChatPage(): JSX.Element {
  const { warehouseId, context } = useAuth();
  const [room, setRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!warehouseId) return;
    apiClient
      .post<ChatRoom>('/paineis/chat/salas/armazem-turno', { warehouse_id: warehouseId })
      .then(setRoom)
      .catch(() => setError('Não foi possível abrir a sala do armazém.'));
  }, [warehouseId]);

  const fetchMessages = useCallback(() => {
    if (!room || !warehouseId) return;
    apiClient.get<ChatMessage[]>(`/paineis/chat/salas/${room.id}/mensagens?warehouse_id=${warehouseId}`).then(setMessages).catch(() => {});
  }, [room, warehouseId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const token = typeof window !== 'undefined' ? window.sessionStorage.getItem('wms_access_token') : null;
  // A sala "armazém · turno" tem tenant_id NULL por natureza (RF-PAI-030(a)
  // — não é de um cliente específico), então o WS aqui é legítimo: um único
  // tenant real ('' -> segmento 'global' no gateway), sem a ambiguidade
  // cross-cliente do Painel/Alertas.
  useRealtime({
    token,
    tenantId: room?.tenant_id ?? null,
    warehouseId: room ? warehouseId : null,
    topic: room ? `chat:${room.id}` : '',
    onMessage: fetchMessages,
  });

  const handleSend = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!room || !text.trim()) return;
    try {
      await apiClient.post(`/paineis/chat/salas/${room.id}/mensagens`, {
        text: text.trim(),
        attachment_url: attachmentUrl.trim() || undefined,
      });
      setText('');
      setAttachmentUrl('');
      fetchMessages();
    } catch {
      setError('Não foi possível enviar a mensagem.');
    }
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col gap-3">
      <h1 className="text-title text-text-primary">Chat · armazém e turno</h1>

      {error ? (
        <p role="alert" className="text-body text-state-pending">
          {error}
        </p>
      ) : null}

      <div className="flex-1 overflow-y-auto rounded-card border border-border-subtle bg-surface-raised p-4">
        {messages === null ? (
          <p className="text-body text-text-secondary">Carregando mensagens…</p>
        ) : messages.length === 0 ? (
          <p className="text-body text-text-secondary">Nenhuma mensagem ainda. Comece a conversa.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-label font-medium text-text-primary">
                    {m.sender_user_id === context?.userId ? 'Você' : (m.sender_name ?? 'Usuário')}
                  </span>
                  <span className="text-label text-text-disabled">{formatTimestamp(m.created_at)}</span>
                </div>
                <p className="text-body text-text-primary">{m.body}</p>
                {m.attachment_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.attachment_url} alt="Anexo enviado na conversa" className="mt-1 max-h-48 rounded-field border border-border-subtle" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSend} className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escrever mensagem…"
          rows={2}
          maxLength={2000}
          className="rounded-field border border-border-strong bg-surface-raised p-2 text-body text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={attachmentUrl}
            onChange={(e) => setAttachmentUrl(e.target.value)}
            placeholder="URL de imagem (opcional)"
            className="h-9 flex-1 rounded-field border border-border-strong bg-surface-raised px-3 text-body text-text-primary"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="h-9 rounded-field bg-brand px-4 text-body text-white hover:bg-brand-hover disabled:opacity-50"
          >
            Enviar
          </button>
        </div>
      </form>
    </div>
  );
}
