/**
 * One-time historical ingest of Seller Central
 * "FBA inbound placement service fees" report (CSV/TSV download).
 *
 * Merges dated charge rows into Mongo WITHOUT wiping API-synced recent months.
 * Use this only for months older than Finances API can reach (~90–180 days).
 *
 * Usage:
 *   node scripts/ingest-placement-historical.js <email> <path-to-csv> [more.csv...]
 *
 * Example:
 *   node scripts/ingest-placement-historical.js allmart399@gmail.com "C:\Users\Desktop\Downloads\placement-nov-2025.csv"
 *
 * In Seller Central:
 *   Reports → Fulfillment → FBA inbound placement service fees
 *   (or Report Central → INBOUND_PLACEMENT_FEES_CHARGES)
 *   Set Event/Transaction date range → Download
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function parseDelimited(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';

  const splitRow = (line) => {
    if (delim === '\t') return line.split('\t');
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  };

  const headers = splitRow(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]);
    if (!cells.some((c) => String(c || '').trim())) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] != null ? String(cells[idx]).trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

function eventKey(ev) {
  return [
    String(ev.transaction_date || '').slice(0, 19),
    String(ev.shipment_id || ''),
    String(ev.fnsku || ''),
    String(ev.sku || ''),
    String(ev.asin || ''),
    Number(ev.fee_total || 0).toFixed(4),
    Number(ev.units || 0),
  ].join('|');
}

function monthTotals(events) {
  const by = {};
  for (const ev of events || []) {
    const m = String(ev.transaction_date || '').slice(0, 7);
    if (!m) continue;
    by[m] = (by[m] || 0) + Number(ev.fee_total || 0);
  }
  return Object.fromEntries(
    Object.entries(by)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, Math.round(v * 100) / 100]),
  );
}

(async () => {
  const emailOrId = process.argv[2];
  const files = process.argv.slice(3);
  if (!emailOrId || !files.length) {
    console.error(
      'Usage: node scripts/ingest-placement-historical.js <email|userId> <file.csv> [more.csv...]',
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI / MONGO_URI missing');
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB_NAME || undefined });

  const User = require('../src/models/User');
  const FbaInboundPlacementFee = require('../src/models/FbaInboundPlacementFee');
  const {
    aggregateFromReport,
    resolveReportKeysToSellerSkus,
    resolveEventsToSellerSkus,
  } = require('../src/services/fbaInboundPlacementSyncService');

  const user = mongoose.isValidObjectId(emailOrId)
    ? await User.findById(emailOrId)
    : await User.findOne({
      email: new RegExp(`^${emailOrId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    });
  if (!user) {
    console.error(`User not found: ${emailOrId}`);
    process.exit(2);
  }
  console.log(`Seller: ${user.email || user._id}`);

  let allRows = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      console.error(`File not found: ${abs}`);
      process.exit(3);
    }
    const text = fs.readFileSync(abs, 'utf8');
    const rows = parseDelimited(text);
    console.log(`Parsed ${rows.length} rows from ${abs}`);
    allRows = allRows.concat(rows);
  }

  const aggregated = aggregateFromReport(allRows);
  const perSkuFromFile = await resolveReportKeysToSellerSkus(user, aggregated.perSku);
  const fileEvents = await resolveEventsToSellerSkus(user, aggregated.events);
  console.log(
    `File → ${fileEvents.length} dated events, ${Object.keys(perSkuFromFile).length} SKUs`,
  );
  console.log('File month totals:', monthTotals(fileEvents));

  const existing = await FbaInboundPlacementFee.findOne({ sellerId: user._id }).lean();
  const prior = existing?.events || [];
  const map = new Map();
  for (const ev of prior) map.set(eventKey(ev), ev);
  let added = 0;
  for (const ev of fileEvents) {
    const k = eventKey(ev);
    if (!map.has(k)) {
      map.set(k, ev);
      added += 1;
    }
  }
  const mergedEvents = Array.from(map.values()).sort((a, b) =>
    String(a.transaction_date || '').localeCompare(String(b.transaction_date || '')),
  );

  // Prefer keeping API source if already migrated; only label CSV when nothing else.
  const source = (
    existing?.source === 'finances_join' || existing?.source === 'report'
  ) ? existing.source : 'seller_central_csv';

  // Merge perSku rates (file fills gaps; keep higher-weight existing when present).
  const perSku = { ...(existing?.perSku || {}) };
  for (const [sku, b] of Object.entries(perSkuFromFile)) {
    const prev = perSku[sku];
    if (!prev) {
      perSku[sku] = b;
      continue;
    }
    const totalUnits = (prev.totalUnits || 0) + (b.totalUnits || 0);
    const totalFee = (prev.totalFee || 0) + (b.totalFee || 0);
    const rate = totalUnits > 0
      ? totalFee / totalUnits
      : (b.fee_rate || prev.fee_rate || 0);
    perSku[sku] = {
      ...prev,
      ...b,
      totalUnits,
      totalFee: Math.round(totalFee * 100) / 100,
      avgFeePerUnit: Math.round(rate * 10000) / 10000,
      fee_rate: Math.round(rate * 1e6) / 1e6,
    };
  }

  await FbaInboundPlacementFee.updateOne(
    { sellerId: user._id },
    {
      $set: {
        events: mergedEvents,
        perSku,
        source,
      },
      $setOnInsert: { sellerId: user._id },
    },
    { upsert: true },
  );

  console.log(
    `Merged: prior=${prior.length} + new=${added} → total=${mergedEvents.length} (source=${source})`,
  );
  console.log('Combined month totals:', monthTotals(mergedEvents));
  await mongoose.disconnect();
  console.log('Done. Reload Profitability for the historical month.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
