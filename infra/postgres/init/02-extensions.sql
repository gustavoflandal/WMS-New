-- RNF-ARQ-011: PostgreSQL extensions for WMS
-- Enable pgcrypto for UUID and cryptographic functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Function for generating UUID v7 (sortable by timestamp)
-- RG-011: UUID v7 for primary keys
CREATE OR REPLACE FUNCTION gen_ulid()
RETURNS uuid AS $$
DECLARE
  v_time BIGINT;
  v_random BYTEA;
  v_bytes BYTEA;
BEGIN
  v_time := EXTRACT(EPOCH FROM CLOCK_TIMESTAMP())::BIGINT * 1000;
  v_random := gen_random_bytes(10);
  v_bytes := SET_BYTE(SET_BYTE(convert_to(LPAD(to_hex(v_time), 12, '0'), 'hex'), 6, 0), 7, 0);
  v_bytes := concat(v_bytes, v_random);
  RETURN encode(v_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql;

-- Simpler UUID v7-like function using timestamp and random
CREATE OR REPLACE FUNCTION uuid_v7()
RETURNS uuid AS $$
BEGIN
  RETURN (
    LPAD(TO_HEX((EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)), 12, '0') ||
    LPAD(TO_HEX(EXTRACT(MICROSECOND FROM CLOCK_TIMESTAMP())::INTEGER), 3, '0') ||
    ENCODE(GEN_RANDOM_BYTES(10), 'hex')
  )::uuid;
END
$$ LANGUAGE plpgsql;
