/**
 * Build dated inbound-placement charge events from Finances APIs.
 * Prefer listTransactions (v2024-06-19) — every row has postedDate + ORDER_ID
 * shipment id. Fall back to listFinancialEvents ServiceFeeEventList.
 */
const Shipment = require('../models/Shipment');
const Product = require('../models/Product');

const PLACEMENT_FEE_TYPE_SUBSTRINGS = [
  'inboundplacement',
  'inboundconvenience',
  'inboundtransportationfee',
  'inboundplacementservice',
  'fbainboundplacementservice',
  'placementservice',
  'placementfee',
  'inboundconveniencecharge',
  'fbainboundconvenience',
];

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

function formatDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function financesPostedBefore(d = new Date()) {
  return formatDate(new Date(d.getTime() - 3 * 60_000));
}

function normalizePostedDate(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  return s;
}

function feeAmountFromItem(item) {
  return toFloat(
    item?.FeeAmount?.CurrencyAmount
      ?? item?.FeeAmount?.Amount
      ?? item?.FeeAmount,
  );
}

function isPlacementTransaction(tx) {
  const desc = String(tx?.description || '').toLowerCase().replace(/[\s_-]/g, '');
  if (PLACEMENT_FEE_TYPE_SUBSTRINGS.some((n) => desc.includes(n))) return true;
  for (const item of tx?.items || []) {
    const idesc = String(item?.description || '').toLowerCase().replace(/[\s_-]/g, '');
    if (PLACEMENT_FEE_TYPE_SUBSTRINGS.some((n) => idesc.includes(n))) return true;
    if (/inbound\s*placement/i.test(String(item?.description || ''))) return true;
  }
  return false;
}

function relatedOrderId(tx) {
  for (const r of tx?.relatedIdentifiers || []) {
    const name = String(r.relatedIdentifierName || '').toUpperCase();
    if (name === 'ORDER_ID' || name === 'SHIPMENT_ID') {
      return String(r.relatedIdentifierValue || '').trim();
    }
  }
  return '';
}

async function allocateChargesToEvents(user, shipmentCharges, directCharges, orphanCharges, stats) {
  const events = [];
  const perSku = {};

  const bumpPerSku = (sku, fee, units, asin) => {
    if (!sku || !(fee > 0)) return;
    const bucket = perSku[sku] || {
      totalUnits: 0,
      totalFee: 0,
      avgFeePerUnit: 0,
      asin: null,
    };
    bucket.totalFee += fee;
    bucket.totalUnits += units > 0 ? units : 0;
    if (!bucket.asin && asin) bucket.asin = asin;
    perSku[sku] = bucket;
  };

  for (const c of directCharges) {
    events.push({
      transaction_date: c.postedDate,
      shipment_id: c.shipmentId,
      sku: c.sku,
      asin: c.asin,
      fnsku: null,
      units: 0,
      fee_rate: 0,
      fee_total: Math.round(c.amount * 10000) / 10000,
    });
    bumpPerSku(c.sku, c.amount, 0, c.asin);
  }

  for (const c of orphanCharges) {
    events.push({
      transaction_date: c.postedDate,
      shipment_id: null,
      sku: null,
      asin: c.asin || null,
      fnsku: null,
      units: 0,
      fee_rate: 0,
      fee_total: Math.round(c.amount * 10000) / 10000,
    });
  }

  const feesByShipment = new Map();
  for (const [shipmentId, charges] of shipmentCharges.entries()) {
    feesByShipment.set(
      shipmentId,
      charges.reduce((n, c) => n + c.amount, 0),
    );
  }

  if (feesByShipment.size > 0) {
    const shipmentIds = Array.from(feesByShipment.keys());
    const shipments = await Shipment.find(
      { sellerId: user._id, shipmentId: { $in: shipmentIds } },
      { shipmentId: 1, lineItems: 1 },
    ).lean();
    const byId = new Map(shipments.map((s) => [s.shipmentId, s]));
    stats.shipmentsMatched = shipments.length;
    stats.shipmentsMissingFromDb = shipmentIds.length - shipments.length;

    for (const [shipmentId, charges] of shipmentCharges.entries()) {
      const s = byId.get(shipmentId);
      const items = s?.lineItems || [];
      const totalUnits = items.reduce(
        (n, it) => n + Math.max(toInt(it.unitsReceived), 0),
        0,
      );

      for (const charge of charges) {
        if (!s || totalUnits <= 0) {
          events.push({
            transaction_date: charge.postedDate,
            shipment_id: shipmentId,
            sku: null,
            asin: null,
            fnsku: null,
            units: 0,
            fee_rate: 0,
            fee_total: Math.round(charge.amount * 10000) / 10000,
          });
          continue;
        }
        for (const it of items) {
          const units = Math.max(toInt(it.unitsReceived), 0);
          const sku = String(it.sku || '').trim();
          if (!sku || units <= 0) continue;
          const portion = (charge.amount * units) / totalUnits;
          const rate = units > 0 ? portion / units : 0;
          events.push({
            transaction_date: charge.postedDate,
            shipment_id: shipmentId,
            sku,
            asin: String(it.asin || '').trim().toUpperCase() || null,
            fnsku: String(it.fnsku || it.fnSku || '').trim().toUpperCase() || null,
            units,
            fee_rate: Math.round(rate * 1e6) / 1e6,
            fee_total: Math.round(portion * 10000) / 10000,
          });
          bumpPerSku(
            sku,
            portion,
            units,
            String(it.asin || '').trim().toUpperCase() || null,
          );
        }
      }
    }
  }

  const skus = Object.keys(perSku);
  if (skus.length > 0) {
    const products = await Product.find(
      { sellerId: user._id, sku: { $in: skus } },
      { sku: 1, asin: 1 },
    ).lean();
    for (const p of products) {
      const bucket = perSku[p.sku];
      if (bucket && !bucket.asin && p.asin) bucket.asin = String(p.asin).toUpperCase();
    }
  }

  return { perSku, events, stats };
}

async function buildFromListTransactions(amazonAPI, user, windowStart, windowEnd) {
  const stats = {
    financeEventsScanned: 0,
    placementEventsFound: 0,
    shipmentsMatched: 0,
    shipmentsMissingFromDb: 0,
    path: 'listTransactions',
  };

  const shipmentCharges = new Map();
  const directCharges = [];
  const orphanCharges = [];
  const wsMs = windowStart.getTime();
  const weIso = financesPostedBefore(windowEnd);

  const recordShipmentFee = (shipmentId, postedDate, amount) => {
    if (!shipmentId || !(amount > 0)) return;
    stats.placementEventsFound += 1;
    const list = shipmentCharges.get(shipmentId) || [];
    list.push({ postedDate, amount });
    shipmentCharges.set(shipmentId, list);
  };

  await amazonAPI.iterateTransactions(
    formatDate(windowStart),
    weIso,
    (txs) => {
      stats.financeEventsScanned += txs.length;
      let newestOnPageBeforeWindow = true;
      for (const tx of txs) {
        const postedDate = normalizePostedDate(tx.postedDate);
        const postedMs = postedDate ? Date.parse(postedDate) : NaN;
        if (Number.isFinite(postedMs) && postedMs >= wsMs) {
          newestOnPageBeforeWindow = false;
        }
        if (!isPlacementTransaction(tx)) continue;
        if (Number.isFinite(postedMs) && postedMs < wsMs) continue;

        const amount = Math.abs(toFloat(tx?.totalAmount?.currencyAmount ?? tx?.totalAmount));
        if (!(amount > 0)) continue;

        const shipmentId = relatedOrderId(tx);
        // Prefer item-level SKU context when Amazon provides it.
        let sku = null;
        let asin = null;
        for (const item of tx.items || []) {
          for (const ctx of item.contexts || []) {
            if (ctx?.sku) sku = String(ctx.sku).trim();
            if (ctx?.asin) asin = String(ctx.asin).trim().toUpperCase();
          }
        }

        if (sku) {
          stats.placementEventsFound += 1;
          directCharges.push({
            sku, asin, postedDate, amount, shipmentId: shipmentId || null,
          });
        } else if (shipmentId) {
          recordShipmentFee(shipmentId, postedDate, amount);
        } else {
          stats.placementEventsFound += 1;
          orphanCharges.push({ postedDate, amount, asin });
        }
      }

      // Newest-first: once an entire page is older than the window, stop.
      if (newestOnPageBeforeWindow && txs.length > 0) return false;
      return undefined;
    },
  );

  console.log(
    `[FbaInboundPlacement] listTransactions scanned=${stats.financeEventsScanned} placement=${stats.placementEventsFound}`,
  );
  return allocateChargesToEvents(user, shipmentCharges, directCharges, orphanCharges, stats);
}

async function buildFromFinancialEventsV0(amazonAPI, user, windowStart, windowEnd) {
  const stats = {
    financeEventsScanned: 0,
    placementEventsFound: 0,
    shipmentsMatched: 0,
    shipmentsMissingFromDb: 0,
    path: 'listFinancialEvents',
  };

  const shipmentCharges = new Map();
  const directCharges = [];
  const orphanCharges = [];
  const seenFeeTypes = new Map();

  const recordShipmentFee = (shipmentId, postedDate, amount) => {
    if (!shipmentId || !(amount > 0)) return;
    stats.placementEventsFound += 1;
    const list = shipmentCharges.get(shipmentId) || [];
    list.push({ postedDate, amount });
    shipmentCharges.set(shipmentId, list);
  };

  // Single walk (not month-chunked). ServiceFee often lacks PostedDate —
  // stamp with shipment lastUpdatedDate later via allocate, or window mid.
  const fallbackStamp = financesPostedBefore(windowEnd);

  await amazonAPI.iterateFinancialEvents(
    formatDate(windowStart),
    financesPostedBefore(windowEnd),
    (events) => {
      const list = events.ServiceFeeEventList || [];
      stats.financeEventsScanned += list.length;
      for (const evt of list) {
        const postedDate = normalizePostedDate(evt.PostedDate) || fallbackStamp;
        const sku = String(evt.SellerSKU || '').trim();
        const asin = String(evt.ASIN || '').trim().toUpperCase() || null;
        const shipmentId = String(evt.AmazonOrderId || '').trim();
        const feeDesc = [
          evt.FeeDescription, evt.FeeReason, evt.FeeType,
        ].map((x) => String(x || '').toLowerCase()).join(' ');

        for (const item of evt.FeeList || []) {
          const ft = String(item.FeeType || '');
          seenFeeTypes.set(ft, (seenFeeTypes.get(ft) || 0) + 1);
          const ftNorm = ft.toLowerCase().replace(/[\s_-]/g, '');
          const isPlacement = classifyFeeType(ft)
            || PLACEMENT_ADJUSTMENT_HINTS.some((h) => feeDesc.includes(h) || ftNorm.includes(h));
          if (!isPlacement) continue;
          const amt = Math.abs(feeAmountFromItem(item));
          if (!(amt > 0)) continue;

          if (sku) {
            stats.placementEventsFound += 1;
            directCharges.push({
              sku, asin, postedDate, amount: amt, shipmentId: shipmentId || null,
            });
          } else if (shipmentId) {
            recordShipmentFee(shipmentId, postedDate, amt);
          } else {
            stats.placementEventsFound += 1;
            orphanCharges.push({ postedDate, amount: amt, asin });
          }
        }
      }
    },
  );

  const top = Array.from(seenFeeTypes.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('[FbaInboundPlacement] FeeType frequency (top 15):', top);
  return allocateChargesToEvents(user, shipmentCharges, directCharges, orphanCharges, stats);
}

async function buildFromFinancesJoin(amazonAPI, user, windowStart, windowEnd) {
  try {
    const result = await buildFromListTransactions(amazonAPI, user, windowStart, windowEnd);
    if ((result.events || []).length > 0 || result.stats.placementEventsFound > 0) {
      return result;
    }
    console.warn('[FbaInboundPlacement] listTransactions found 0 placement rows; trying listFinancialEvents');
  } catch (err) {
    console.warn(
      `[FbaInboundPlacement] listTransactions failed (${err.message}); falling back to listFinancialEvents`,
    );
  }
  return buildFromFinancialEventsV0(amazonAPI, user, windowStart, windowEnd);
}

module.exports = {
  buildFromFinancesJoin,
  isPlacementTransaction,
  financesPostedBefore,
  formatDate,
};
