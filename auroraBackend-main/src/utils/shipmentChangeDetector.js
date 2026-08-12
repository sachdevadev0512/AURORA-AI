function toComparableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return '';
  return String(value);
}

function shipmentMeaningfulSnapshot(doc) {
  return {
    status: toComparableValue(doc.status),
    skuCount: Number(doc.skuCount ?? 0),
    unitsExpected: Number(doc.unitsExpected ?? 0),
    unitsLocated: Number(doc.unitsLocated ?? 0),
    boxesExpected: Number(doc.boxesExpected ?? 0),
    boxesReceived: Number(doc.boxesReceived ?? 0),
    shipDate: toComparableValue(doc.shipDate),
    trackingId: toComparableValue(doc.trackingId),
    carrierName: toComparableValue(doc.carrierName),
    hasDiscrepancy: Boolean(doc.hasDiscrepancy),
    trackingPackages: JSON.stringify(doc.trackingPackages || []),
    lineItems: JSON.stringify(doc.lineItems || []),
  };
}

function shipmentDataChanged(before, after) {
  return (
    JSON.stringify(shipmentMeaningfulSnapshot(before)) !==
    JSON.stringify(shipmentMeaningfulSnapshot(after))
  );
}

module.exports = {
  shipmentDataChanged,
};
