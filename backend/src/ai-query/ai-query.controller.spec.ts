import { AiQueryController } from './ai-query.controller';
import { AiQueryService } from './ai-query.service';

describe('AiQueryController', () => {
  it('delegates the DTO sql to AiQueryService.executeReadOnly', async () => {
    const service = { executeReadOnly: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const controller = new AiQueryController(service as unknown as AiQueryService);

    const result = await controller.queryDatabase({ sql: 'SELECT "id" FROM "Product"' });

    expect(service.executeReadOnly).toHaveBeenCalledWith('SELECT "id" FROM "Product"');
    expect(result).toEqual({ rows: [{ id: 1 }] });
  });
});
