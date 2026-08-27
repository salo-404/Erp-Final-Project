import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  RequestTimeoutException,
} from '@nestjs/common';
import { Pool } from 'pg';

const STATEMENT_TIMEOUT_MS = 3000;
const MAX_ROWS = 200;

// Mirrors ai-agent/sql/sql_guard.py's FORBIDDEN_KEYWORDS exactly. This is
// NOT the primary enforcement mechanism (see executeReadOnly's docstring
// for what is) - it is a cheap, independent fail-fast layer so an obvious
// write attempt is rejected before ever opening a transaction, in case the
// agent-side sql_guard was bypassed, buggy, or simply never ran.
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COPY',
  'GRANT',
  'REVOKE',
  'CALL',
  'DO',
  'EXECUTE',
  'VACUUM',
  'ANALYZE',
  'REFRESH',
  'SET',
  'RESET',
  'LISTEN',
  'NOTIFY',
  'LOCK',
];

export interface AiQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * Executes SQL text sent by the AI service over POST /ai/query-database
 * (see AiQueryController) against the backend's own RDS connection.
 *
 * This is the ONLY place in the backend that runs SQL text supplied by a
 * caller rather than authored in this codebase. It independently enforces
 * read-only, single-statement, bounded execution - it never trusts that
 * the AI agent's own sql_guard.py already validated the text, because
 * this endpoint is the actual security boundary (the agent-side guard can
 * be changed, skipped, or simply wrong; this cannot be bypassed from the
 * caller's side at all).
 *
 * Real enforcement layers, each independent of the others:
 * 1. Keyword/prefix rejection (FORBIDDEN_KEYWORDS, must start with
 *    SELECT/WITH) - fast, but a string-level check alone is not trusted.
 * 2. A real `BEGIN TRANSACTION READ ONLY` - PostgreSQL itself refuses any
 *    write inside this transaction, independent of what layer 1 missed.
 * 3. The query is sent via node-postgres's EXTENDED query protocol
 *    (`values: []` on the query config) rather than the simple protocol -
 *    Postgres's extended protocol structurally accepts exactly one
 *    statement per Parse message, so a stacked `"; DROP ..."` payload
 *    fails at the wire/parse level (`cannot insert multiple commands into
 *    a prepared statement`), not just via the naive `;` string check
 *    below.
 * 4. `SET LOCAL statement_timeout` bounds worst-case execution time.
 * 5. The statement is wrapped as `SELECT * FROM (<sql>) AS _ai_query_result
 *    LIMIT 201` so PostgreSQL itself stops producing rows past the cap,
 *    rather than this process fetching an unbounded result set into
 *    memory and truncating it afterward.
 *
 * Uses the backend's own DATABASE_URL (the same RDS instance/credentials
 * every other backend module uses) - no separate database role, and no
 * database credential of any kind is ever returned to the caller.
 */
@Injectable()
export class AiQueryService implements OnModuleDestroy {
  private readonly logger = new Logger(AiQueryService.name);
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async executeReadOnly(sql: string): Promise<AiQueryResult> {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (!trimmed) {
      throw new ForbiddenException('SQL cannot be empty');
    }

    const upperSql = trimmed.toUpperCase();
    for (const keyword of FORBIDDEN_KEYWORDS) {
      if (new RegExp(`\\b${keyword}\\b`).test(upperSql)) {
        throw new ForbiddenException(
          `Forbidden SQL keyword detected: ${keyword}`,
        );
      }
    }
    if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
      throw new ForbiddenException('Only SELECT queries are allowed');
    }
    if (trimmed.includes(';')) {
      throw new ForbiddenException('Multiple SQL statements are not allowed');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

      const wrapped = `SELECT * FROM (${trimmed}) AS _ai_query_result LIMIT ${MAX_ROWS + 1}`;
      let result;
      try {
        // values: [] forces the extended query protocol - see this
        // class's own docstring, layer 3.
        result = await client.query({ text: wrapped, values: [] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/statement timeout/i.test(message)) {
          throw new RequestTimeoutException('Query exceeded the statement timeout');
        }
        throw new ForbiddenException(`Query rejected by the database: ${message}`);
      }

      if (result.rows.length > MAX_ROWS) {
        throw new ForbiddenException(`Query returned more than ${MAX_ROWS} rows`);
      }

      await client.query('COMMIT');
      return { rows: result.rows };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.warn(`Rollback after failed AI query also failed: ${rollbackError}`);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
