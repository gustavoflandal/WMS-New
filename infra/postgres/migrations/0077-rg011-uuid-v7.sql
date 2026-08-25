-- Migration: 0077
-- DOC-00 RG-011 — "Chaves primárias: UUID v7".
--
-- Achado de revisão (2026-08-25): a regra nunca foi cumprida. O projeto
-- criou DUAS funções v7 em infra/postgres/init/02-extensions.sql, uma delas
-- com o comentário literal "RG-011: UUID v7 for primary keys" — e nenhuma
-- foi usada uma única vez. Todos os 98 DEFAULTs de chave primária, em 46
-- migrations, usavam gen_random_uuid() (UUID **v4**, aleatório).
--
-- Por que não é preciosismo nesta escala (DOC-00 §2.3: 50 mil pedidos/dia,
-- tabelas particionadas mensalmente): v4 é aleatório e espalha cada INSERT
-- por uma página distinta do índice B-tree da PK, causando page splits e
-- inchaço de índice; v7 tem prefixo temporal e mantém os inserts vizinhos
-- (localidade de escrita). É exatamente por isso que a regra existe.
--
-- Além disso, a `uuid_v7()` que estava no init NÃO era um v7 conforme: não
-- gravava os nibbles de versão nem os bits de variante, então produzia um
-- UUID que se ordena por tempo mas mente sobre a própria versão. Ela é
-- substituída aqui pela implementação correta (RFC 9562 §5.7).
--
-- Linhas já gravadas permanecem com os v4 antigos — UUID continua único e
-- válido; não há reescrita de dado histórico (seria migração de PK em massa,
-- com todas as FKs, sem ganho proporcional). A partir daqui, todo ID NOVO
-- nasce v7.

-- ── 1. Implementação conforme (RFC 9562 §5.7) ─────────────────────────────
-- Layout: 48 bits de timestamp em ms | ver(4)=0111 | rand_a(12)
--         | var(2)=10 | rand_b(62)
CREATE OR REPLACE FUNCTION wms.uuid_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
PARALLEL SAFE
AS $$
DECLARE
  v_ts_ms BIGINT;
  v_bytes BYTEA;
BEGIN
  v_ts_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
  -- Fonte de aleatoriedade: os 16 bytes do próprio gen_random_uuid(), que é
  -- built-in do PostgreSQL (pg_catalog, ≥ 13) e usa CSPRNG.
  -- NÃO usar gen_random_bytes(): aquela é do pgcrypto, e depender de
  -- extensão aqui quebraria TODO INSERT em qualquer banco onde a extensão
  -- não estivesse instalada — foi exatamente o que o teste de integração
  -- desta migration pegou na primeira versão.
  v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');

  -- bytes 0..5 — timestamp de 48 bits, big-endian (ordenável por tempo)
  v_bytes := set_byte(v_bytes, 0, ((v_ts_ms >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_ts_ms >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_ts_ms >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_ts_ms >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_ts_ms >>  8) & 255)::int);
  v_bytes := set_byte(v_bytes, 5, ( v_ts_ms        & 255)::int);

  -- byte 6 — nibble alto = versão 7 (0x70), nibble baixo permanece aleatório
  v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));
  -- byte 8 — 2 bits altos = variante RFC (10xx), 6 bits baixos aleatórios
  v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));

  RETURN encode(v_bytes, 'hex')::uuid;
END;
$$;

COMMENT ON FUNCTION wms.uuid_v7() IS
  'DOC-00 RG-011: gerador de UUID v7 (RFC 9562 5.7) para chaves primarias. Ordenavel por tempo.';

-- A `uuid_v7()` sem schema e a `gen_ulid()` do init ficam obsoletas: ambas
-- produziam UUID nao-conforme e nunca tiveram chamador. Removidas para nao
-- restar duas implementacoes concorrentes com o mesmo proposito.
DROP FUNCTION IF EXISTS public.uuid_v7();
DROP FUNCTION IF EXISTS public.gen_ulid();

-- ── 2. Troca do DEFAULT em toda coluna que ainda usa gen_random_uuid() ────
-- Varredura pelo catálogo em vez de lista fixa de 98 colunas: pega tabelas,
-- partições existentes e qualquer coluna que tenha escapado da revisão.
DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'wms'
    WHERE c.table_schema = 'wms'
      AND c.column_default LIKE '%gen_random_uuid()%'
      -- partições herdam o DEFAULT do pai na criação; alterar o pai basta e
      -- evita divergência entre partições.
      AND pc.relispartition = FALSE
  LOOP
    EXECUTE format('ALTER TABLE wms.%I ALTER COLUMN %I SET DEFAULT wms.uuid_v7()', r.table_name, r.column_name);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'RG-011: DEFAULT trocado para wms.uuid_v7() em % coluna(s)', v_count;
END;
$$;

-- As funções que criam partições sob demanda (ensure_*_partition) usam
-- CREATE TABLE ... PARTITION OF, que herda o DEFAULT do pai no momento da
-- criação — como o pai já foi alterado acima, as partições novas nascem
-- com wms.uuid_v7(). Partições que já existiam seguem o DEFAULT do pai ao
-- receberem INSERT através dele, que é como a aplicação sempre escreve.

GRANT EXECUTE ON FUNCTION wms.uuid_v7() TO wms_app;
GRANT EXECUTE ON FUNCTION wms.uuid_v7() TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (77, 'DOC-00 RG-011: uuid_v7() conforme (RFC 9562) e troca do DEFAULT de todas as PKs (era gen_random_uuid/v4)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
