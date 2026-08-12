/**
 * Map SP-API FBA inventorySummaries (or report-shaped) payloads into the
 * Product.inventory fields Aurora stores and the Products UI displays.
 *
 * Seller Central "Reserved" = pending customer orders + FC processing.
 * Pending FC transfers (pendingTransshipment) are excluded from Reserved and
 * kept separately — matching Manage Inventory.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sellerCentralReserved(reserved = {}) {
  const hasBreakdown =
    reserved.pendingCustomerOrderQuantity != null || reserved.fcProcessingQuantity != null;
  if (hasBreakdown) {
    return num(reserved.pendingCustomerOrderQuantity) + num(reserved.fcProcessingQuantity);
  }
  return num(reserved.totalReservedQuantity);
}

/**
 * Flatten live/report inventoryDetails into Product.inventory scalar fields.
 */
function inventoryFieldsFromFbaItem(fbaItem) {
  const details = fbaItem?.inventoryDetails || {};
  const reserved = details.reservedQuantity || {};
  const unfulfillable = details.unfulfillableQuantity || {};

  const fulfillable = num(details.fulfillableQuantity);
  const inboundWorking = num(details.inboundWorkingQuantity);
  const inboundShipped = num(details.inboundShippedQuantity);
  const inboundReceiving = num(details.inboundReceivingQuantity);
  const inbound = inboundWorking + inboundShipped + inboundReceiving;
  const reservedQty = sellerCentralReserved(reserved);
  const unfulfillableQty = num(unfulfillable.totalUnfulfillableQuantity);

  return {
    quantity: fulfillable,
    totalQuantity: num(fbaItem?.totalQuantity) || fulfillable + reservedQty + inbound + unfulfillableQty,
    fulfillableQuantity: fulfillable,
    reservedQuantity: reservedQty,
    inboundQuantity: inbound,
    unfulfillableQuantity: unfulfillableQty,
    inboundWorkingQuantity: inboundWorking,
    inboundShippedQuantity: inboundShipped,
    inboundReceivingQuantity: inboundReceiving,
    reservedPendingCustomerOrder: num(reserved.pendingCustomerOrderQuantity),
    reservedPendingTransshipment: num(reserved.pendingTransshipmentQuantity),
    reservedFcProcessing: num(reserved.fcProcessingQuantity),
    unfulfillableCustomerDamaged: num(unfulfillable.customerDamagedQuantity),
    unfulfillableWarehouseDamaged: num(unfulfillable.warehouseDamagedQuantity),
    unfulfillableDistributorDamaged: num(unfulfillable.distributorDamagedQuantity),
    unfulfillableCarrierDamaged: num(unfulfillable.carrierDamagedQuantity),
    unfulfillableDefective: num(unfulfillable.defectiveQuantity),
    unfulfillableExpired: num(unfulfillable.expiredQuantity),
  };
}

/**
 * Overlay live FBA Inventory API quantities onto a report-derived fbaItem.
 * MYI reports lag Seller Central; live summaries are the source of truth for qty.
 */
function mergeLiveInventoryOntoFbaItem(reportItem, liveItem) {
  if (!liveItem) return reportItem;
  if (!reportItem) return liveItem;

  return {
    ...reportItem,
    asin: liveItem.asin || reportItem.asin,
    fnSku: liveItem.fnSku || reportItem.fnSku,
    condition: liveItem.condition || reportItem.condition,
    productName: liveItem.productName || reportItem.productName,
    totalQuantity: liveItem.totalQuantity ?? reportItem.totalQuantity,
    lastUpdatedTime: liveItem.lastUpdatedTime || reportItem.lastUpdatedTime,
    inventoryDetails: liveItem.inventoryDetails || reportItem.inventoryDetails,
  };
}

/**
 * Mongo $set patch for Product.inventory from a live summary.
 * Does not touch fulfillmentChannel / manual overrides — caller decides.
 */
function productInventorySetFromFbaItem(fbaItem, { syncedAt = new Date() } = {}) {
  const fields = inventoryFieldsFromFbaItem(fbaItem);
  const set = { lastSynced: syncedAt };
  for (const [key, value] of Object.entries(fields)) {
    set[`inventory.${key}`] = value;
  }
  // Do NOT write fbaItem.lastUpdatedTime onto Product.lastUpdatedTime —
  // that field is listing last-update (Listings Items API), not inventory moves.
  return set;
}

module.exports = {
  num,
  sellerCentralReserved,
  inventoryFieldsFromFbaItem,
  mergeLiveInventoryOntoFbaItem,
  productInventorySetFromFbaItem,
};
