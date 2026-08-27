import { Test, TestingModule } from '@nestjs/testing';
import { EmailService, encodeHeaderValue } from './email.service';

describe('EmailService', () => {
  let service: EmailService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmailService],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('encodeHeaderValue', () => {
  it('leaves a plain ASCII subject untouched', () => {
    expect(encodeHeaderValue('Upcoming deliveries (7)')).toBe(
      'Upcoming deliveries (7)',
    );
  });

  it('RFC 2047-encodes a subject containing a non-ASCII character, decoding back to the exact original text', () => {
    // The real, confirmed bug: an un-encoded em dash in the raw Subject
    // header renders as mojibake ("Ã¢Â€Â”") in the recipient's inbox,
    // because header fields are US-ASCII by spec - only the body declares
    // charset="UTF-8" explicitly.
    const subject = 'Nexora ERP — Upcoming deliveries (7)';

    const encoded = encodeHeaderValue(subject);

    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const base64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(subject);
  });

  it('encodes any non-ASCII character, not just the em dash (e.g. a curly quote or accented letter)', () => {
    const subject = 'Supplier confirmed — “priority” dispatch, café pickup';

    const encoded = encodeHeaderValue(subject);
    const base64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);

    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(subject);
  });
});
