const Shipment = require('../models/Shipment');
const {
  isShipmentDelayed,
  daysPastDeliveryWindow,
  buildDelayedShipmentQuery,
} = require('../utils/shipmentDelayUtils');

const NOTIFICATION_COOLDOWN_MS = Math.max(
  3600000,
  parseInt(process.env.SHIPMENT_DELAY_NOTIFY_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10),
);

function emitShipmentDelayed(userId, payload) {
  if (!global.io) return;
  global.io.to(`user_${String(userId)}`).emit('shipmentDelayed', {
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

async function publishShipmentDelayedNotification(userId, shipment, daysLate) {
  const appNotificationService = require('./appNotificationService');
  const shipmentDbId = String(shipment._id);
  const eta = shipment.estimatedDeliveryDate
    ? new Date(shipment.estimatedDeliveryDate).toLocaleDateString()
    : 'expected date';

  const doc = await appNotificationService.createNotification(userId, {
    source: 'aurora',
    type: 'shipment_delayed',
    title: 'Shipment delayed',
    message: `${shipment.shipmentId} is ${daysLate} day(s) past the expected delivery window (${eta})`,
    link: `/shipments/${shipmentDbId}`,
    metadata: {
      priority: 'high',
      shipmentId: shipment.shipmentId,
      shipmentDbId,
      shipmentType: shipment.shipmentType,
      estimatedDeliveryDate: shipment.estimatedDeliveryDate,
      daysLate,
      status: shipment.status,
      displayStatus: shipment.displayStatus,
    },
  });

  emitShipmentDelayed(userId, {
    count: 1,
    shipment: {
      _id: shipmentDbId,
      shipmentId: shipment.shipmentId,
      displayStatus: shipment.displayStatus,
      estimatedDeliveryDate: shipment.estimatedDeliveryDate,
      daysLate,
    },
  });

  return doc;
}

async function shouldNotifyForShipment(shipment) {
  if (!shipment.delayNotifiedAt) return true;

  const cooldownElapsed = Date.now() - new Date(shipment.delayNotifiedAt).getTime() >= NOTIFICATION_COOLDOWN_MS;
  if (!cooldownElapsed) return false;

  const estKey = shipment.estimatedDeliveryDate
    ? new Date(shipment.estimatedDeliveryDate).toISOString()
    : null;
  const lastEstKey = shipment.metadata?.lastDelayEstDate || null;

  return estKey !== lastEstKey || cooldownElapsed;
}

async function evaluateShipmentDelay(userId, shipmentDoc) {
  const shipment = shipmentDoc?.toObject ? shipmentDoc.toObject() : shipmentDoc;
  if (!shipment?._id) return { delayed: false };

  const now = new Date();
  const delayed = isShipmentDelayed(shipment, now);

  if (!delayed) {
    if (shipment.isDelayed) {
      await Shipment.updateOne(
        { _id: shipment._id, sellerId: userId },
        { $set: { isDelayed: false } },
      );
    }
    return { delayed: false };
  }

  const daysLate = daysPastDeliveryWindow(shipment, now);
  const updates = {
    isDelayed: true,
    'metadata.daysLate': daysLate,
  };

  let notified = false;
  if (await shouldNotifyForShipment(shipment)) {
    await publishShipmentDelayedNotification(userId, shipment, daysLate);
    updates.delayNotifiedAt = now;
    updates['metadata.lastDelayEstDate'] = shipment.estimatedDeliveryDate
      ? new Date(shipment.estimatedDeliveryDate).toISOString()
      : null;
    notified = true;
  }

  await Shipment.updateOne({ _id: shipment._id, sellerId: userId }, { $set: updates });

  return { delayed: true, daysLate, notified };
}

async function checkDelayedShipmentsForUser(userId) {
  const now = new Date();
  const candidates = await Shipment.find(buildDelayedShipmentQuery(userId, now))
    .sort({ estimatedDeliveryDate: 1 })
    .limit(50);

  let notifiedCount = 0;
  for (const shipment of candidates) {
    const result = await evaluateShipmentDelay(userId, shipment);
    if (result.notified) notifiedCount += 1;
  }

  await Shipment.updateMany(
    {
      sellerId: userId,
      isDelayed: true,
      $or: [
        { estimatedDeliveryDate: { $gte: now } },
        { estimatedDeliveryDate: null },
        { status: { $in: [...require('../utils/shipmentDelayUtils').NON_DELAY_STATUSES] } },
      ],
    },
    { $set: { isDelayed: false } },
  );

  if (notifiedCount > 0) {
    const summary = await getDelayedShipmentsSummary(userId);
    emitShipmentDelayed(userId, { count: summary.count, shipments: summary.shipments });
  }

  return { checked: candidates.length, notified: notifiedCount };
}

async function getDelayedShipmentsSummary(userId, { limit = 10 } = {}) {
  const now = new Date();
  const query = buildDelayedShipmentQuery(userId, now);

  const [count, shipments] = await Promise.all([
    Shipment.countDocuments(query),
    Shipment.find(query)
      .sort({ estimatedDeliveryDate: 1 })
      .limit(limit)
      .select({
        shipmentId: 1,
        shipmentType: 1,
        displayStatus: 1,
        status: 1,
        estimatedDeliveryDate: 1,
        referenceId: 1,
        trackingId: 1,
      })
      .lean(),
  ]);

  return {
    count,
    shipments: shipments.map((s) => ({
      _id: String(s._id),
      shipmentId: s.shipmentId,
      shipmentType: s.shipmentType,
      displayStatus: s.displayStatus,
      status: s.status,
      estimatedDeliveryDate: s.estimatedDeliveryDate,
      referenceId: s.referenceId,
      trackingId: s.trackingId,
      daysLate: daysPastDeliveryWindow(s, now),
    })),
  };
}

module.exports = {
  evaluateShipmentDelay,
  checkDelayedShipmentsForUser,
  getDelayedShipmentsSummary,
  publishShipmentDelayedNotification,
  emitShipmentDelayed,
};
