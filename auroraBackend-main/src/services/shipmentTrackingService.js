const Shipment = require('../models/Shipment');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { parseFbaShipment, parseAwdShipment } = require('../utils/shipmentParser');
const {
  parseFbaTransportDetails,
  parseFbaV2024Shipment,
  parseAwdTrackingDetails,
  mergeTrackingFields,
  isActiveTrackingStatus,
} = require('../utils/shipmentTrackingParser');
const { shipmentDataChanged } = require('../utils/shipmentChangeDetector');

const { sleep } = require('../utils/async');

function emitShipmentTrackingUpdate(userId, shipment, changeType = 'updated') {
  if (!global.io || !shipment) return;

  const payload = {
    changeType,
    shipmentId: shipment.shipmentId,
    shipmentDbId: String(shipment._id),
    shipmentType: shipment.shipmentType,
    status: shipment.status,
    displayStatus: shipment.displayStatus,
    trackingId: shipment.trackingId,
    trackingUrl: shipment.trackingUrl,
    carrierName: shipment.carrierName,
    estimatedDeliveryDate: shipment.estimatedDeliveryDate,
    trackingPackages: shipment.trackingPackages,
    statusTimeline: shipment.statusTimeline,
    timestamp: new Date().toISOString(),
  };

  global.io.to(`user_${String(userId)}`).emit('shipmentTrackingUpdate', payload);
}

async function buildInboundPlanIndex(amazonAPI) {
  const index = new Map();
  let nextToken = null;
  let pages = 0;

  do {
    const page = await amazonAPI.listFbaInboundPlans({ nextToken });
    for (const plan of page.plans) {
      const planId = plan.inboundPlanId;
      if (!planId) continue;

      const detail = await amazonAPI.getFbaInboundPlan(planId);
      const shipments = detail?.shipments || detail?.inboundShipments || [];
      for (const entry of shipments) {
        const ids = [
          entry.shipmentId,
          entry.shipmentConfirmationId,
          entry.amazonReferenceId,
        ].filter(Boolean);
        for (const id of ids) {
          index.set(String(id), planId);
        }
      }
    }

    nextToken = page.nextToken;
    pages += 1;
    if (nextToken) await sleep(150);
  } while (nextToken && pages < 5);

  return index;
}

async function fetchFbaTracking(amazonAPI, shipmentId, existing, planIndex = null) {
  let trackingData = { trackingPackages: [] };

  if (existing?.inboundPlanId) {
    const detail = await amazonAPI.getFbaInboundShipmentV2024(existing.inboundPlanId, shipmentId);
    if (detail) {
      trackingData = { ...trackingData, ...parseFbaV2024Shipment({ ...detail, inboundPlanId: existing.inboundPlanId }) };
    }
  } else if (planIndex?.has(shipmentId)) {
    const inboundPlanId = planIndex.get(shipmentId);
    const detail = await amazonAPI.getFbaInboundShipmentV2024(inboundPlanId, shipmentId);
    if (detail) {
      trackingData = { ...trackingData, ...parseFbaV2024Shipment({ ...detail, inboundPlanId }) };
    }
  }

  if (!trackingData.trackingPackages?.length) {
    const transport = await amazonAPI.getFbaTransportDetails(shipmentId);
    if (transport) {
      trackingData = { ...trackingData, ...parseFbaTransportDetails(transport) };
    }
  }

  return trackingData;
}

async function refreshShipmentTracking(user, shipmentDoc, amazonAPI, options = {}) {
  const existing = shipmentDoc.toObject ? shipmentDoc.toObject() : shipmentDoc;
  let baseDoc = existing;
  let trackingData = { trackingPackages: existing.trackingPackages || [] };

  if (existing.shipmentType === 'fba_fc') {
    const shipmentInfo = {
      ShipmentId: existing.shipmentId,
      ShipmentStatus: existing.status,
      ShipmentName: existing.referenceId,
      DestinationFulfillmentCenterId: existing.destinationCenterId,
    };

    try {
      const items = typeof amazonAPI.getAllFbaShipmentItems === 'function'
        ? await amazonAPI.getAllFbaShipmentItems(existing.shipmentId)
        : (await amazonAPI.getFbaShipmentItems(existing.shipmentId)).items || [];
      const allReimbursements =
        typeof amazonAPI.getFbaReimbursementsForLocatedAdjustments === 'function'
          ? await amazonAPI.getFbaReimbursementsForLocatedAdjustments()
          : [];

      let reimbursements = [];
      if (allReimbursements.length) {
        const { assignReimbursementsToShipments, parseFbaLineItems } =
          require('../utils/shipmentParser');
        const siblings = await Shipment.find({
          sellerId: user._id,
          shipmentType: 'fba_fc',
        })
          .select('shipmentId createdDate lastUpdatedDate lineItems')
          .lean();
        const rawLines = parseFbaLineItems(items, existing?.lineItems, existing.status);
        const candidates = siblings.map((row) =>
          String(row.shipmentId) === String(existing.shipmentId)
            ? {
                shipmentId: row.shipmentId,
                createdDate: row.createdDate || existing.createdDate,
                lastUpdatedDate: row.lastUpdatedDate || existing.lastUpdatedDate,
                lineItems: rawLines,
              }
            : row,
        );
        const assignment = assignReimbursementsToShipments(candidates, allReimbursements);
        reimbursements = assignment.get(String(existing.shipmentId)) || [];
      }

      baseDoc = parseFbaShipment(shipmentInfo, items, existing, { reimbursements });
    } catch {
      baseDoc = { ...existing };
    }

    trackingData = await fetchFbaTracking(
      amazonAPI,
      existing.shipmentId,
      existing,
      options.planIndex || null
    );
  } else {
    try {
      const detail = await amazonAPI.getAwdInboundShipment(existing.shipmentId);
      baseDoc = parseAwdShipment(
        {
          shipmentId: existing.shipmentId,
          shipmentStatus: detail?.shipmentStatus || existing.status,
          createdAt: existing.createdDate,
          updatedAt: detail?.updatedAt || existing.lastUpdatedDate,
          externalReferenceId:
            existing.metadata?.externalReferenceId || null,
          orderId: existing.orderId,
        },
        detail,
        existing,
      );
      trackingData = parseAwdTrackingDetails(detail);
      if (detail?.shipmentStatus) {
        trackingData.status = String(detail.shipmentStatus).toUpperCase();
      }
    } catch {
      baseDoc = { ...existing };
    }
  }

  const merged = mergeTrackingFields(baseDoc, trackingData, existing);
  merged.isLiveTracking = isActiveTrackingStatus(merged.status);
  merged.detailsEnrichedAt = merged.detailsEnrichedAt || existing.detailsEnrichedAt || new Date();

  const statusChanged = existing.status !== merged.status;
  const trackingChanged =
    JSON.stringify(existing.trackingPackages || []) !== JSON.stringify(merged.trackingPackages || []);
  const dataChanged = shipmentDataChanged(existing, merged);

  if (!dataChanged) {
    if (!existing.detailsEnrichedAt) {
      await Shipment.updateOne(
        { _id: existing._id, sellerId: user._id },
        { $set: { detailsEnrichedAt: new Date() } },
      );
    }
    try {
      const { evaluateShipmentDelay } = require('./shipmentDelayService');
      await evaluateShipmentDelay(user._id, shipmentDoc);
    } catch (delayErr) {
      console.warn('[ShipmentTracking] Delay check failed:', delayErr.message);
    }
    return shipmentDoc;
  }

  merged.lastTrackedAt = new Date();

  const updated = await Shipment.findOneAndUpdate(
    { _id: existing._id, sellerId: user._id },
    { $set: merged },
    { new: true }
  );

  if (updated && (statusChanged || trackingChanged)) {
    emitShipmentTrackingUpdate(user._id, updated, statusChanged ? 'status_change' : 'tracking_update');
  }

  try {
    const { evaluateShipmentDelay } = require('./shipmentDelayService');
    await evaluateShipmentDelay(user._id, updated || shipmentDoc);
  } catch (delayErr) {
    console.warn('[ShipmentTracking] Delay check failed:', delayErr.message);
  }

  return updated;
}

async function refreshShipmentTrackingById(user, shipmentDbId, options = {}) {
  const shipment = await Shipment.findOne({ _id: shipmentDbId, sellerId: user._id });
  if (!shipment) return null;

  const sellerAppCredentials = await getSellerAppCredentials(user);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  return refreshShipmentTracking(user, shipment, amazonAPI, options);
}

module.exports = {
  emitShipmentTrackingUpdate,
  buildInboundPlanIndex,
  fetchFbaTracking,
  refreshShipmentTracking,
  refreshShipmentTrackingById,
};
