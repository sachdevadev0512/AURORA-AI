const mongoose = require('mongoose');

/**
 * Per-seller snapshot of Amazon's aged-inventory surcharge projections,
 * sourced from GET_FBA_INVENTORY_PLANNING_DATA.
 *
 * The Inventory Planning report is a snapshot (no date range) so we keep
 * one document per seller and overwrite on each sync — the profitability
 * consumer reads perSku[sku].monthlyFee and amortizes over the analytics
 * window in code.
 */
const fbaAgedInventoryFeeSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  // per-SKU bucket keyed by seller SKU. Mixed (not a sub-schema) because
  // SKUs are user-supplied strings and can contain characters Mongoose's
  // schema paths reject (e.g. dots).
  perSku: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  // Snapshot day. Callers use this to decide freshness (e.g. skip fetch
  // when < 20h old).
  snapshotDate: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('FbaAgedInventoryFee', fbaAgedInventoryFeeSchema);
