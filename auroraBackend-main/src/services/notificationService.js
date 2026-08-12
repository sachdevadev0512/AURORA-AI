const User = require('../models/User');
const Order = require('../models/Order');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { normalizeOrderForDb } = require('../utils/orderNotificationNormalizer');
const { upsertOrderFromLiveSync } = require('../utils/orderUpdateMerge');
const { loadSellerFeeMap } = require('../utils/orderItemFees');
const notificationsApi = require('../utils/notificationsApi');
const { verifyAmazonNotification } = require('../utils/spApiNotificationVerifier');
const { buildExactCaseInsensitiveRegex } = require('../utils/regexSearch');

let cachedDestinationId = process.env.NOTIFICATION_DESTINATION_ID || null;

async function publishOrderToUser(userId, order, { event = 'ORDER_CHANGE', orderChangeType = null } = {}) {
  const appNotificationService = require('./appNotificationService');
  return appNotificationService.publishAmazonOrderUpdate(userId, order, {
    event,
    orderChangeType,
  });
}

/**
 * Parse SP-API notification payload (SQS body or webhook JSON).
 */
function parseOrderChangeNotification(body) {
  if (!body || typeof body !== 'object') return null;

  const notificationType = body.NotificationType || body.notificationType;
  if (notificationType && notificationType !== 'ORDER_CHANGE') {
    return { skip: true, notificationType };
  }

  const payload = body.Payload || body.payload || body;
  const innerPayload = payload?.payload || payload;
  const change =
    innerPayload?.OrderChangeNotification ||
    innerPayload?.orderChangeNotification ||
    payload?.OrderChangeNotification ||
    payload?.orderChangeNotification ||
    body.OrderChangeNotification ||
    body.orderChangeNotification;

  if (change) {
    return {
      notificationType: 'ORDER_CHANGE',
      amazonOrderId: change.AmazonOrderId || change.amazonOrderId,
      amazonSellerId: change.SellerId || change.sellerId,
      orderChangeType: change.OrderChangeType || change.orderChangeType,
      summary: change.Summary || change.summary,
      messageId: body.MessageId || body.messageId,
    };
  }

  // Legacy/test shape — only accepted outside production (dev simulate endpoint).
  if (
    process.env.NODE_ENV !== 'production' &&
    body.notificationType === 'ORDER_CHANGE' &&
    body.payload?.orderId
  ) {
    return {
      notificationType: 'ORDER_CHANGE',
      amazonOrderId: body.payload.orderId,
      amazonSellerId: body.sellerId,
      messageId: body.messageId,
    };
  }

  // SP-API v1 lowercase notificationType at root
  if (
    (body.notificationType === 'ORDER_CHANGE' || body.NotificationType === 'ORDER_CHANGE') &&
    (body.payload || body.Payload)
  ) {
    const payload = body.payload || body.Payload;
    const change = payload.orderChangeNotification || payload.OrderChangeNotification;
    if (change) {
      return {
        notificationType: 'ORDER_CHANGE',
        amazonOrderId: change.amazonOrderId || change.AmazonOrderId,
        amazonSellerId: change.sellerId || change.SellerId,
        orderChangeType: change.orderChangeType || change.OrderChangeType,
        summary: change.summary || change.Summary,
        messageId: body.messageId || body.MessageId,
      };
    }
  }

  return null;
}

async function resolveUserForSellerId(sellerId) {
  if (!sellerId) return null;

  const trimmed = String(sellerId).trim();
  let user = await User.findOne({ amazonSellerId: trimmed });

  if (!user && trimmed !== sellerId) {
    user = await User.findOne({ amazonSellerId: sellerId });
  }

  if (!user) {
    const sellerIdRegex = buildExactCaseInsensitiveRegex(trimmed);
    user = sellerIdRegex
      ? await User.findOne({ amazonSellerId: { $regex: sellerIdRegex } })
      : null;
  }

  if (!user) {
    console.warn(
      `[OrderNotifications] No Aurora user with amazonSellerId="${trimmed}". ` +
        'Ensure this account completed Amazon OAuth on Integration.'
    );
  }

  return user;
}

async function resolveDestinationId() {
  if (cachedDestinationId) {
    return cachedDestinationId;
  }

  const envDestination = process.env.NOTIFICATION_DESTINATION_ID;
  if (envDestination) {
    cachedDestinationId = envDestination;
    return cachedDestinationId;
  }

  try {
    const { loadLocalSqsConfig } = require('../utils/sqsLocalConfig');
    const local = loadLocalSqsConfig();
    if (local?.destinationId) {
      cachedDestinationId = local.destinationId;
      process.env.NOTIFICATION_DESTINATION_ID = local.destinationId;
      return cachedDestinationId;
    }
  } catch (e) {
    console.warn('[OrderNotifications] Local destination load failed:', e.message);
  }

  const sqsArn = process.env.AWS_SQS_QUEUE_ARN;
  if (!sqsArn) {
    throw new Error(
      'Set NOTIFICATION_DESTINATION_ID or AWS_SQS_QUEUE_ARN to enable ORDER_CHANGE subscriptions'
    );
  }

  const { getEnvironmentCredentials } = require('../utils/sellerAppHelper');
  cachedDestinationId = await notificationsApi.ensureSqsDestination(
    sqsArn,
    getEnvironmentCredentials()
  );

  if (cachedDestinationId) {
    process.env.NOTIFICATION_DESTINATION_ID = cachedDestinationId;
    try {
      const { saveLocalSqsConfig, loadLocalSqsConfig } = require('../utils/sqsLocalConfig');
      const local = loadLocalSqsConfig() || {};
      saveLocalSqsConfig({
        queueArn: sqsArn,
        queueUrl: process.env.AWS_SQS_QUEUE_URL || local.queueUrl,
        region: process.env.AWS_REGION || local.region,
        destinationId: cachedDestinationId,
      });
    } catch (e) {
      console.warn('[OrderNotifications] Could not persist destinationId:', e.message);
    }
  }

  return cachedDestinationId;
}

async function syncOrderById(user, amazonOrderId) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const orderDetails = await amazonAPI.getOrderDetails(amazonOrderId);

  if (!orderDetails?.amazonOrderId && !orderDetails?.AmazonOrderId) {
    throw new Error(`Could not load order ${amazonOrderId} from Amazon`);
  }

  const skus = (orderDetails.orderItems || [])
    .map((item) => item.SellerSKU || item.sellerSku)
    .filter(Boolean);
  const feeMap = await loadSellerFeeMap(user._id, skus);
  const orderData = normalizeOrderForDb(user._id, orderDetails, feeMap);
  return upsertOrderFromLiveSync(Order, user._id, orderData);
}

class NotificationService {
  /**
   * Handle notification from SQS poller or HTTP webhook (testing/bridge).
   */
  async handleIncomingNotification(body) {
    const flow = require('./orderNotificationFlow');
    flow.recordStat('sqsMessagesReceived');
    flow.pushEvent({ step: 'sqs_received', notificationType: body?.NotificationType || body?.notificationType });

    const parsed = parseOrderChangeNotification(body);

    if (!parsed) {
      flow.recordStat('skipped');
      flow.pushEvent({ step: 'parse_failed', sample: JSON.stringify(body).slice(0, 200) });
      return { skipped: true, reason: 'unrecognized_payload' };
    }

    if (parsed.skip) {
      flow.recordStat('skipped');
      flow.pushEvent({ step: 'skipped_type', type: parsed.notificationType });
      return { skipped: true, reason: parsed.notificationType };
    }

    if (!parsed.amazonOrderId) {
      console.warn('[OrderNotifications] ORDER_CHANGE without AmazonOrderId');
      flow.recordStat('skipped');
      return { skipped: true, reason: 'missing_order_id' };
    }

    flow.recordStat('parsedOk');
    flow.pushEvent({
      step: 'parsed',
      amazonOrderId: parsed.amazonOrderId,
      sellerId: parsed.amazonSellerId,
      orderChangeType: parsed.orderChangeType,
    });

    const sellerId = parsed.amazonSellerId;
    const user = await resolveUserForSellerId(sellerId);

    if (!user) {
      console.warn(`[OrderNotifications] No user for seller ${sellerId || 'unknown'}`);
      flow.recordStat('skipped');
      flow.pushEvent({ step: 'user_not_found', sellerId });
      return { skipped: true, reason: 'user_not_found', sellerId };
    }

    if (!user.amazonRefreshToken) {
      console.warn(`[OrderNotifications] User ${user._id} missing SP-API token`);
      flow.recordStat('skipped');
      return { skipped: true, reason: 'sp_not_connected' };
    }

    flow.recordStat('userResolved');

    const summaryStatus =
      parsed.summary?.OrderStatus || parsed.summary?.orderStatus || null;

    let savedOrder = null;
    try {
      savedOrder = await syncOrderById(user, parsed.amazonOrderId);
      flow.recordStat('ordersSynced');
    } catch (syncErr) {
      console.error(`[OrderNotifications] syncOrderById failed:`, syncErr.message);
      flow.recordStat('errors');
      flow.pushEvent({ step: 'sync_failed', error: syncErr.message, amazonOrderId: parsed.amazonOrderId });

      const appNotificationService = require('./appNotificationService');
      await appNotificationService.createNotification(user._id, {
        source: 'amazon',
        type: 'amazon_order',
        title: 'Amazon: Order update (sync pending)',
        message: `Order ${parsed.amazonOrderId}${summaryStatus ? ` — ${summaryStatus}` : ''}. Could not refresh full details yet.`,
        link: '/orders',
        metadata: {
          event: 'ORDER_CHANGE',
          amazonOrderId: parsed.amazonOrderId,
          orderChangeType: parsed.orderChangeType,
          syncError: syncErr.message,
        },
      });
      flow.recordStat('bellPublished');
      flow.pushEvent({ step: 'bell_partial', amazonOrderId: parsed.amazonOrderId });

      return { success: false, reason: 'sync_failed', error: syncErr.message, bellNotified: true };
    }

    try {
      await publishOrderToUser(user._id, savedOrder, {
        event: 'ORDER_CHANGE',
        orderChangeType: parsed.orderChangeType,
      });
      flow.recordStat('bellPublished');
      flow.pushEvent({
        step: 'bell_ok',
        userId: String(user._id),
        amazonOrderId: parsed.amazonOrderId,
        orderStatus: savedOrder.orderStatus,
      });
    } catch (notifyErr) {
      console.warn('[OrderNotifications] Failed to publish bell notification:', notifyErr.message);
      flow.recordStat('errors');
    }

    return {
      success: true,
      orderId: parsed.amazonOrderId,
      order: savedOrder,
    };
  }

  async subscribeToOrderNotifications(user) {
    if (!user.amazonRefreshToken) {
      const error = new Error('Amazon Selling Partner account is not connected');
      error.code = 'SP_NOT_CONNECTED';
      throw error;
    }

    if (!user.amazonSellerId) {
      const error = new Error('Amazon Seller ID is missing. Reconnect your Amazon account.');
      error.code = 'SELLER_ID_MISSING';
      throw error;
    }

    const destinationId = await resolveDestinationId();
    const sellerAppCredentials = await getSellerAppCredentials(user._id);

    const subscription = await notificationsApi.ensureOrderChangeSubscription(
      user,
      destinationId,
      sellerAppCredentials
    );

    const subscriptionId =
      subscription.subscriptionId ||
      subscription.payload?.subscriptionId ||
      `dest:${destinationId}`;

    await User.findByIdAndUpdate(user._id, {
      orderNotificationSubscriptionId: subscriptionId,
      orderNotificationsEnabled: true,
      orderNotificationsSubscribedAt: new Date(),
    });


    try {
      const appNotificationService = require('./appNotificationService');
      await appNotificationService.publishAmazonLiveEnabled(user._id);
    } catch (notifyErr) {
      console.warn('[OrderNotifications] Bell notification for subscribe failed:', notifyErr.message);
    }

    return {
      subscriptionId,
      destinationId,
      notificationType: 'ORDER_CHANGE',
      reused: subscription.reused,
    };
  }

  /**
   * Align DB + SQS with Amazon when subscription already exists (409 / reconnect).
   */
  async repairOrderNotificationSetup(user) {
    const sqsSetupService = require('./sqsSetupService');
    const sqsResult = await sqsSetupService.ensureConfigured();
    if (!sqsResult.configured) {
      throw new Error(sqsResult.message || 'SQS not configured');
    }

    if (!user.amazonRefreshToken) {
      const error = new Error('Amazon account not connected');
      error.code = 'SP_NOT_CONNECTED';
      throw error;
    }

    return this.subscribeToOrderNotifications(user);
  }

  async unsubscribeFromNotifications(user) {
    const subscriptionId = user.orderNotificationSubscriptionId;

    if (!subscriptionId || subscriptionId.startsWith('dest:')) {
      await User.findByIdAndUpdate(user._id, {
        orderNotificationSubscriptionId: null,
        orderNotificationsEnabled: false,
      });
      return true;
    }

    try {
      const sellerAppCredentials = await getSellerAppCredentials(user._id);
      await notificationsApi.deleteOrderChangeSubscription(
        subscriptionId,
        sellerAppCredentials,
        user
      );
    } catch (error) {
      console.warn(`[OrderNotifications] Unsubscribe API warning for ${user._id}:`, error.message);
    }

    await User.findByIdAndUpdate(user._id, {
      orderNotificationSubscriptionId: null,
      orderNotificationsEnabled: false,
    });

    return true;
  }

  async getSubscriptionStatus(user) {
    const sqsSetupService = require('./sqsSetupService');
    const sqs = sqsSetupService.getStatus();

    let amazonSubscription = null;
    if (user.amazonRefreshToken) {
      try {
        const sellerAppCredentials = await getSellerAppCredentials(user._id);
        amazonSubscription = await notificationsApi.getOrderChangeSubscription(
          user,
          sellerAppCredentials
        );
      } catch (err) {
        amazonSubscription = { error: err.message };
      }
    }

    const amazonSubId =
      amazonSubscription?.subscriptionId ||
      amazonSubscription?.payload?.subscriptionId;

    return {
      subscribed: Boolean(
        user.orderNotificationsEnabled &&
          (user.orderNotificationSubscriptionId || amazonSubId)
      ),
      amazonSubscriptionActive: Boolean(amazonSubId),
      amazonSubscriptionId: amazonSubId || null,
      subscriptionId: user.orderNotificationSubscriptionId || null,
      subscribedAt: user.orderNotificationsSubscribedAt || null,
      destinationId: cachedDestinationId || process.env.NOTIFICATION_DESTINATION_ID || null,
      sqsPolling: Boolean(process.env.AWS_SQS_QUEUE_URL && sqs.pollingEnabled),
      sqs: {
        configured: sqs.configured,
        queueArn: sqs.queueArn,
        queueUrl: sqs.queueUrl,
        region: sqs.region,
        sellingRegion: sqs.sellingRegion,
        autoCreateSqs: sqs.autoCreateSqs,
        autoCreateDestination: sqs.autoCreateDestination,
      },
    };
  }

  /** @deprecated Use handleIncomingNotification */
  async processOrderNotification(notification, user) {
    const amazonOrderId =
      notification?.payload?.orderId ||
      notification?.Payload?.OrderChangeNotification?.AmazonOrderId;

    if (!amazonOrderId) return null;

    const savedOrder = await syncOrderById(user, amazonOrderId);
    await publishOrderToUser(user._id, savedOrder, { event: 'ORDER_CHANGE' });
    return { success: true, orderId: amazonOrderId, order: savedOrder };
  }

  async verifyNotificationSignature({ rawBody, parsedBody, signature, certUrl, timestamp }) {
    return verifyAmazonNotification({
      rawBody,
      parsedBody,
      signature,
      certUrl,
      timestamp,
    });
  }

  async bootstrap() {
    const sqsSetupService = require('./sqsSetupService');

    try {
      const sqsResult = await sqsSetupService.ensureConfigured();
      if (!sqsResult.configured) {
        console.warn(`[OrderNotifications] SQS not configured: ${sqsResult.message}`);
      }
    } catch (error) {
      console.error('[OrderNotifications] SQS setup failed:', error.message);
    }

    const destinationId = process.env.NOTIFICATION_DESTINATION_ID;
    const sqsArn = process.env.AWS_SQS_QUEUE_ARN;

    if (destinationId) {
      cachedDestinationId = destinationId;
      return;
    }

    const autoDest =
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_DESTINATION === 'true' ||
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_DESTINATION === '1';

    if (sqsArn && autoDest) {
      try {
        cachedDestinationId = await resolveDestinationId();
        process.env.NOTIFICATION_DESTINATION_ID = cachedDestinationId;
      } catch (error) {
        console.error('[OrderNotifications] Could not resolve destination:', error.message);
      }
    } else if (!destinationId && !sqsArn) {
      console.warn(
        '[OrderNotifications] Set NOTIFICATION_DESTINATION_ID or AWS_SQS_QUEUE_ARN (or enable ORDER_NOTIFICATIONS_AUTO_CREATE_SQS)'
      );
    }
  }

  async resubscribeAllConnectedUsers() {
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
      amazonSellerId: { $exists: true, $ne: null },
      orderNotificationsEnabled: true,
    });

    for (const user of users) {
      try {
        await this.subscribeToOrderNotifications(user);
      } catch (error) {
        console.error(`[OrderNotifications] Re-subscribe failed for ${user._id}:`, error.message);
      }
    }
  }
}

module.exports = new NotificationService();
