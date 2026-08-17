-- Migration: 0032
-- DOC-03 RF-POR-020 — permissão dedicada para CONSULTAR a fila de pátio.
--
-- Decisão de negócio registrada explicitamente (fechamento da Sessão 4,
-- revisão do usuário): a fila de pátio é um recurso FÍSICO do armazém —
-- vagas, cancela e docas são compartilhadas por TODOS os clientes que
-- operam naquele armazém (3PL). O porteiro/líder de turno precisa
-- enxergar a fila inteira (todos os clientes) para gerenciar o pátio
-- fisicamente; não é uma falha de isolamento, é a única forma de o
-- painel de pátio (RF-POR-020) funcionar. Por isso a leitura é
-- legitimamente cross-tenant, mas SÓ para quem tem esta permissão de
-- escopo WAREHOUSE (nunca CLIENT_WAREHOUSE — não é "ver a fila do meu
-- cliente", é "ver a fila do armazém que eu opero").
--
-- Antes desta migration, GET /portaria/yard-queue exigia apenas
-- @Authenticated() (qualquer usuário autenticado, de QUALQUER papel ou
-- armazém, sem checagem de vínculo com o warehouse_id da query) — isso
-- SIM violava RN-SEG-011 (nenhuma verificação de escopo). Corrigido
-- trocando para @RequirePermission('POR.FILA_CONSULTAR'), que o
-- PermissionGuard resolve contra o warehouse_id da própria query string
-- (core/rbac/guards/permission.guard.ts), negando por padrão RN-SEG-012.
--
-- DOC-03 §3 não lista esta permissão na tabela de 8 códigos (mesma
-- categoria de omissão já documentada para o evento
-- portaria.vaga_indisponivel nesta sessão) — RF-POR-020 descreve a
-- funcionalidade ("painel de pátio em tempo real") sem enumerar seu
-- próprio código de permissão; adicionada citando a fonte funcional
-- exata (RF-POR-020), não inventada livremente.

INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('POR.FILA_CONSULTAR', 'WAREHOUSE', 'Consulta da fila de pátio do armazém, todos os clientes (DOC-03 RF-POR-020)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Staff físico do armazém: Porteiro, Líder de Turno, Gestor do Armazém
-- (DOC-03 §3, coluna "Interação" — todos operam ou supervisionam o pátio
-- fisicamente). CLIENTE_OPERACAO/CLIENTE_CONSULTA NÃO recebem esta
-- permissão — um cliente ver os veículos de OUTROS clientes na fila
-- seria, esse sim, uma violação real de RN-SEG-011.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'POR.FILA_CONSULTAR', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code IN ('PORTEIRO', 'LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (32, 'DOC-03 RF-POR-020: POR.FILA_CONSULTAR (WAREHOUSE) para GET /portaria/yard-queue, substitui @Authenticated() sem checagem de escopo', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
