const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const FbaInboundPlacementFee = require('../models/FbaInboundPlacementFee');
const Shipment = require('../models/Shipment');
const Product = require('../models/Product');
const { buildFromFinancesJoin } = require('./fbaInboundPlacementFinances');

// Freshness gate — skip the sync when the cached snapshot is younger than this.
const MIN_REFRESH_HOURS = parseInt(
  process.env.FBA_INBOUND_PLACEMENT_MIN_REFRESH_HOURS || '20',
  10,
);

// Trailing window used for both the report and the Finances-join fallback.
// Amazon posts placement fees ~45d after shipment receipt; Finances allows
// up to 180 days when PostedAfter+PostedBefore are both set. Default 90 keeps
// inventory sync responsive; history outside the window is preserved on merge.
const WINDOW_DAYS = parseInt(
  process.env.FBA_INBOUND_PLACEMENT_WINDOW_DAYS || '180',
  10,
);

// Finances events matching any of these substrings are placement fees.
const PLACEMENT_FEE_TYPE_SUBSTRINGS = [
  'inboundplacement',
  'inboundconvenience',
  'inboundtransportationfee',
  'inboundplacementservice',
  'fbainboundplacementservice',
  'placementservice',
  'placementfee',
];

// AdjustmentEventList.AdjustmentType hints (same family as aiModel amazon_sp).
const PLACEMENT_ADJUSTMENT_HINTS = [
  'inboundplacement',
  'inboundconvenience',
  'placementfee',
  'placementservice',
];

function toFloat(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function classifyFeeType(feeType) {
  const s = String(feeType || '').toLowerCase().replace(/[\s_-]/g, '');
  return PLACEMENT_FEE_TYPE_SUBSTRINGS.some((needle) => s.includes(needle));
}

function isAccessDenied(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    code === 'unauthorized'
    || msg.includes('access to the resource is forbidden')
    || msg.includes('access denied')
    || msg.includes('unauthorized')
  );
}

function isInvalidReportType(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('invalid report type');
}

function formatDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Amazon rejects PostedBefore within ~2 minutes of wall-clock "now". */
function financesPostedBefore(d = new Date()) {
  return formatDate(new Date(d.getTime() - 3 * 60_000));
}

function rowGet(row, ...needles) {
  if (!row) return null;
  const lowered = {};
  for (const [k, v] of Object.entries(row)) {
    lowered[String(k).trim().toLowerCase().replace(/_/g, ' ')] = v;
  }
  for (const needle of needles) {
    const key = String(needle).trim().toLowerCase().replace(/_/g, ' ');
    if (lowered[key] !== undefined && lowered[key] !== null && lowered[key] !== '') {
      return String(lowered[key]).trim();
    }
  }
  for (const needle of needles) {
    const key = String(needle).trim().toLowerCase().replace(/_/g, ' ');
    if (key.length < 10 && !key.includes(' ')) continue;
    for (const [rk, rv] of Object.entries(lowered)) {
      if (rk.includes(key) && rv !== undefined && rv !== null && rv !== '') {
        return String(rv).trim();
      }
    }
  }
  return null;
}

/**
 * Seller Central CSV has FNSKU+ASIN (no seller SKU) and an explicit
 * "FBA inbound placement service fee rate (per unit)" column — that rate
 * is the source of truth. Prefer it over total÷units.
 *
 * Also extracts dated charge events so profitability can sum Total charge
 * by Transaction/Event date (matching Seller Central's filter).
 */
function aggregateFromReport(rows) {
  const acc = {};
  const events = [];
  for (const row of rows) {
    const sku = (rowGet(row, 'sku', 'seller sku', 'seller-sku', 'msku') || '').trim();
    const fnsku = (rowGet(row, 'fnsku', 'fn sku', 'FNSKU') || '').trim().toUpperCase();
    const asin = (rowGet(row, 'asin', 'ASIN') || '').trim().toUpperCase();
    const key = sku || fnsku || asin;
    if (!key) continue;

    const units = toInt(
      rowGet(
        row,
        'actual received quantity',
        'received quantity',
        'quantity shipped',
        'units',
        'quantity',
      ),
    );
    let rate = toFloat(
      rowGet(
        row,
        'fba inbound placement service fee rate (per unit)',
        'fba inbound placement service fee rate',
        'fee rate',
        'fee_rate',
      ),
    );
    let fee = toFloat(
      rowGet(
        row,
        'total fba inbound placement service fee charge',
        'total charge',
        'total charges',
        'Total FBA inbound placement service fee charge',
      ),
    );
    if (rate <= 0 && fee > 0 && units > 0) rate = fee / units;
    if (rate <= 0 && fee <= 0) continue;
    if (fee <= 0 && rate > 0 && units > 0) fee = rate * units;
    const weight = units > 0 ? units : (rate > 0 ? 1 : 0);
    if (weight <= 0) continue;

    const rowFee = fee > 0 ? fee : rate * weight;
    let txDate = (rowGet(row, 'transaction date', 'event date', 'charge date', 'date') || '').trim();
    if (txDate && !txDate.includes('T') && txDate.includes(' ')) {
      txDate = txDate.replace(' ', 'T');
    }
    const shipmentId = (
      rowGet(row, 'fba shipment id', 'shipment id', 'amazon shipment id') || ''
    ).trim();

    events.push({
      transaction_date: txDate || null,
      shipment_id: shipmentId || null,
      fnsku: fnsku || null,
      asin: asin || null,
      sku: sku || null,
      units,
      fee_rate: rate > 0 ? Math.round(rate * 1e6) / 1e6 : 0,
      fee_total: Math.round(rowFee * 10000) / 10000,
    });

    const bucket = acc[key] || {
      totalUnits: 0,
      totalFee: 0,
      rateWeight: 0,
      rateWeightedSum: 0,
      avgFeePerUnit: 0,
      asin: null,
      fnsku: null,
    };
    bucket.totalUnits += units;
    bucket.totalFee += rowFee;
    if (rate > 0) {
      bucket.rateWeight += weight;
      bucket.rateWeightedSum += rate * weight;
    }
    if (!bucket.asin && asin) bucket.asin = asin;
    if (!bucket.fnsku && fnsku) bucket.fnsku = fnsku;
    acc[key] = bucket;
  }

  const perSku = {};
  for (const [key, b] of Object.entries(acc)) {
    const rate = b.rateWeight > 0
      ? b.rateWeightedSum / b.rateWeight
      : (b.totalUnits > 0 ? b.totalFee / b.totalUnits : 0);
    if (rate <= 0) continue;
    perSku[key] = {
      totalUnits: b.totalUnits,
      totalFee: Math.round(b.totalFee * 100) / 100,
      avgFeePerUnit: Math.round(rate * 10000) / 10000,
      fee_rate: Math.round(rate * 1000000) / 1000000,
      asin: b.asin,
      fnsku: b.fnsku,
    };
  }
  return { perSku, events };
}

async function resolveEventsToSellerSkus(user, events) {
  if (!events?.length) return [];
  const synthetic = {};
  for (const ev of events) {
    const fn = String(ev.fnsku || '').toUpperCase();
    const asin = String(ev.asin || '').toUpperCase();
    const key = fn || asin || ev.sku || '';
    if (!key) continue;
    synthetic[key] = {
      totalUnits: ev.units || 0,
      totalFee: ev.fee_total || 0,
      avgFeePerUnit: ev.fee_rate || 0,
      fee_rate: ev.fee_rate || 0,
      asin: asin || null,
      fnsku: fn || null,
    };
  }
  const resolved = await resolveReportKeysToSellerSkus(user, synthetic);
  const fnToSku = {};
  const asinToSku = {};
  for (const [sku, b] of Object.entries(resolved)) {
    if (b.fnsku) fnToSku[String(b.fnsku).toUpperCase()] = sku;
    if (b.asin) asinToSku[String(b.asin).toUpperCase()] = sku;
  }
  return events.map((ev) => {
    const fn = String(ev.fnsku || '').toUpperCase();
    const asin = String(ev.asin || '').toUpperCase();
    let sku = (ev.sku || '').trim();
    if (!sku && fn && fnToSku[fn]) sku = fnToSku[fn];
    if (!sku && asin && asinToSku[asin]) sku = asinToSku[asin];
    return {
      ...ev,
      sku: sku || null,
      fnsku: fn || null,
      asin: asin || null,
    };
  });
}

async function resolveReportKeysToSellerSkus(user, perSku) {
  const keys = Object.keys(perSku || {});
  if (!keys.length) return {};

  const fnskus = [];
  const asins = [];
  for (const [key, b] of Object.entries(perSku)) {
    const fn = String(b.fnsku || (key.startsWith('X') ? key : '')).toUpperCase();
    const asin = String(b.asin || '').toUpperCase();
    if (fn) fnskus.push(fn);
    if (asin) asins.push(asin);
  }

  const products = await Product.find(
    {
      sellerId: user._id,
      $or: [
        ...(fnskus.length ? [{ fnSku: { $in: fnskus } }] : []),
        ...(asins.length ? [{ asin: { $in: asins } }] : []),
      ],
    },
    { sku: 1, asin: 1, fnSku: 1 },
  ).lean();

  const fnToSku = {};
  const asinToSkus = {};
  for (const p of products) {
    const sku = String(p.sku || '').trim();
    if (!sku) continue;
    if (p.fnSku) fnToSku[String(p.fnSku).toUpperCase()] = sku;
    if (p.asin) {
      const a = String(p.asin).toUpperCase();
      asinToSkus[a] = asinToSkus[a] || [];
      asinToSkus[a].push(sku);
    }
  }

  const out = {};
  for (const [key, b] of Object.entries(perSku)) {
    const fn = String(b.fnsku || (key.startsWith('X') ? key : '')).toUpperCase();
    const asin = String(b.asin || '').toUpperCase();
    let sku = '';
    if (!key.startsWith('X') && !(key.startsWith('B') && key.length === 10)) {
      sku = key;
    }
    if (!sku && fn && fnToSku[fn]) sku = fnToSku[fn];
    if (!sku && asin && (asinToSkus[asin] || []).length === 1) {
      sku = asinToSkus[asin][0];
    }
    if (!sku) sku = key; // keep FNSKU/ASIN key as last resort

    const existing = out[sku] || {
      totalUnits: 0,
      totalFee: 0,
      avgFeePerUnit: 0,
      fee_rate: 0,
      asin: null,
      fnsku: null,
      rateWeight: 0,
      rateWeightedSum: 0,
    };
    existing.totalUnits += b.totalUnits || 0;
    existing.totalFee += b.totalFee || 0;
    const rate = toFloat(b.fee_rate || b.avgFeePerUnit);
    const weight = (b.totalUnits > 0 ? b.totalUnits : 1);
    if (rate > 0) {
      existing.rateWeight += weight;
      existing.rateWeightedSum += rate * weight;
    }
    if (!existing.asin && asin) existing.asin = asin;
    if (!existing.fnsku && fn) existing.fnsku = fn;
    out[sku] = existing;
  }

  for (const b of Object.values(out)) {
    const rate = b.rateWeight > 0
      ? b.rateWeightedSum / b.rateWeight
      : (b.totalUnits > 0 ? b.totalFee / b.totalUnits : 0);
    b.totalFee = Math.round(b.totalFee * 100) / 100;
    b.avgFeePerUnit = Math.round(rate * 10000) / 10000;
    b.fee_rate = Math.round(rate * 1000000) / 1000000;
    delete b.rateWeight;
    delete b.rateWeightedSum;
  }
  return out;
}


/**
 * Keep dated events outside the current sync window so history accumulates
 * across automatic API refreshes (no CSV required).
 */
function mergeEventsPreservingHistory(existingEvents, newEvents, windowStart) {
  const wsDay = formatDate(windowStart).slice(0, 10);
  const kept = (existingEvents || []).filter((ev) => {
    if (!ev || typeof ev !== 'object') return false;
    const day = String(ev.transaction_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return day < wsDay;
  });
  return [...kept, ...(newEvents || [])];
}

function finaliseAverages(perSku) {
  for (const key of Object.keys(perSku)) {
    const b = perSku[key];
    b.totalFee = Math.round((b.totalFee || 0) * 100) / 100;
    if (!(b.avgFeePerUnit > 0) && b.totalUnits > 0) {
      b.avgFeePerUnit = Math.round((b.totalFee / b.totalUnits) * 10000) / 10000;
    }
    if (!(b.fee_rate > 0) && b.avgFeePerUnit > 0) {
      b.fee_rate = b.avgFeePerUnit;
    }
  }
  return perSku;
}

/**
 * Pull inbound placement fees automatically via Amazon APIs.
 * Prefer SP-API placement charges report; on 403 / empty / invalid type,
 * fall back to Finances PostedDate events (+ shipment SKU allocation).
 * Does not require Seller Central CSV uploads.
 */
async function syncFbaInboundPlacementFees(user, { force = false, days = WINDOW_DAYS } = {}) {
  if (!user?.amazonRefreshToken) {
    return { success: false, reason: 'NOT_CONNECTED' };
  }

  if (!force) {
    const existingFresh = await FbaInboundPlacementFee.findOne(
      { sellerId: user._id },
      { updatedAt: 1, source: 1 },
    ).lean();
    // Legacy CSV / unset snapshots must migrate to Finances API — do not
    // treat them as fresh even if recently touched.
    const needsApiMigration = !existingFresh?.source
      || existingFresh.source === 'seller_central_csv'
      || existingFresh.source === 'unknown';
    if (!needsApiMigration && existingFresh?.updatedAt) {
      const ageHours = (Date.now() - existingFresh.updatedAt.getTime()) / 3_600_000;
      if (ageHours < MIN_REFRESH_HOURS) {
        return {
          success: true,
          skipped: true,
          reason: 'FRESH_CACHE',
          source: existingFresh.source,
          ageHours: Math.round(ageHours * 10) / 10,
        };
      }
    }
  }

  const now = new Date();
  const windowDays = Math.min(Math.max(1, days), 180);
  const fullWindowStart = new Date(now.getTime() - windowDays * 24 * 3_600_000);

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);

  const existing = await FbaInboundPlacementFee.findOne(
    { sellerId: user._id },
    { events: 1, source: 1, updatedAt: 1, perSku: 1 },
  ).lean();
  const priorEvents = existing?.events || [];

  // Incremental Finances pull when we already have API-sourced events.
  // Full window on force, first sync, or when only legacy CSV exists.
  let windowStart = fullWindowStart;
  const priorIsApi = existing?.source === 'finances_join' || existing?.source === 'report';
  if (!force && priorIsApi && priorEvents.length > 0) {
    const overlapMs = 3 * 24 * 3_600_000;
    const incrDays = parseInt(process.env.FBA_INBOUND_PLACEMENT_INCR_DAYS || '21', 10);
    const incrStart = new Date(now.getTime() - Math.max(7, incrDays) * 24 * 3_600_000);
    const fromUpdated = existing.updatedAt
      ? new Date(existing.updatedAt.getTime() - overlapMs)
      : incrStart;
    windowStart = new Date(Math.max(
      fullWindowStart.getTime(),
      Math.min(incrStart.getTime(), fromUpdated.getTime()),
    ));
  }

  let perSku = {};
  let windowEvents = [];
  let source = 'report';
  let stats = null;

  let reportFailed = false;
  // Draft SP-API apps usually 403 on the placement report. Skip unless opted in.
  const tryReport = process.env.FBA_INBOUND_PLACEMENT_TRY_REPORT === 'true';
  if (!tryReport) {
    reportFailed = true;
  } else {
    try {
      const rows = await amazonAPI.fetchFbaInboundPlacementFeeReport(
        formatDate(fullWindowStart),
        formatDate(now),
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const aggregated = aggregateFromReport(rows);
        perSku = await resolveReportKeysToSellerSkus(user, aggregated.perSku);
        windowEvents = await resolveEventsToSellerSkus(user, aggregated.events);
        source = 'report';
        windowStart = fullWindowStart;
      } else {
        reportFailed = true;
        console.warn(
          '[FbaInboundPlacement] Report returned 0 rows; falling back to Finances-join',
        );
      }
    } catch (err) {
      if (isAccessDenied(err) || isInvalidReportType(err)) {
        reportFailed = true;
        console.warn(
          '[FbaInboundPlacement] Report unavailable (' + (err.code || err.message) + '); falling back to Finances-join',
        );
      } else {
        throw err;
      }
    }
  }

  if (reportFailed || windowEvents.length === 0) {
    console.log(
      '[FbaInboundPlacement] Finances pull ' + formatDate(windowStart) + ' → now (force=' + !!force + ')',
    );
    const result = await buildFromFinancesJoin(amazonAPI, user, windowStart, now);
    if ((result.events || []).length > 0) {
      perSku = result.perSku || {};
      windowEvents = result.events || [];
      source = 'finances_join';
      stats = result.stats;
    } else {
      stats = result.stats;
      // Keep prior perSku/events when Amazon returns no placement rows.
      if (existing?.perSku && typeof existing.perSku === 'object') {
        perSku = existing.perSku;
      }
    }
  }

  finaliseAverages(perSku);

  // Only replace the in-window slice when the API actually returned charges.
  // An empty Finances walk must not wipe previously stored dated events.
  let events;
  if (windowEvents.length > 0) {
    events = mergeEventsPreservingHistory(priorEvents, windowEvents, windowStart);
  } else {
    events = Array.isArray(priorEvents) ? priorEvents : [];
    if (events.length > 0 && existing?.source) {
      source = existing.source;
    }
  }

  const setDoc = {
    perSku,
    events,
    windowStart: fullWindowStart,
    windowEnd: now,
    source,
  };
  if (stats) setDoc.stats = stats;

  await FbaInboundPlacementFee.updateOne(
    { sellerId: user._id },
    { $set: setDoc, $setOnInsert: { sellerId: user._id } },
    { upsert: true },
  );

  return {
    success: true,
    skus: Object.keys(perSku).length,
    events: events.length,
    windowEvents: windowEvents.length,
    source,
    stats: stats || undefined,
    windowStart: fullWindowStart,
    fetchStart: windowStart,
    windowEnd: now,
  };
}


module.exports = {
  syncFbaInboundPlacementFees,
  aggregateFromReport,
  resolveReportKeysToSellerSkus,
  resolveEventsToSellerSkus,
  mergeEventsPreservingHistory,
};
