import { ForbiddenException, RequestTimeoutException } from '@nestjs/common';
import { AiQueryService } from './ai-query.service';

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

function installFakePool(service: AiQueryService, client: FakeClient): void {
  // AiQueryService's constructor already opened a real pg.Pool against
  // process.env.DATABASE_URL - tests never let that connect, they replace
  // the pool with a fake before any query runs.
  (service as unknown as { pool: { connect: jest.Mock } }).pool = {
    connect: jest.fn().mockResolvedValue(client),
  };
}

function fakeClient(handlers: { onWrappedQuery: (config: { text: string; values: unknown[] }) => unknown }): FakeClient {
  const query = jest.fn(async (arg: string | { text: string; values: unknown[] }) => {
    if (typeof arg === 'string') {
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK - all sent as plain strings.
      return { rows: [] };
    }
    return handlers.onWrappedQuery(arg);
  });
  return { query, release: jest.fn() };
}

describe('AiQueryService.executeReadOnly', () => {
  it('rejects a forbidden keyword without ever opening a connection', async () => {
    const service = new AiQueryService();
    const connect = jest.fn();
    (service as unknown as { pool: { connect: jest.Mock } }).pool = { connect };

    await expect(service.executeReadOnly('DELETE FROM "Product"')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a statement that is not SELECT/WITH', async () => {
    const service = new AiQueryService();
    const connect = jest.fn();
    (service as unknown as { pool: { connect: jest.Mock } }).pool = { connect };

    await expect(service.executeReadOnly('EXPLAIN SELECT 1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a stacked multi-statement payload without ever opening a connection', async () => {
    const service = new AiQueryService();
    const connect = jest.fn();
    (service as unknown as { pool: { connect: jest.Mock } }).pool = { connect };

    await expect(
      service.executeReadOnly('SELECT 1; DROP TABLE "Product"'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(connect).not.toHaveBeenCalled();
  });

  it('executes a valid SELECT inside a real READ ONLY transaction, wrapped with a row-cap LIMIT, via the extended query protocol', async () => {
    const service = new AiQueryService();
    let capturedWrapped: { text: string; values: unknown[] } | undefined;
    const client = fakeClient({
      onWrappedQuery: (config) => {
        capturedWrapped = config;
        return { rows: [{ id: 1 }, { id: 2 }] };
      },
    });
    installFakePool(service, client);

    const result = await service.executeReadOnly('SELECT "id" FROM "Product"');

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(client.query.mock.calls[0][0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(client.query.mock.calls[1][0]).toBe('SET LOCAL statement_timeout = 3000');
    expect(capturedWrapped?.text).toBe(
      'SELECT * FROM (SELECT "id" FROM "Product") AS _ai_query_result LIMIT 201',
    );
    // Passing `values` (even empty) is what forces node-postgres onto the
    // extended query protocol, which structurally rejects multi-statement
    // text at the wire level - this is the real enforcement, the `;`
    // string check above is only a fast-fail layer.
    expect(capturedWrapped?.values).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rejects and rolls back when the query returns more than 200 rows', async () => {
    const service = new AiQueryService();
    const manyRows = Array.from({ length: 201 }, (_, index) => ({ id: index }));
    const client = fakeClient({ onWrappedQuery: () => ({ rows: manyRows }) });
    installFakePool(service, client);

    await expect(service.executeReadOnly('SELECT "id" FROM "Product"')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('maps a real Postgres statement-timeout error to RequestTimeoutException and rolls back', async () => {
    const service = new AiQueryService();
    const client = fakeClient({
      onWrappedQuery: () => {
        throw new Error('canceling statement due to statement timeout');
      },
    });
    installFakePool(service, client);

    await expect(service.executeReadOnly('SELECT "id" FROM "Product"')).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('rejects a query the database itself refuses (e.g. inside the READ ONLY transaction) and rolls back', async () => {
    const service = new AiQueryService();
    const client = fakeClient({
      onWrappedQuery: () => {
        throw new Error('cannot execute UPDATE in a read-only transaction');
      },
    });
    installFakePool(service, client);

    await expect(service.executeReadOnly('SELECT "id" FROM "Product"')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
