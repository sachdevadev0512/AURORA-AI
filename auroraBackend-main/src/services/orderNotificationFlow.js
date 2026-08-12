/**
 * In-memory trace of the Amazon ORDER_CHANGE → bell pipeline (for diagnostics).
 */

const recentEvents = [];
const MAX_EVENTS = 50;

let stats = {
  sqsMessagesReceived: 0,
  parsedOk: 0,
  userResolved: 0,
  ordersSynced: 0,
  bellPublished: 0,
  skipped: 0,
  errors: 0,
  unparseableDiscarded: 0,
  processingErrors: 0,
  lastEventAt: null,
};

function pushEvent(entry) {
  const row = {
    at: new Date().toISOString(),
    ...entry,
  };
  recentEvents.unshift(row);
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.length = MAX_EVENTS;
  }
  stats.lastEventAt = row.at;
}

function recordStat(key) {
  if (stats[key] !== undefined) {
    stats[key] += 1;
  }
}

function getFlowDiagnostics() {
  const sqsNotificationPoller = require('./sqsNotificationPoller');
  const sqsSetupService = require('./sqsSetupService');

  return {
    stats: { ...stats },
    recentEvents: recentEvents.slice(0, 15),
    sqs: sqsSetupService.getStatus(),
    pollerEnabled: sqsNotificationPoller.isEnabled(),
    socketIoReady: Boolean(global.io),
  };
}

/** Sample ORDER_CHANGE body (Amazon SP-API v1). */
function buildSampleOrderChangePayload({ sellerId, amazonOrderId, orderStatus = 'Unshipped' }) {
  return {
    NotificationVersion: '1.0',
    NotificationType: 'ORDER_CHANGE',
    PayloadVersion: '1.0',
    EventTime: new Date().toISOString(),
    Payload: {
      OrderChangeNotification: {
        NotificationLevel: 'OrderLevel',
        SellerId: sellerId,
        AmazonOrderId: amazonOrderId,
        OrderChangeType: 'OrderStatusChange',
        OrderChangeTrigger: {
          TimeOfOrderChange: new Date().toISOString(),
          ChangeReason: 'Order Status Change',
        },
        Summary: {
          OrderStatus: orderStatus,
          MarketplaceId: 'ATVPDKIKX0DER',
          FulfillmentType: 'MFN',
        },
      },
    },
    NotificationMetadata: {
      NotificationId: `test-${Date.now()}`,
      PublishTime: new Date().toISOString(),
    },
  };
}

module.exports = {
  pushEvent,
  recordStat,
  getFlowDiagnostics,
  buildSampleOrderChangePayload,
};
