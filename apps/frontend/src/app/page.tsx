// Redireciona para a área correta conforme o estado de autenticação — não
// há conteúdo próprio na raiz.
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth-context';

export default function RootPage(): null {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/painel');
    else if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return null;
}
