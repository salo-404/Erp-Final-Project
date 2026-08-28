-- One-time setup SQL for the two Postgres roles the SQL-RAG feature
-- (ai-agent/tools/query_database.py) was designed to use, per the design
-- documented in ai-agent/README.md ("SQL-RAG" section, "Fresh SQL-RAG
-- deployment order").
--
-- This is NOT a Prisma migration - it provisions database roles, not
-- schema, and roles are cluster-level objects Prisma does not manage.
-- Run it manually, once, against any environment before configuring that
-- environment's AI_DATABASE_URL / QUERY_EXAMPLE_WRITE_DATABASE_URL.
--
-- Usage:
--   1. Replace both REPLACE_WITH_STRONG_PASSWORD placeholders below with
--      real, freshly generated passwords (never commit real passwords in
--      this file).
--   2. Run as a role with CREATEROLE (the local dev default is the
--      `mini_erp` role), e.g.:
--        psql "postgresql://mini_erp:mini_erp@localhost:5433/mini_erp" \
--          -f backend/prisma/sql/create-ai-roles.sql
--   3. Put the resulting connection strings in that environment's
--      ai-agent/.env as AI_DATABASE_URL / QUERY_EXAMPLE_WRITE_DATABASE_URL.
--      Never put them in ai-agent/.env.example.
--
-- Idempotent: safe to re-run - each role is only created if it doesn't
-- already exist. Re-running does NOT rotate an existing role's password
-- or re-apply GRANTs if the role is already present; drop the role first
-- if you need to recreate it with different grants.

-- ============================================================================
-- 1. erp_ai_readonly - the AI's live query-execution role
--    (ai-agent's AI_DATABASE_URL). SELECT-only, database-level backstop
--    behind the per-connection SET TRANSACTION READ ONLY / SET LOCAL
--    statement_timeout already enforced in ai-agent/sql/read_only_db.py.
-- ============================================================================

DO
$$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_ai_readonly') THEN
      CREATE ROLE erp_ai_readonly LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
   END IF;
END
$$;

GRANT CONNECT ON DATABASE mini_erp TO erp_ai_readonly;
GRANT USAGE ON SCHEMA public TO erp_ai_readonly;

-- The 8 operational tables in ai-agent/sql/database_context.py's
-- ALLOWED_TABLES, plus QueryExample (needed for pgvector retrieval only -
-- QueryExample is deliberately excluded from the generated-SQL table
-- allowlist in ai-agent/sql/sql_guard.py despite this grant).
GRANT SELECT ON
    "Product",
    "Warehouse",
    "WarehouseInventory",
    "Supplier",
    "InventoryTransaction",
    "InventoryTransactionItem",
    "StockMovement",
    "Reservation",
    "QueryExample"
TO erp_ai_readonly;

-- Second, database-level defense layer alongside the existing
-- per-connection SET TRANSACTION READ ONLY / SET LOCAL statement_timeout
-- in ai-agent/sql/read_only_db.py. Confirmed to coexist without error:
-- re-issuing SET TRANSACTION READ ONLY / a stricter SET LOCAL
-- statement_timeout inside a session that already has these as its role
-- defaults is a no-op, not a conflict.
ALTER ROLE erp_ai_readonly SET default_transaction_read_only = on;
ALTER ROLE erp_ai_readonly SET statement_timeout = '3000ms';

-- ============================================================================
-- 2. erp_ai_embedding_writer - maintenance-only role
--    (ai-agent's QUERY_EXAMPLE_WRITE_DATABASE_URL). Used only by
--    ai-agent/scripts/generate_query_embeddings.py. Never give this role
--    to the AgentCore runtime, and never use it as a fallback for
--    AI_DATABASE_URL - see ai-agent/config/settings.py's
--    require_query_example_write_database_url().
-- ============================================================================

DO
$$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_ai_embedding_writer') THEN
      CREATE ROLE erp_ai_embedding_writer LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
   END IF;
END
$$;

GRANT CONNECT ON DATABASE mini_erp TO erp_ai_embedding_writer;
GRANT USAGE ON SCHEMA public TO erp_ai_embedding_writer;

-- SELECT + UPDATE(embedding) on QueryExample only - zero access to any of
-- the 8 operational tables.
GRANT SELECT, UPDATE (embedding) ON "QueryExample" TO erp_ai_embedding_writer;
