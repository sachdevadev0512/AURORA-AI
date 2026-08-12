const mongoose = require('mongoose');

/**
 * Per-seller inbound placement fees, synced automatically from Amazon APIs:
 *   1) GET_FBA_INBOUND_PLACEMENT_FEES_CHARGES_DATA (when the app has access)
 *   2) Finances ServiceFee/Adjustment events (PostedDate) + shipments join
 *
 * Dated `events[]` drive profitability Event-Date totals. Manual Seller
 * Central CSV is optional legacy only — sync overwrites with API data.
 */
const fbaInboundPlacementFeeSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  // Dated charge rows from Seller Central / SP-API report (Transaction date).
  // Profitability sums fee_total for events inside the selected date filter.
  // [{ transaction_date, shipment_id, sku, asin, fnsku, units, fee_rate, fee_total }]
  events: {
    type: [mongoose.Schema.Types.Mixed],
    default: () => [],
  },
  // per-SKU rolled averages (legacy / Finances-join fallback):
  //   { totalUnits, totalFee, avgFeePerUnit, fee_rate, asin, fnsku }
  perSku: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  // Aggregation window used for this snapshot — surfaced so a consumer
  // can decide if it wants a wider/narrower rebuild.
  windowStart: { type: Date, default: null },
  windowEnd: { type: Date, default: null },
  // Which path built this snapshot:
  //   'report'              — SP-API GET_FBA_INBOUND_PLACEMENT_FEES_CHARGES_DATA
  //   'finances_join'       — Finances API service-fee events joined to shipments
  //   'seller_central_csv'  — Seller Central CSV export (fee-rate column)
  //   'unknown'             — legacy or unset
  source: {
    type: String,
    enum: ['report', 'finances_join', 'seller_central_csv', 'unknown'],
    default: 'unknown',
  },
  // Diagnostics for the finances-join path — populated best-effort.
  stats: {
    financeEventsScanned: { type: Number, default: 0 },
    placementEventsFound: { type: Number, default: 0 },
    shipmentsMatched: { type: Number, default: 0 },
    shipmentsMissingFromDb: { type: Number, default: 0 },
  },
}, { timestamps: true });

module.exports = mongoose.model('FbaInboundPlacementFee', fbaInboundPlacementFeeSchema);
