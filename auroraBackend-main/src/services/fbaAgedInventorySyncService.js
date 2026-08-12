const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const FbaAgedInventoryFee = require('../models/FbaAgedInventoryFee');

// Freshness gate — skip the SP-API report when the cached snapshot is
// younger than this. Cheap belt-and-braces so a user-triggered inventory
// sync doesn't kick off a 30–120s report generation on every click.
const MIN_REFRESH_HOURS = parseInt(
  process.env.FBA_AGED_INVENTORY_MIN_REFRESH_HOURS || '20',
  10
);

const AIS_FEE_COLUMNS = [
  'estimated-ais-181-210-days',
  'estimated-ais-211-240-days',
  'estimated-ais-241-270-days',
  'estimated-ais-271-300-days',
  'estimated-ais-301-330-days',
  'estimated-ais-331-365-days',
  'estimated-ais-366-455-days',
  'estimated-ais-456-plus-days',
];

const AIS_QTY_COLUMNS = [
  'quantity-to-be-charged-ais-181-210-days',
  'quantity-to-be-charged-ais-211-240-days',
  'quantity-to-be-charged-ais-241-270-days',
  'quantity-to-be-charged-ais-271-300-days',
  'quantity-to-be-charged-ais-301-330-days',
  'quantity-to-be-charged-ais-331-365-days',
  'quantity-to-be-charged-ais-366-455-days',
  'quantity-to-be-charged-ais-456-plus-days',
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

function pickSku(row) {
  return String(row['sku'] || row['seller-sku'] || '').trim();
}

/**
 * Pull the FBA Inventory Planning report and persist per-SKU aged-inventory
 * projections keyed by seller.
 *
 * Best-effort: callers should treat failures as non-fatal.
 */
async function syncFbaAgedInventoryFees(user, { force = false } = {}) {
  if (!user?.amazonRefreshToken) {
    return { success: false, reason: 'NOT_CONNECTED' };
  }

  // Cheap freshness gate before we spin up a 30–120s report.
  if (!force) {
    const existing = await FbaAgedInventoryFee.findOne(
      { sellerId: user._id },
      { updatedAt: 1 },
    ).lean();
    if (existing?.updatedAt) {
      const ageHours = (Date.now() - existing.updatedAt.getTime()) / 3_600_000;
      if (ageHours < MIN_REFRESH_HOURS) {
        return {
          success: true,
          skipped: true,
          reason: 'FRESH_CACHE',
          ageHours: Math.round(ageHours * 10) / 10,
        };
      }
    }
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);

  const rows = await amazonAPI.fetchFbaInventoryPlanningReport();
  if (!Array.isArray(rows) || rows.length === 0) {
    console.warn(
      `[FbaAgedInventory] Report returned 0 rows for ${user.email || user._id}`,
    );
    return { success: true, skus: 0 };
  }

  const perSku = {};
  for (const row of rows) {
    const sku = pickSku(row);
    if (!sku) continue;

    const monthlyFee = AIS_FEE_COLUMNS.reduce(
      (sum, col) => sum + toFloat(row[col]),
      0,
    );
    const totalAgedUnits = AIS_QTY_COLUMNS.reduce(
      (sum, col) => sum + toInt(row[col]),
      0,
    );
    const hdosRaw = row['historical-days-of-supply'];
    const hdos = hdosRaw !== undefined && hdosRaw !== null && hdosRaw !== ''
      ? toFloat(hdosRaw)
      : null;

    if (monthlyFee === 0 && totalAgedUnits === 0 && hdos === null) {
      continue;
    }

    // A SKU can appear once per (fnsku, marketplace) — sum defensively;
    // take the max HDoS across duplicates.
    const bucket = perSku[sku] || {
      monthlyFee: 0,
      totalAgedUnits: 0,
      asin: null,
      historicalDaysOfSupply: null,
    };
    bucket.monthlyFee += monthlyFee;
    bucket.totalAgedUnits += totalAgedUnits;
    if (!bucket.asin && row.asin) bucket.asin = String(row.asin);
    if (hdos !== null) {
      bucket.historicalDaysOfSupply =
        bucket.historicalDaysOfSupply === null
          ? hdos
          : Math.max(bucket.historicalDaysOfSupply, hdos);
    }
    perSku[sku] = bucket;
  }

  // Round fees so we don't churn writes when Amazon returns near-identical
  // floats on repeated runs.
  for (const key of Object.keys(perSku)) {
    perSku[key].monthlyFee = Math.round(perSku[key].monthlyFee * 100) / 100;
    if (perSku[key].historicalDaysOfSupply !== null) {
      perSku[key].historicalDaysOfSupply =
        Math.round(perSku[key].historicalDaysOfSupply * 10) / 10;
    }
  }

  const snapshotDate = new Date();
  await FbaAgedInventoryFee.updateOne(
    { sellerId: user._id },
    {
      $set: { perSku, snapshotDate },
      $setOnInsert: { sellerId: user._id },
    },
    { upsert: true },
  );

  return {
    success: true,
    skus: Object.keys(perSku).length,
    snapshotDate,
  };
}

module.exports = { syncFbaAgedInventoryFees };
