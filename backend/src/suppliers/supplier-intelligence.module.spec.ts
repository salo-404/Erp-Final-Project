/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { SUPPLIERS_HISTORY_PROVIDER } from './supplier-intelligence.service';
import { SupplierIntelligenceModule } from './supplier-intelligence.module';

describe('SupplierIntelligenceModule wiring', () => {
  it('fails to bootstrap without SUPPLIERS_HISTORY_PROVIDER bound — confirms this module cannot be imported into AppModule as-is yet, and exactly which token needs binding at merge time', async () => {
    await expect(
      Test.createTestingModule({
        imports: [SupplierIntelligenceModule],
      }).compile(),
    ).rejects.toThrow(/SUPPLIERS_HISTORY_PROVIDER/);

    // Confirms the exact symbol name in the error above is the real,
    // exported token — not a coincidental string match.
    expect(SUPPLIERS_HISTORY_PROVIDER.toString()).toContain(
      'SUPPLIERS_HISTORY_PROVIDER',
    );
  });
});
