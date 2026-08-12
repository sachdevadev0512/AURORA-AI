/** Statuses where a past-delivery-window alert no longer applies. */
const NON_DELAY_STATUSES = new Set([
  'CLOSED',
  'CANCELLED',
  'CANCELED',
  'DELETED',
  'DELIVERED',
]);

function normalizeShipmentStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function isTerminalShipmentStatus(status) {
  return NON_DELAY_STATUSES.has(normalizeShipmentStatus(status));
}

/**
 * A shipment is delayed when it has an expected delivery date in the past
 * and has not yet reached a terminal status (closed, delivered to FC, etc.).
 */
function isShipmentDelayed(shipment, now = new Date()) {
  if (!shipment?.estimatedDeliveryDate) return false;
  if (isTerminalShipmentStatus(shipment.status)) return false;

  const eta = new Date(shipment.estimatedDeliveryDate);
  if (Number.isNaN(eta.getTime())) return false;

  return eta.getTime() < now.getTime();
}

function daysPastDeliveryWindow(shipment, now = new Date()) {
  if (!isShipmentDelayed(shipment, now)) return 0;
  const eta = new Date(shipment.estimatedDeliveryDate);
  return Math.max(1, Math.ceil((now.getTime() - eta.getTime()) / (24 * 60 * 60 * 1000)));
}

function buildDelayedShipmentQuery(sellerId, now = new Date()) {
  return {
    sellerId,
    estimatedDeliveryDate: { $lt: now, $ne: null },
    status: { $nin: [...NON_DELAY_STATUSES] },
  };
}

module.exports = {
  NON_DELAY_STATUSES,
  normalizeShipmentStatus,
  isTerminalShipmentStatus,
  isShipmentDelayed,
  daysPastDeliveryWindow,
  buildDelayedShipmentQuery,
};
