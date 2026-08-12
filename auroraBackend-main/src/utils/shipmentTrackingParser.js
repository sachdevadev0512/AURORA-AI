const {
  FBA_STATUS_DISPLAY,
  AWD_STATUS_DISPLAY,
  normalizeDate,
  sanitizeFbaShipmentName,
  looksLikeAmazonReferenceId,
  isPlausibleDeliveryDate,
  isPlausibleDeliveryWindow,
} = require('./shipmentParser');

const ACTIVE_TRACKING_STATUSES = new Set([
  'WORKING',
  'CREATED',
  'CHECKED_IN',
  'SHIPPED',
  'IN_TRANSIT',
  'RECEIVING',
  'DELIVERED',
]);

function detectCarrier(trackingId, carrierName) {
  const carrier = String(carrierName || '').toLowerCase();
  const id = String(trackingId || '').trim();
  if (!id) return carrierName || null;

  if (carrier.includes('ups') || /^1z/i.test(id)) return 'UPS';
  if (carrier.includes('fedex') || /^\d{12,22}$/.test(id)) return 'FedEx';
  if (carrier.includes('usps') || /^(94|92|93)/.test(id)) return 'USPS';
  if (carrier.includes('dhl')) return 'DHL';
  return carrierName || 'Carrier';
}

function buildCarrierTrackingUrl(carrierName, trackingId) {
  const id = String(trackingId || '').trim();
  if (!id) return null;

  const carrier = detectCarrier(id, carrierName);
  const encoded = encodeURIComponent(id);

  switch (carrier) {
    case 'UPS':
      return `https://www.ups.com/track?tracknum=${encoded}`;
    case 'FedEx':
      return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
    case 'USPS':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
    case 'DHL':
      return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encoded}`;
    default:
      return `https://www.google.com/search?q=${encodeURIComponent(`${carrierName || 'track'} ${id}`)}`;
  }
}

function normalizePackage(pkg) {
  const trackingId = pkg.trackingId || pkg.TrackingId || pkg.bookingId || null;
  const carrierName = pkg.carrierName || pkg.CarrierName || pkg.carrierCode?.carrierCodeValue || null;
  return {
    boxId: pkg.boxId || pkg.boxID || pkg.BoxId || null,
    trackingId,
    carrierName: detectCarrier(trackingId, carrierName),
    packageStatus: pkg.packageStatus || pkg.PackageStatus || null,
    trackingUrl: null,
  };
}

function parseFbaTransportDetails(payload) {
  const content = payload?.TransportContent || payload?.transportContent || payload;
  if (!content) return { trackingPackages: [], carrierName: null };

  const details = content.TransportDetails || content.transportDetails || {};
  const packages = [];

  const partnered = details.PartneredSmallParcelData || details.partneredSmallParcelData;
  if (partnered?.PackageList || partnered?.packageList) {
    for (const pkg of partnered.PackageList || partnered.packageList || []) {
      packages.push(normalizePackage(pkg));
    }
  }

  const nonPartnered = details.NonPartneredSmallParcelData || details.nonPartneredSmallParcelData;
  if (nonPartnered?.PackageList || nonPartnered?.packageList) {
    for (const pkg of nonPartnered.PackageList || nonPartnered.packageList || []) {
      packages.push(normalizePackage(pkg));
    }
  }

  const ltlPartnered = details.PartneredLtlData || details.partneredLtlData;
  if (ltlPartnered?.AmazonReferenceId || ltlPartnered?.amazonReferenceId) {
    packages.push(
      normalizePackage({
        trackingId: ltlPartnered.AmazonReferenceId || ltlPartnered.amazonReferenceId,
        carrierName: ltlPartnered.CarrierName || ltlPartnered.carrierName,
        packageStatus: content.TransportResult?.TransportStatus || content.transportResult?.transportStatus,
      })
    );
  }

  const ltlNonPartnered = details.NonPartneredLtlData || details.nonPartneredLtlData;
  if (ltlNonPartnered?.ProNumber || ltlNonPartnered?.proNumber) {
    packages.push(
      normalizePackage({
        trackingId: ltlNonPartnered.ProNumber || ltlNonPartnered.proNumber,
        carrierName: ltlNonPartnered.CarrierName || ltlNonPartnered.carrierName,
      })
    );
  }

  const primary = packages.find((p) => p.trackingId) || null;
  return {
    trackingPackages: packages.filter((p) => p.trackingId || p.boxId),
    carrierName: primary?.carrierName || null,
    trackingId: primary?.trackingId || null,
    trackingUrl: null,
  };
}

function parseFbaV2024Shipment(detail) {
  if (!detail) return { trackingPackages: [], inboundPlanId: null };

  const trackingDetails = detail.trackingDetails || detail.tracking_details || {};
  const packages = [];

  const spd = trackingDetails.spdTrackingDetail || trackingDetails.spdTrackingDetails;
  if (spd?.spdTrackingItems || spd?.trackingItems) {
    for (const item of spd.spdTrackingItems || spd.trackingItems || []) {
      packages.push(
        normalizePackage({
          boxId: item.boxId,
          trackingId: item.trackingId,
          carrierName: item.carrierName || spd.carrierName,
        })
      );
    }
  }

  const ltl = trackingDetails.ltlTrackingDetail || trackingDetails.ltlTrackingDetails;
  if (ltl?.billOfLadingNumber || ltl?.freightBillNumber) {
    packages.push(
      normalizePackage({
        trackingId: ltl.freightBillNumber || ltl.billOfLadingNumber,
        carrierName: ltl.carrierName,
      })
    );
  }

  const primary = packages.find((p) => p.trackingId) || null;
  const amazonReferenceId =
    detail.amazonReferenceId || detail.AmazonReferenceId || detail.amazonReferenceID || null;
  const rawName = detail.name || detail.shipmentName || detail.ShipmentName || null;
  const shipmentName = sanitizeFbaShipmentName(rawName, amazonReferenceId);
  const selectedWindow =
    detail.selectedDeliveryWindow ||
    detail.SelectedDeliveryWindow ||
    detail.dates?.selectedDeliveryWindow ||
    null;
  const windowStart = normalizeDate(
    detail.shipDate ||
      selectedWindow?.startDate ||
      selectedWindow?.start ||
      detail.dates?.deliveryWindow?.start ||
      detail.dates?.deliveryWindow?.startDate,
  );
  const windowEnd = normalizeDate(
    detail.estimatedDeliveryDate ||
      selectedWindow?.endDate ||
      selectedWindow?.end ||
      detail.dates?.deliveryWindow?.end ||
      detail.dates?.deliveryWindow?.endDate,
  );
  // Trust Amazon's selectedDeliveryWindow pair; createdDate heuristics can reject
  // valid historical windows when Created was later corrected/synthesized.
  const hasWindow =
    windowStart &&
    windowEnd &&
    isPlausibleDeliveryWindow(windowStart, windowEnd, null);
  return {
    inboundPlanId: detail.inboundPlanId || null,
    v2024ShipmentId: detail.shipmentId || detail.ShipmentId || null,
    shipmentConfirmationId:
      detail.shipmentConfirmationId || detail.ShipmentConfirmationId || null,
    referenceId: amazonReferenceId,
    shipmentName,
    createdDate: normalizeDate(
      detail.createdAt || detail.creationDate || detail.dates?.createdAt,
    ),
    lastUpdatedDate: normalizeDate(
      detail.lastUpdatedAt || detail.updatedAt || detail.dates?.lastUpdatedAt,
    ),
    shipDate: hasWindow ? windowStart : null,
    estimatedDeliveryDate: hasWindow ? windowEnd : null,
    destinationCenterId:
      detail.destination?.warehouseId ||
      detail.destinationFulfillmentCenterId ||
      detail.destination?.address?.name ||
      null,
    status: detail.status ? String(detail.status).toUpperCase() : null,
    trackingPackages: packages,
    carrierName: primary?.carrierName || null,
    trackingId: primary?.trackingId || null,
    trackingUrl: null,
  };
}

function parseAwdTrackingDetails(detail) {
  if (!detail) return { trackingPackages: [] };

  const packages = [];
  const rows = detail.trackingDetails || [];
  for (const row of rows) {
    packages.push(
      normalizePackage({
        trackingId: row.bookingId,
        carrierName: row.carrierCode?.carrierCodeValue || row.carrierCode?.carrierCodeType,
      })
    );
  }

  if (detail.trackingId) {
    packages.unshift(
      normalizePackage({
        trackingId: detail.trackingId,
        carrierName: detail.carrierCode?.carrierCodeValue,
      })
    );
  }

  const unique = [];
  const seen = new Set();
  for (const pkg of packages) {
    const key = `${pkg.trackingId || ''}:${pkg.boxId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pkg);
  }

  const primary = unique.find((p) => p.trackingId) || null;
  return {
    trackingPackages: unique,
    carrierName: primary?.carrierName || null,
    trackingId: primary?.trackingId || null,
    trackingUrl: null,
    shipDate: normalizeDate(detail.shipBy),
    estimatedDeliveryDate: null,
  };
}

function buildStatusTimelineEntry(status, shipmentType, at = new Date()) {
  const raw = String(status || '').toUpperCase();
  const displayStatus =
    shipmentType === 'awd_dc'
      ? AWD_STATUS_DISPLAY[raw] || raw
      : FBA_STATUS_DISPLAY[raw] || raw;

  return {
    status: raw,
    displayStatus,
    at: normalizeDate(at) || new Date(),
  };
}

function mergeStatusTimeline(existingTimeline = [], status, shipmentType) {
  const raw = String(status || '').toUpperCase();
  if (!raw) return existingTimeline;

  const last = existingTimeline[existingTimeline.length - 1];
  if (last && last.status === raw) {
    return existingTimeline;
  }

  return [...existingTimeline, buildStatusTimelineEntry(raw, shipmentType)].slice(-20);
}

function pickPrimaryTracking(trackingPackages) {
  const primary = trackingPackages.find((p) => p.trackingId) || null;
  return {
    trackingId: primary?.trackingId || null,
    carrierName: primary?.carrierName || null,
    trackingUrl: null,
  };
}

function pickAmazonReferenceId(...candidates) {
  for (const candidate of candidates) {
    if (looksLikeAmazonReferenceId(candidate)) {
      return String(candidate).trim();
    }
  }
  return null;
}

function mergeTrackingFields(baseDoc, trackingData, existing = null) {
  const trackingPackages =
    trackingData.trackingPackages?.length > 0
      ? trackingData.trackingPackages
      : existing?.trackingPackages || [];

  const primary = pickPrimaryTracking(trackingPackages);

  const status = trackingData.status || baseDoc.status;
  const rawStatus = String(status).toUpperCase();
  const displayStatus =
    baseDoc.shipmentType === 'awd_dc'
      ? AWD_STATUS_DISPLAY[rawStatus] || baseDoc.displayStatus
      : FBA_STATUS_DISPLAY[rawStatus] || baseDoc.displayStatus;

  const statusTimeline = mergeStatusTimeline(
    existing?.statusTimeline || [],
    status,
    baseDoc.shipmentType
  );

  // Never keep workflow UUIDs (wf…) over Seller Central Amazon Reference IDs.
  const referenceId = pickAmazonReferenceId(
    trackingData.referenceId,
    baseDoc.referenceId,
    existing?.metadata?.warehouseReferenceId,
    existing?.referenceId,
  );

  return {
    ...baseDoc,
    status,
    displayStatus,
    inboundPlanId: trackingData.inboundPlanId || existing?.inboundPlanId || null,
    carrierName: primary.carrierName || trackingData.carrierName || existing?.carrierName || null,
    trackingId: primary.trackingId || trackingData.trackingId || existing?.trackingId || null,
    trackingUrl: null,
    estimatedDeliveryDate:
      trackingData.estimatedDeliveryDate ||
      existing?.estimatedDeliveryDate ||
      baseDoc.estimatedDeliveryDate ||
      null,
    shipDate: trackingData.shipDate || baseDoc.shipDate || existing?.shipDate || null,
    shipmentName:
      trackingData.shipmentName ||
      (existing?.shipmentName &&
      existing.shipmentName !== (trackingData.referenceId || existing.referenceId)
        ? existing.shipmentName
        : null) ||
      baseDoc.shipmentName ||
      null,
    referenceId,
    destinationCenterId:
      trackingData.destinationCenterId || baseDoc.destinationCenterId || existing?.destinationCenterId || null,
    trackingPackages,
    statusTimeline,
    isLiveTracking: ACTIVE_TRACKING_STATUSES.has(String(status).toUpperCase()),
  };
}

function isActiveTrackingStatus(status) {
  return ACTIVE_TRACKING_STATUSES.has(String(status || '').toUpperCase());
}

module.exports = {
  ACTIVE_TRACKING_STATUSES,
  detectCarrier,
  buildCarrierTrackingUrl,
  parseFbaTransportDetails,
  parseFbaV2024Shipment,
  parseAwdTrackingDetails,
  mergeTrackingFields,
  mergeStatusTimeline,
  isActiveTrackingStatus,
};
