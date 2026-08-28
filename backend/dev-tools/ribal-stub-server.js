/**
 * TEMPORARY local dev stub for the Ribal document-extraction agent.
 *
 * The real extraction service (an HTTP endpoint the backend calls at
 * RIBAL_AGENT_URL — see src/document-review/ribal-document-extraction.provider.ts)
 * does not exist yet anywhere in this repo. This file is NOT that service.
 * It exists only so the Upload Invoice -> AI extraction -> Review -> Approve
 * pipeline can be click-tested end to end in local dev, without faking
 * anything past the extraction boundary — everything downstream of this
 * stub (S3 storage, the PendingDocumentReview row, resolve-product/
 * resolve-supplier, approve() creating a real InventoryTransaction) is
 * fully real.
 *
 * Run it in its own terminal, alongside the backend:
 *   node dev-tools/ribal-stub-server.js
 *
 * Then set (or confirm) in backend/.env:
 *   RIBAL_AGENT_URL="http://localhost:9000/ribal/extract"
 * and restart the backend so it picks up the env var.
 *
 * How it decides what to "extract" (since there is no real OCR/LLM here):
 * it reads the ORIGINAL FILENAME back out of the presigned S3 URL the
 * backend sends it (the real S3DocumentStorageService key format is
 * documents/<uuid>-<original filename>), and keys off simple substrings
 * in that filename — so you control the result purely by naming your
 * test PDF:
 *
 *   - filename contains "order"      -> OUTGOING (customer order)
 *     otherwise                      -> INCOMING (supplier invoice)
 *   - contains "techsource"          -> supplierName "TechSource Lebanon"
 *   - contains "cedar"               -> supplierName "Cedar Electronics"
 *   - contains "levant"              -> supplierName "Levant Trading"
 *     otherwise (INCOMING)           -> supplierName "Unknown Supplier Ltd"
 *   - contains "beirut"/"tripoli"/"saida" -> warehouseName set to match
 *
 * e.g. "techsource-order.pdf" -> OUTGOING (order wins), "techsource-invoice.pdf" -> INCOMING from TechSource Lebanon.
 *
 * Line items are always the same two real seeded products (Laptop Pro 14,
 * Wireless Mouse) with plausible quantities/prices — good enough to
 * exercise the review form's resolve-product search, since the whole
 * point of the review step is that a human confirms/corrects this data
 * anyway.
 */

const http = require('node:http');

const PORT = 9000;

function decideExtraction(filename) {
  const name = filename.toLowerCase();
  const isOrder = name.includes('order');

  const items = [
    { product: 'Laptop Pro 14', quantity: 3, price: 850 },
    { product: 'Wireless Mouse', quantity: 15, price: 14.5 },
  ];

  const warehouseHint = ['beirut', 'tripoli', 'saida'].find((w) => name.includes(w));
  const warehouseName = warehouseHint
    ? `${warehouseHint[0].toUpperCase()}${warehouseHint.slice(1)} Warehouse`
    : undefined;

  if (isOrder) {
    return {
      transactionType: 'OUTGOING',
      partyName: 'Test Customer Co.',
      date: new Date().toISOString(),
      warehouseName,
      deliveryCountry: 'Lebanon',
      deliveryRegion: 'Beirut',
      deliveryAddress: 'Hamra Street 12',
      items,
    };
  }

  let supplierName = 'Unknown Supplier Ltd';
  if (name.includes('techsource')) supplierName = 'TechSource Lebanon';
  else if (name.includes('cedar')) supplierName = 'Cedar Electronics';
  else if (name.includes('levant')) supplierName = 'Levant Trading';

  return {
    transactionType: 'INCOMING',
    supplierName,
    date: new Date().toISOString(),
    warehouseName,
    items,
  };
}

function extractFilename(documentUrl) {
  try {
    const { pathname } = new URL(documentUrl);
    const key = decodeURIComponent(pathname.split('/').pop() ?? '');
    // Real key format: <uuid>-<original filename> (see buildObjectKey() in
    // s3-document-storage.service.ts) — strip the 36-char uuid + dash.
    return key.length > 37 ? key.slice(37) : key;
  } catch {
    return '';
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/ribal/extract') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found. This stub only serves POST /ribal/extract.' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid JSON body' }));
      return;
    }

    const filename = extractFilename(payload.documentUrl ?? '');
    const extracted = decideExtraction(filename);

    console.log(
      `[ribal-stub] mimeType=${payload.mimeType} filename=${filename || '(unresolved)'} -> transactionType=${extracted.transactionType}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(extracted));
  });
});

server.listen(PORT, () => {
  console.log(`[ribal-stub] listening on http://localhost:${PORT}/ribal/extract`);
  console.log('[ribal-stub] TEMPORARY dev-only stub — see file header for filename-based extraction rules.');
});
