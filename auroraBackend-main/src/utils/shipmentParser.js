const FBA_STATUS_DISPLAY = {
  WORKING: 'Working',
  READY_TO_SHIP: 'Ready to ship',
  CHECKED_IN: 'Checked in',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  RECEIVING: 'Receiving',
  CLOSED: 'Closed',
  CANCELLED: 'Canceled',
  DELETED: 'Deleted',
  ERROR: 'Error',
};

const AWD_STATUS_DISPLAY = {
  CREATED: 'Working',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  RECEIVING: 'Receiving',
  DELIVERED: 'Delivered',
  CLOSED: 'Closed',
  CANCELLED: 'Canceled',
};

/** Seller Central shipment status filter labels (multi-select). */
const UI_STATUS_FILTERS = [
  'Working',
  'Ready to ship',
  'Shipped',
  'In transit',
  'Delivered',
  'Checked in',
  'Receiving',
  'Closed',
  'Canceled',
  'Deleted',
];

const UI_STATUS_TO_DB = {
  Working: ['WORKING', 'CREATED'],
  'Ready to ship': ['READY_TO_SHIP'],
  'Ready to Ship': ['READY_TO_SHIP'],
  Shipped: ['SHIPPED'],
  'In transit': ['IN_TRANSIT'],
  'In Transit': ['IN_TRANSIT'],
  Delivered: ['DELIVERED'],
  'Checked in': ['CHECKED_IN'],
  'Check-in': ['CHECKED_IN'],
  Receiving: ['RECEIVING'],
  Closed: ['CLOSED'],
  Canceled: ['CANCELLED'],
  Cancelled: ['CANCELLED'],
  Deleted: ['DELETED'],
};

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Amazon FBA STA shipment names often embed the creation timestamp, e.g.
 * "FBA STA (06/28/2024 06:22)-TEB9". Classic getShipments does not return
 * CreatedDate / LastUpdatedDate, so we recover dates from the name when present.
 */
function parseDateFromShipmentName(name) {
  if (!name || typeof name !== 'string') return null;
  const match = name.match(
    /\((\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\)/,
  );
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Shipment names use US local wall time; store as UTC wall-clock equivalent
  // so the displayed calendar date matches Seller Central.
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickEarliestDate(...values) {
  const dates = values.map(normalizeDate).filter(Boolean);
  if (!dates.length) return null;
  return dates.reduce((earliest, date) => (date < earliest ? date : earliest));
}

function pickLatestDate(...values) {
  const dates = values.map(normalizeDate).filter(Boolean);
  if (!dates.length) return null;
  return dates.reduce((latest, date) => (date > latest ? date : latest));
}

/** Reject garbage ship dates from item ReleaseDate (often 2004/2012 placeholders). */
function isPlausibleDeliveryDate(date, createdDate = null) {
  const value = normalizeDate(date);
  if (!value) return false;
  if (value.getFullYear() < 2018) return false;
  const created = normalizeDate(createdDate);
  // Delivery windows are booked around / after shipment creation — not years earlier.
  if (created && value.getTime() < created.getTime() - 30 * 24 * 60 * 60 * 1000) {
    return false;
  }
  // Amazon FC delivery windows are typically days/weeks out, not years.
  if (created && value.getTime() > created.getTime() + 400 * 24 * 60 * 60 * 1000) {
    return false;
  }
  return true;
}

/**
 * Seller Central "Delivery window" is a start+end pair (usually 7 days).
 * A lone shipDate without an end is usually a leftover ReleaseDate / NeedByDate — not a window.
 */
function isPlausibleDeliveryWindow(start, end, createdDate = null) {
  const from = normalizeDate(start);
  const to = normalizeDate(end);
  if (!from || !to) return false;
  if (!isPlausibleDeliveryDate(from, createdDate) || !isPlausibleDeliveryDate(to, createdDate)) {
    return false;
  }
  if (to.getTime() < from.getTime()) return false;
  const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  // SC windows are typically 6–14 days; allow a slightly wider band for API edge cases.
  if (spanDays > 45) return false;
  return true;
}

/** Seller Central shipment title (e.g. FBA STA (...)), not Amazon reference ID. */
function isFbaShipmentName(value) {
  if (!value || typeof value !== 'string') return false;
  return /^FBA\s+STA/i.test(value.trim()) || /\(\d{1,2}\/\d{1,2}\/\d{4}/.test(value);
}

/**
 * Amazon reference IDs look like short codes (4TUKOLEF / 2IHIRQNG), not SC titles.
 * Legacy getShipments sometimes puts this value in ShipmentName — never treat as the name.
 */
function looksLikeAmazonReferenceId(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || isFbaShipmentName(trimmed)) return false;
  if (/^FBA[\dA-Z]/i.test(trimmed)) return false;
  // Workflow / UUID-style ids (wf1e2c725d-7d74-…) are not SC Amazon Reference IDs.
  if (/^wf[0-9a-f-]+$/i.test(trimmed)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) return false;
  return /^[A-Z0-9]{6,14}$/i.test(trimmed);
}

/**
 * Seller Central "Amazon Reference ID" for AWD is warehouseReferenceId
 * (short codes like 6KXKOUGO / 4FLWQ9JH). externalReferenceId is often a
 * client/workflow UUID from Send to Amazon Storage — do not show that as the ref.
 */
function resolveAwdReferenceId(summary = {}, detail = null, existing = null) {
  const candidates = [
    detail?.warehouseReferenceId,
    summary.warehouseReferenceId,
    existing?.metadata?.warehouseReferenceId,
    existing?.referenceId,
    summary.externalReferenceId,
    detail?.externalReferenceId,
  ];

  for (const candidate of candidates) {
    if (looksLikeAmazonReferenceId(candidate)) {
      return String(candidate).trim();
    }
  }

  return null;
}

function sanitizeFbaShipmentName(name, referenceId = null) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (looksLikeAmazonReferenceId(trimmed)) return null;
  if (referenceId && trimmed === String(referenceId).trim()) return null;
  return trimmed;
}

/**
 * Seller Central–style title when Amazon list API only returns a reference code.
 * Exact SC name is filled later from inbound-plan enrichment when available.
 * Example: FBA STA (07/08/2026 06:13)-HGR6
 */
function buildSyntheticFbaShipmentName({ createdDate, destinationCenterId } = {}) {
  const dest = String(destinationCenterId || '').trim().toUpperCase();
  const d = normalizeDate(createdDate);
  if (!dest || !d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `FBA STA (${stamp})-${dest}`;
}

function resolveFbaShipmentName(shipmentInfo = {}, existing = null, options = {}) {
  const referenceId = resolveFbaReferenceId(shipmentInfo, existing, shipmentInfo.ShipmentId || shipmentInfo.shipmentId);
  const fromAmazon =
    shipmentInfo.ShipmentName || shipmentInfo.shipmentName || shipmentInfo.name || null;
  const sanitizedAmazon = sanitizeFbaShipmentName(fromAmazon, referenceId);
  if (sanitizedAmazon) return sanitizedAmazon;

  const sanitizedExisting = sanitizeFbaShipmentName(existing?.shipmentName, referenceId || existing?.referenceId);
  if (sanitizedExisting) return sanitizedExisting;

  return buildSyntheticFbaShipmentName({
    createdDate:
      options.createdDate ||
      shipmentInfo.CreatedDate ||
      shipmentInfo.createdDate ||
      shipmentInfo.CreationDate ||
      existing?.createdDate ||
      shipmentInfo.LastUpdatedDate ||
      existing?.lastUpdatedDate ||
      new Date(),
    destinationCenterId:
      options.destinationCenterId ||
      shipmentInfo.DestinationFulfillmentCenterId ||
      shipmentInfo.destinationFulfillmentCenterId ||
      existing?.destinationCenterId,
  });
}

/** Seller Central "Amazon reference ID" (e.g. 4TUKOLEF) — never ShipmentName. */
function resolveFbaReferenceId(shipmentInfo = {}, existing = null, shipmentId = null) {
  const fromAmazon =
    shipmentInfo.AmazonReferenceId ||
    shipmentInfo.amazonReferenceId ||
    shipmentInfo.amazonReferenceID ||
    null;
  const trimmed = typeof fromAmazon === 'string' ? fromAmazon.trim() : fromAmazon;
  if (trimmed && !isFbaShipmentName(trimmed)) return trimmed;

  // Legacy: some list payloads put the reference under ShipmentName.
  const nameFallback =
    shipmentInfo.ShipmentName || shipmentInfo.shipmentName || shipmentInfo.name || null;
  if (looksLikeAmazonReferenceId(nameFallback) && nameFallback !== shipmentId) {
    return String(nameFallback).trim();
  }

  const existingRef = existing?.referenceId;
  if (existingRef && existingRef !== shipmentId && !isFbaShipmentName(existingRef)) {
    return existingRef;
  }
  return null;
}

/** True when a stored date is really an Aurora sync timestamp, not Amazon's date. */
function isSyncArtifactDate(date, existing = null, trustedCreatedDate = null) {
  const value = normalizeDate(date);
  if (!value) return true;

  const markers = [existing?.lastSynced, existing?.createdAt, existing?.updatedAt]
    .map(normalizeDate)
    .filter(Boolean);
  const valueMs = value.getTime();
  if (markers.some((marker) => Math.abs(marker.getTime() - valueMs) < 5 * 60 * 1000)) {
    return true;
  }

  const trusted = normalizeDate(trustedCreatedDate);
  const docCreated = normalizeDate(existing?.createdAt);
  // Batch sync wrote createdDate/lastUpdatedDate on the same day the row was inserted,
  // while the real Amazon date (from shipment name) is earlier.
  if (trusted && docCreated && valueMs > trusted.getTime()) {
    const valueDay = value.toISOString().slice(0, 10);
    const insertDay = docCreated.toISOString().slice(0, 10);
    if (valueDay === insertDay) return true;
  }

  if (trusted && valueMs - trusted.getTime() > 30 * 24 * 60 * 60 * 1000) {
    if (markers.some((marker) => Math.abs(marker.getTime() - valueMs) < 24 * 60 * 60 * 1000)) {
      return true;
    }
  }

  return false;
}

function buildFbaTrackingUrl(shipmentId) {
  if (!shipmentId) return null;
  return `https://sellercentral.amazon.com/fba/inbound-shipment/summary/${encodeURIComponent(shipmentId)}/shipmentId`;
}

function parseFbaLineItems(items = [], existingItems = [], status = null) {
  const parsed = items
    .map((item) => {
      const unitsExpected = Number(item.QuantityShipped ?? item.quantityShipped ?? 0) || 0;
      const unitsReceived = Number(item.QuantityReceived ?? item.quantityReceived ?? 0) || 0;
      const sku = item.SellerSKU || item.sellerSKU;
      if (!sku) return null;
      return {
        sku,
        fnsku: item.FulfillmentNetworkSKU || item.fulfillmentNetworkSKU || null,
        unitsExpected,
        unitsReceived,
        variance: unitsReceived - unitsExpected,
      };
    })
    .filter(Boolean);

  if (!parsed.length) return existingItems || [];

  const apiReceivedTotal = parsed.reduce((sum, row) => sum + (row.unitsReceived || 0), 0);
  const existingReceivedTotal = (existingItems || []).reduce(
    (sum, row) => sum + (Number(row.unitsReceived) || 0),
    0,
  );
  const terminal = new Set([
    'CLOSED',
    'RECEIVING',
    'DELIVERED',
    'CHECKED_IN',
    'IN_TRANSIT',
    'SHIPPED',
  ]);
  // Prefer prior non-zero received counts when Amazon returns a blank receive snapshot.
  if (
    apiReceivedTotal === 0 &&
    existingReceivedTotal > 0 &&
    terminal.has(String(status || '').toUpperCase())
  ) {
    return existingItems;
  }

  return parsed;
}

function parseAwdLineItems(detail = null) {
  const rows = detail?.shipmentSkuQuantities || [];
  return rows
    .map((row) => {
      const sku = row.sku;
      if (!sku) return null;
      const unitsExpected = Number(row.expectedQuantity?.quantity ?? 0) || 0;
      const unitsReceived = Number(row.receivedQuantity?.quantity ?? 0) || 0;
      return {
        sku,
        fnsku: null,
        unitsExpected,
        unitsReceived,
        variance: unitsReceived - unitsExpected,
      };
    })
    .filter(Boolean);
}

function buildShipmentDiscrepancies(shipment) {
  const issues = [];
  const status = String(shipment.status || '').toUpperCase();
  if (status !== 'CLOSED') {
    return issues;
  }

  const isFba = shipment.shipmentType === 'fba_fc';

  if (isFba) {
    const expected = Number(shipment.unitsExpected ?? 0);
    const located = Number(shipment.unitsLocated ?? 0);
    if (expected > 0 && located < expected) {
      issues.push({
        type: 'units_short',
        label: 'Units short',
        expected,
        actual: located,
        variance: located - expected,
        message: `${expected - located} unit(s) still not located at the fulfilment center`,
      });
    } else if (expected > 0 && located > expected) {
      issues.push({
        type: 'units_over',
        label: 'Units over',
        expected,
        actual: located,
        variance: located - expected,
        message: `${located - expected} more unit(s) located than shipped`,
      });
    }
  } else {
    const boxesExpected = Number(shipment.boxesExpected ?? 0);
    const boxesReceived = Number(shipment.boxesReceived ?? 0);
    if (boxesExpected > 0 && boxesReceived < boxesExpected) {
      issues.push({
        type: 'boxes_short',
        label: 'Boxes short',
        expected: boxesExpected,
        actual: boxesReceived,
        variance: boxesReceived - boxesExpected,
        message: `${boxesExpected - boxesReceived} box(es) still not received`,
      });
    } else if (boxesExpected > 0 && boxesReceived > boxesExpected) {
      issues.push({
        type: 'boxes_over',
        label: 'Boxes over',
        expected: boxesExpected,
        actual: boxesReceived,
        variance: boxesReceived - boxesExpected,
        message: `${boxesReceived - boxesExpected} more box(es) received than expected`,
      });
    }
  }

  for (const line of shipment.lineItems || []) {
    if (line.variance !== 0) {
      issues.push({
        type: 'sku_variance',
        label: 'SKU mismatch',
        sku: line.sku,
        expected: line.unitsExpected,
        actual: line.unitsReceived,
        variance: line.variance,
        message: `${line.sku}: expected ${line.unitsExpected}, received ${line.unitsReceived} (${line.variance > 0 ? '+' : ''}${line.variance})`,
      });
    }
  }

  return issues;
}

function applyDiscrepancyFields(doc) {
  const discrepancies = buildShipmentDiscrepancies(doc);
  const status = String(doc.status || '').toUpperCase();
  // Seller Central list warning is about missing inventory (shortfall), not extras.
  // Overage-only closed shipments stay unflagged — SC still shows Located/Expected
  // without treating extras as an actionable discrepancy in the queue.
  let hasDiscrepancy = false;
  if (status === 'CLOSED') {
    if (doc.shipmentType === 'awd_dc') {
      const boxesExpected = Number(doc.boxesExpected ?? 0);
      const boxesReceived = Number(doc.boxesReceived ?? 0);
      hasDiscrepancy = boxesExpected > 0 && boxesReceived < boxesExpected;
    } else {
      const expected = Number(doc.unitsExpected ?? 0);
      const located = Number(doc.unitsLocated ?? 0);
      hasDiscrepancy = expected > 0 && located < expected;
    }
  }
  return {
    ...doc,
    hasDiscrepancy,
    // Keep detailed issues (including overages) for the detail page.
    discrepancies,
  };
}

/**
 * Seller Central "Units located" nets inbound reimbursements that QuantityReceived
 * does not. Lost_Inbound always reduces located; Damaged_Warehouse in the
 * receive window only reduces leftover overage (extras later found damaged).
 *
 * IMPORTANT: Reimbursement rows are SKU-level (no shipment id). Callers must
 * pass only rows already assigned to THIS shipment via
 * assignReimbursementsToShipments — never the full seller report.
 */
function buildInboundLocatedAdjustments(
  reimbursements = [],
  { createdDate = null, lastUpdatedDate = null } = {},
) {
  const created = createdDate ? new Date(createdDate) : null;
  const windowEnd = lastUpdatedDate
    ? new Date(new Date(lastUpdatedDate).getTime() + 60 * 24 * 60 * 60 * 1000)
    : null;
  const lostInbound = new Map();
  const damagedInWindow = new Map();

  const addQty = (map, key, qty) => {
    const k = String(key || '').trim();
    if (!k || !qty) return;
    map.set(k, (map.get(k) || 0) + qty);
  };

  for (const row of reimbursements) {
    const reason = String(row.reason || row.Reason || '');
    const qty =
      Number(
        row['quantity-reimbursed-total'] ??
          row.quantityReimbursedTotal ??
          row.quantity_reimbursed_total ??
          0,
      ) || 0;
    if (qty <= 0) continue;

    const approved = new Date(
      row['approval-date'] || row.approvalDate || row.approval_date || 0,
    );
    if (Number.isNaN(approved.getTime())) continue;
    if (created && approved < created) continue;

    const fnsku = String(row.fnsku || row.FNSKU || '').trim();
    const sku = String(row.sku || row.SKU || '')
      .replace(/&amp;/g, '&')
      .trim();

    if (reason === 'Lost_Inbound') {
      addQty(lostInbound, fnsku, qty);
      addQty(lostInbound, sku, qty);
      continue;
    }

    if (
      reason === 'Damaged_Warehouse' &&
      windowEnd &&
      approved <= windowEnd &&
      (!created || approved >= created)
    ) {
      addQty(damagedInWindow, fnsku, qty);
      addQty(damagedInWindow, sku, qty);
    }
  }

  return { lostInbound, damagedInWindow };
}

function reimbursementMatchesLine(row, lineItems = []) {
  const fnsku = String(row.fnsku || row.FNSKU || '').trim();
  const sku = String(row.sku || row.SKU || '')
    .replace(/&amp;/g, '&')
    .trim();
  return (lineItems || []).find((item) => {
    const itemFn = String(item.fnsku || '').trim();
    const itemSku = String(item.sku || '').trim();
    return (fnsku && itemFn === fnsku) || (sku && itemSku === sku);
  });
}

/**
 * Attribute each Lost_Inbound / Damaged_Warehouse event to at most one shipment.
 * Without this, the same SKU reimbursement would incorrectly reduce located on
 * every historical shipment that shared the FNSKU.
 */
function assignReimbursementsToShipments(shipments = [], reimbursements = []) {
  const byShipment = new Map();
  for (const shipment of shipments) {
    byShipment.set(String(shipment.shipmentId), []);
  }

  const relevant = (reimbursements || []).filter((row) => {
    const reason = String(row.reason || row.Reason || '');
    const qty =
      Number(
        row['quantity-reimbursed-total'] ??
          row.quantityReimbursedTotal ??
          row.quantity_reimbursed_total ??
          0,
      ) || 0;
    return qty > 0 && (reason === 'Lost_Inbound' || reason === 'Damaged_Warehouse');
  });

  for (const row of relevant) {
    const reason = String(row.reason || row.Reason || '');
    const approved = new Date(
      row['approval-date'] || row.approvalDate || row.approval_date || 0,
    );
    if (Number.isNaN(approved.getTime())) continue;

    let best = null;
    let bestScore = -Infinity;

    for (const shipment of shipments) {
      const line = reimbursementMatchesLine(row, shipment.lineItems);
      if (!line) continue;

      const created = shipment.createdDate ? new Date(shipment.createdDate) : null;
      const updated = shipment.lastUpdatedDate
        ? new Date(shipment.lastUpdatedDate)
        : created;
      if (!created || !updated) continue;
      if (approved < created) continue;

      const windowEnd = new Date(updated.getTime() + 60 * 24 * 60 * 60 * 1000);
      if (approved > windowEnd) continue;

      const expected = Number(line.unitsExpected) || 0;
      const received = Number(line.unitsReceived) || 0;
      const overage = Math.max(0, received - expected);
      const shortfall = Math.max(0, expected - received);

      let score = 0;
      if (reason === 'Lost_Inbound') {
        // Prefer the shipment that was actively discrepant for this SKU.
        score += shortfall * 10 + overage * 8 + (received > 0 ? 1 : 0);
      } else {
        // Damaged_Warehouse only belongs on shipments that still show extras.
        if (overage <= 0) continue;
        score += overage * 10;
      }

      // Prefer the shipment whose activity is closest to the approval date.
      const mid = created.getTime() + (updated.getTime() - created.getTime()) / 2;
      const proximity = Math.abs(approved.getTime() - mid);
      score -= proximity / (1000 * 60 * 60 * 24 * 30); // months away

      if (score > bestScore) {
        bestScore = score;
        best = shipment;
      }
    }

    if (!best || bestScore <= 0) continue;
    const list = byShipment.get(String(best.shipmentId));
    if (list) list.push(row);
  }

  return byShipment;
}

function lookupAdjustmentQty(map, item) {
  const fnsku = String(item.fnsku || '').trim();
  const sku = String(item.sku || '').trim();
  // Prefer FNSKU; fall back to SKU. Do not sum both (same event is keyed twice).
  if (fnsku && map.has(fnsku)) return map.get(fnsku) || 0;
  if (sku && map.has(sku)) return map.get(sku) || 0;
  return 0;
}

function applyInboundLocatedAdjustments(lineItems = [], adjustments = null) {
  if (!adjustments || !Array.isArray(lineItems) || !lineItems.length) {
    return {
      lineItems,
      unitsLocated: lineItems.reduce(
        (sum, row) => sum + (Number(row.unitsReceived) || 0),
        0,
      ),
    };
  }

  const nextItems = lineItems.map((item) => {
    const expected = Number(item.unitsExpected) || 0;
    let received = Number(item.unitsReceived) || 0;
    const lost = lookupAdjustmentQty(adjustments.lostInbound, item);
    received = Math.max(0, received - lost);
    const overage = Math.max(0, received - expected);
    const damaged = lookupAdjustmentQty(adjustments.damagedInWindow, item);
    received = Math.max(0, received - Math.min(damaged, overage));
    return {
      ...item,
      unitsReceived: received,
      variance: received - expected,
    };
  });

  return {
    lineItems: nextItems,
    unitsLocated: nextItems.reduce(
      (sum, row) => sum + (Number(row.unitsReceived) || 0),
      0,
    ),
  };
}

function summarizeFbaItems(items = []) {
  const skus = new Set();
  let unitsExpected = 0;
  let unitsLocated = 0;

  // Dedupe by SellerSKU so a NextToken bug cannot inflate unit totals.
  const bySku = new Map();
  for (const item of items) {
    const sku = String(item.SellerSKU || item.sellerSKU || '').trim();
    const key = sku || `anon-${bySku.size}`;
    const existing = bySku.get(key);
    const shipped = Number(item.QuantityShipped ?? item.quantityShipped ?? 0) || 0;
    const received = Number(item.QuantityReceived ?? item.quantityReceived ?? 0) || 0;
    if (!existing) {
      bySku.set(key, { shipped, received });
      continue;
    }
    existing.shipped = Math.max(existing.shipped, shipped);
    existing.received = Math.max(existing.received, received);
  }

  for (const [sku, row] of bySku) {
    if (sku && !sku.startsWith('anon-')) skus.add(sku);
    unitsExpected += row.shipped;
    unitsLocated += row.received;
  }

  return {
    skuCount: skus.size || bySku.size,
    unitsExpected,
    unitsLocated,
    // ReleaseDate is often a catalog placeholder (2012/2018) — never a delivery window.
    shipDate: null,
  };
}

/**
 * Amazon sometimes returns QuantityReceived=0 for CLOSED shipments even when SC
 * previously showed located units. Never regress a known located count to zero.
 */
function resolveFbaUnitsLocated(apiLocated, existingLocated, status) {
  const next = Number(apiLocated ?? 0) || 0;
  const prev = Number(existingLocated ?? 0) || 0;
  if (next > 0) return next;
  const terminal = new Set([
    'CLOSED',
    'RECEIVING',
    'DELIVERED',
    'CHECKED_IN',
    'IN_TRANSIT',
    'SHIPPED',
  ]);
  if (prev > 0 && terminal.has(String(status || '').toUpperCase())) {
    return prev;
  }
  return next;
}

function resolveFbaCreatedDate({
  shipmentName = null,
  existingName = null,
  amazonCreated = null,
  existingCreated = null,
  existing = null,
} = {}) {
  // Seller Central "Created" matches the FBA STA title clock when that instant is
  // shown in the seller's local timezone (name "06:29" UTC → "11:59 AM" IST).
  const nameDate = parseDateFromShipmentName(shipmentName);
  const existingNameDate = parseDateFromShipmentName(existingName);
  const amazon = normalizeDate(amazonCreated);
  const existingValue = normalizeDate(existingCreated);

  if (nameDate) {
    // If Amazon later renames the STA title to a newer clock, keep the original Created.
    if (
      existingValue &&
      existingNameDate &&
      nameDate.getTime() - existingNameDate.getTime() > 6 * 60 * 60 * 1000
    ) {
      return existingValue;
    }
    return nameDate;
  }

  if (amazon) return amazon;

  if (existingValue && !isSyncArtifactDate(existingValue, existing, amazon || existingNameDate)) {
    return existingValue;
  }
  return existingValue || null;
}

function resolveFbaLastUpdatedDate({
  amazonLastUpdated = null,
  existingLastUpdated = null,
  createdDate = null,
  existing = null,
} = {}) {
  const existingValue = isSyncArtifactDate(existingLastUpdated, existing, createdDate)
    ? null
    : existingLastUpdated;
  const latest = pickLatestDate(amazonLastUpdated, existingValue, createdDate);
  return latest;
}

function parseFbaShipment(shipmentInfo, items = [], existing = null, options = {}) {
  const shipmentId = shipmentInfo.ShipmentId || shipmentInfo.shipmentId;
  const rawStatus = String(shipmentInfo.ShipmentStatus || shipmentInfo.shipmentStatus || 'WORKING').toUpperCase();
  const itemSummary = summarizeFbaItems(items);
  const hasItems = items.length > 0;
  const fromAmazonList = options.fromAmazonList === true;
  let lineItems = parseFbaLineItems(items, existing?.lineItems, rawStatus);
  const now = new Date();
  const referenceId = resolveFbaReferenceId(shipmentInfo, existing, shipmentId);
  const destinationCenterId =
    shipmentInfo.DestinationFulfillmentCenterId ||
    shipmentInfo.destinationFulfillmentCenterId ||
    existing?.destinationCenterId ||
    null;
  const amazonCreated = normalizeDate(
    shipmentInfo.CreatedDate ||
      shipmentInfo.createdDate ||
      shipmentInfo.CreationDate ||
      shipmentInfo.creationDate,
  );
  const amazonLastUpdated = normalizeDate(
    shipmentInfo.LastUpdatedDate ||
      shipmentInfo.lastUpdatedDate ||
      shipmentInfo.UpdatedDate ||
      shipmentInfo.updatedDate,
  );
  // Delivery window only comes from inbound-plan selectedDeliveryWindow (enrichment).
  // Do NOT use ConfirmedNeedByDate / item ReleaseDate — those are not SC's Ship-to window.
  const shipDate =
    existing?.shipDate &&
    existing?.estimatedDeliveryDate &&
    isPlausibleDeliveryWindow(existing.shipDate, existing.estimatedDeliveryDate, existing?.createdDate)
      ? normalizeDate(existing.shipDate)
      : null;
  const estimatedDeliveryDate =
    shipDate && existing?.estimatedDeliveryDate
      ? normalizeDate(existing.estimatedDeliveryDate)
      : null;

  // Resolve name before dates so Created can use the SC title clock.
  const shipmentName = resolveFbaShipmentName(shipmentInfo, existing, {
    createdDate: amazonCreated || existing?.createdDate || now,
    destinationCenterId,
  });
  const createdDate = resolveFbaCreatedDate({
    shipmentName,
    existingName: existing?.shipmentName,
    amazonCreated,
    existingCreated: existing?.createdDate,
    existing,
  });
  const lastUpdatedDate = resolveFbaLastUpdatedDate({
    amazonLastUpdated,
    existingLastUpdated: existing?.lastUpdatedDate,
    createdDate,
    existing,
  });

  let unitsLocated = hasItems
    ? resolveFbaUnitsLocated(itemSummary.unitsLocated, existing?.unitsLocated, rawStatus)
    : (existing?.unitsLocated ?? 0);
  const unitsReceivedRaw = hasItems
    ? itemSummary.unitsLocated
    : (existing?.metadata?.unitsReceivedRaw ?? existing?.unitsLocated ?? 0);

  // Align Units Located with Seller Central by netting inbound reimbursements.
  if (hasItems && Array.isArray(options.reimbursements) && options.reimbursements.length) {
    const adjustments = buildInboundLocatedAdjustments(options.reimbursements, {
      createdDate,
      lastUpdatedDate,
    });
    const adjusted = applyInboundLocatedAdjustments(lineItems, adjustments);
    lineItems = adjusted.lineItems;
    unitsLocated = adjusted.unitsLocated;
  } else if (
    hasItems &&
    existing &&
    Number(existing.metadata?.unitsReceivedRaw) === Number(unitsReceivedRaw) &&
    Number(existing.unitsLocated) > 0 &&
    Number(existing.unitsLocated) !== Number(unitsReceivedRaw)
  ) {
    // Reimbursements report unavailable this run — keep the prior SC-adjusted
    // located count while Amazon's raw QuantityReceived is unchanged.
    unitsLocated = Number(existing.unitsLocated);
    if (Array.isArray(existing.lineItems) && existing.lineItems.length) {
      lineItems = existing.lineItems;
    }
  }

  const doc = {
    shipmentType: 'fba_fc',
    shipmentId,
    referenceId,
    shipmentName,
    orderId: null,
    createdDate,
    lastUpdatedDate,
    shipDate,
    estimatedDeliveryDate,
    skuCount: hasItems ? itemSummary.skuCount : (existing?.skuCount ?? 0),
    unitsExpected: hasItems ? itemSummary.unitsExpected : (existing?.unitsExpected ?? 0),
    unitsLocated,
    boxesExpected: null,
    boxesReceived: null,
    status: rawStatus,
    displayStatus: FBA_STATUS_DISPLAY[rawStatus] || rawStatus,
    trackingId: existing?.trackingId || null,
    trackingUrl: null,
    destinationCenterId,
    lineItems: lineItems.length > 0 ? lineItems : existing?.lineItems || [],
    lastSynced: fromAmazonList || hasItems ? now : existing?.lastSynced || now,
    detailsEnrichedAt: hasItems ? now : existing?.detailsEnrichedAt || null,
    metadata: {
      labelPrepType: shipmentInfo.LabelPrepType || shipmentInfo.labelPrepType || null,
      areCasesRequired: shipmentInfo.AreCasesRequired ?? shipmentInfo.areCasesRequired ?? null,
      unitsReceivedRaw,
    },
  };

  return applyDiscrepancyFields(doc);
}

function countAwdBoxes(shipmentDetail) {
  const containers = shipmentDetail?.shipmentContainerQuantities || [];
  let boxesExpected = 0;
  for (const container of containers) {
    boxesExpected += Number(container.count ?? 1) || 0;
  }
  return boxesExpected;
}

function countAwdBoxesReceived(shipmentDetail) {
  const received = shipmentDetail?.receivedQuantity || [];
  const cases = received.find(
    (entry) => String(entry.unitOfMeasurement || '').toUpperCase() === 'CASES'
  );
  if (cases) return Number(cases.quantity) || 0;

  const pallets = received.find(
    (entry) => String(entry.unitOfMeasurement || '').toUpperCase() === 'PALLETS'
  );
  if (pallets) return Number(pallets.quantity) || 0;

  return 0;
}

function summarizeAwdSkus(shipmentDetail) {
  const skuRows = shipmentDetail?.shipmentSkuQuantities || [];
  const skus = new Set();
  let unitsExpected = 0;
  let unitsLocated = 0;

  for (const row of skuRows) {
    if (row.sku) skus.add(row.sku);
    unitsExpected += Number(row.expectedQuantity?.quantity ?? 0) || 0;
    unitsLocated += Number(row.receivedQuantity?.quantity ?? 0) || 0;
  }

  return {
    skuCount: skus.size || skuRows.length,
    unitsExpected,
    unitsLocated,
  };
}

function parseAwdShipment(summary, detail = null, existing = null) {
  const shipmentId = summary.shipmentId || detail?.shipmentId;
  const rawStatus = String(summary.shipmentStatus || detail?.shipmentStatus || 'CREATED').toUpperCase();
  const skuSummary = summarizeAwdSkus(detail || {});
  const boxesExpected = countAwdBoxes(detail || {});
  const boxesReceived = countAwdBoxesReceived(detail || {});
  const trackingId = detail?.trackingId || null;

  const lineItems = parseAwdLineItems(detail || {});
  const referenceId = resolveAwdReferenceId(summary, detail, existing);

  const doc = {
    shipmentType: 'awd_dc',
    shipmentId,
    referenceId,
    orderId: summary.orderId || detail?.orderId || existing?.orderId || null,
    createdDate: normalizeDate(summary.createdAt || detail?.createdAt),
    lastUpdatedDate: normalizeDate(summary.updatedAt || detail?.updatedAt) || new Date(),
    shipDate: normalizeDate(detail?.shipBy),
    skuCount: skuSummary.skuCount,
    unitsExpected: skuSummary.unitsExpected,
    unitsLocated: skuSummary.unitsLocated,
    boxesExpected,
    boxesReceived,
    status: rawStatus,
    displayStatus: AWD_STATUS_DISPLAY[rawStatus] || rawStatus,
    trackingId,
    trackingUrl: null,
    destinationCenterId: detail?.destinationAddress?.name || null,
    lineItems: lineItems.length > 0 ? lineItems : [],
    lastSynced: new Date(),
    metadata: {
      warehouseReferenceId:
        detail?.warehouseReferenceId || existing?.metadata?.warehouseReferenceId || null,
      externalReferenceId:
        summary.externalReferenceId
        || detail?.externalReferenceId
        || existing?.metadata?.externalReferenceId
        || null,
      carrierCode: detail?.carrierCode || existing?.metadata?.carrierCode || null,
    },
  };

  return applyDiscrepancyFields(doc);
}

function resolveLastUpdatedRange(preset, startDateRaw, endDateRaw) {
  const now = new Date();
  const presets = {
    '24h': 24 * 60 * 60 * 1000,
    '7days': 7 * 24 * 60 * 60 * 1000,
    '1week': 7 * 24 * 60 * 60 * 1000,
    '30days': 30 * 24 * 60 * 60 * 1000,
    '3months': 90 * 24 * 60 * 60 * 1000,
    '90days': 90 * 24 * 60 * 60 * 1000,
    '6months': 180 * 24 * 60 * 60 * 1000,
    '1year': 365 * 24 * 60 * 60 * 1000,
  };

  if (preset && preset !== 'all' && preset !== 'custom' && presets[preset]) {
    return {
      $gte: new Date(now.getTime() - presets[preset]),
      $lte: now,
    };
  }

  const range = {};
  if (startDateRaw) {
    const start = new Date(startDateRaw);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      range.$gte = start;
    }
  }
  if (endDateRaw) {
    const end = new Date(endDateRaw);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}

function mapUiStatusToDbStatuses(uiStatus) {
  if (!uiStatus) return null;
  const parts = String(uiStatus)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const dbStatuses = new Set();
  for (const part of parts) {
    const mapped = UI_STATUS_TO_DB[part];
    if (mapped?.length) {
      mapped.forEach((status) => dbStatuses.add(status));
      continue;
    }
    // Case-insensitive fallback for SC label variants.
    const matchedKey = Object.keys(UI_STATUS_TO_DB).find(
      (key) => key.toLowerCase() === part.toLowerCase(),
    );
    if (matchedKey) {
      UI_STATUS_TO_DB[matchedKey].forEach((status) => dbStatuses.add(status));
    } else {
      dbStatuses.add(part.toUpperCase().replace(/\s+/g, '_'));
    }
  }

  return dbStatuses.size > 0 ? [...dbStatuses] : null;
}

function toIsoDate(date) {
  return date ? new Date(date).toISOString() : null;
}

module.exports = {
  FBA_STATUS_DISPLAY,
  AWD_STATUS_DISPLAY,
  UI_STATUS_FILTERS,
  UI_STATUS_TO_DB,
  normalizeDate,
  parseDateFromShipmentName,
  pickLatestDate,
  isFbaShipmentName,
  looksLikeAmazonReferenceId,
  sanitizeFbaShipmentName,
  buildSyntheticFbaShipmentName,
  resolveFbaCreatedDate,
  resolveFbaLastUpdatedDate,
  isPlausibleDeliveryDate,
  isPlausibleDeliveryWindow,
  isSyncArtifactDate,
  summarizeFbaItems,
  resolveFbaUnitsLocated,
  parseFbaLineItems,
  parseAwdLineItems,
  buildInboundLocatedAdjustments,
  applyInboundLocatedAdjustments,
  assignReimbursementsToShipments,
  buildShipmentDiscrepancies,
  applyDiscrepancyFields,
  parseFbaShipment,
  parseAwdShipment,
  resolveLastUpdatedRange,
  mapUiStatusToDbStatuses,
  buildFbaTrackingUrl,
  toIsoDate,
};
