function isCancelledReportStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'unfulfillable') return true;
  return (
    normalized === 'canceled' ||
    normalized === 'cancelled' ||
    normalized.includes('cancel')
  );
}

/** Units for CSV/report rows — cancelled orders contribute 0 quantity. */
function reportItemQuantity(order, item) {
  if (
    isCancelledReportStatus(order?.orderStatus) ||
    isCancelledReportStatus(item?.itemStatus)
  ) {
    return 0;
  }
  return Number(item?.quantityOrdered) || 0;
}

module.exports = {
  isCancelledReportStatus,
  reportItemQuantity,
};
