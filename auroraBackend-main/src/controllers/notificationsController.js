const notificationService = require('../services/notificationService');
const sqsSetupService = require('../services/sqsSetupService');
const User = require('../models/User');

exports.handleAmazonNotification = async (req, res) => {
  try {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ORDER_NOTIFICATIONS_HTTP_WEBHOOK_ENABLED !== 'true'
    ) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}), 'utf8');

    let parsedBody = req.body;
    if (Buffer.isBuffer(req.body)) {
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
      }
    }

    const isValid = await notificationService.verifyNotificationSignature({
      rawBody,
      parsedBody,
      signature: req.headers['x-amzn-spapi-signature'],
      certUrl: req.headers['x-amzn-spapi-cert-url'],
      timestamp: req.headers['x-amzn-spapi-timestamp'],
    });
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid signature' });
    }

    if (parsedBody?.Type === 'SubscriptionConfirmation' && parsedBody?.SubscribeURL) {
      try {
        await fetch(parsedBody.SubscribeURL);
      } catch (confirmError) {
        console.warn('[handleAmazonNotification] SNS subscription confirm failed:', confirmError.message);
      }
      return res.status(200).json({ success: true, confirmed: true });
    }

    const result = await notificationService.handleIncomingNotification(parsedBody);

    if (result?.skipped) {
      return res.status(200).json({ success: true, skipped: true, ...result });
    }

    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error('[handleAmazonNotification] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.provisionSqs = async (req, res) => {
  try {
    const result = await sqsSetupService.ensureConfigured();

    if (!result.configured) {
      return res.status(400).json({
        success: false,
        error: result.message || 'SQS queue could not be configured',
        code: 'SQS_NOT_CONFIGURED',
        hint: 'Set AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and ORDER_NOTIFICATIONS_AUTO_CREATE_SQS=true, or add AWS_SQS_QUEUE_ARN and AWS_SQS_QUEUE_URL manually.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'SQS queue is ready for Amazon ORDER_CHANGE notifications',
      sqs: {
        queueArn: result.queueArn,
        queueUrl: result.queueUrl,
        queueName: result.queueName,
        dlqArn: result.dlqArn,
        dlqUrl: result.dlqUrl,
        dlqName: result.dlqName,
        maxReceiveCount: result.maxReceiveCount,
        region: result.region,
        sellingRegion: result.sellingRegion,
        principalAccountId: result.principalAccountId,
      },
      envHint: {
        AWS_SQS_QUEUE_ARN: result.queueArn,
        AWS_SQS_QUEUE_URL: result.queueUrl,
        AWS_SQS_DLQ_ARN: result.dlqArn,
        AWS_SQS_DLQ_URL: result.dlqUrl,
        AWS_REGION: result.region,
      },
    });
  } catch (error) {
    console.error('[provisionSqs] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SQS_PROVISION_FAILED',
      hint: 'Verify AWS credentials and IAM permissions: sqs:CreateQueue, sqs:GetQueueUrl, sqs:SetQueueAttributes, sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes.',
    });
  }
};

exports.getFlowDiagnostics = async (req, res) => {
  try {
    const User = require('../models/User');
    const flow = require('../services/orderNotificationFlow');
    const user = await User.findById(req.user._id).select(
      'amazonSellerId orderNotificationsEnabled orderNotificationSubscriptionId'
    );

    res.status(200).json({
      success: true,
      pipeline: [
        '1. Amazon sends ORDER_CHANGE to your SQS queue',
        '2. SqsNotificationPoller receives and parses the message',
        '3. notificationService finds user by SellerId → syncs order via SP-API',
        '4. appNotificationService saves to MongoDB + emits appNotification socket',
        '5. NotificationBell shows item with Amazon badge',
      ],
      user: {
        amazonSellerId: user?.amazonSellerId || null,
        orderNotificationsEnabled: Boolean(user?.orderNotificationsEnabled),
        subscriptionId: user?.orderNotificationSubscriptionId || null,
        sellerIdMustMatch:
          'SellerId in SQS payload must match your amazonSellerId in the database',
      },
      diagnostics: flow.getFlowDiagnostics(),
    });
  } catch (error) {
    console.error('[getFlowDiagnostics] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/** Dev: run full ORDER_CHANGE pipeline without waiting for Amazon (bell + order sync). */
exports.simulateAmazonOrderChange = async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not available in production' });
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user?.amazonSellerId) {
      return res.status(400).json({
        success: false,
        error: 'Connect Amazon first so amazonSellerId is set',
      });
    }

    const flow = require('../services/orderNotificationFlow');
    const notificationService = require('../services/notificationService');
    const Order = require('../models/Order');

    const amazonOrderId =
      req.body?.amazonOrderId ||
      (await Order.findOne({ sellerId: user._id }).sort({ updatedAt: -1 }).select('amazonOrderId'))
        ?.amazonOrderId;

    if (!amazonOrderId) {
      return res.status(400).json({
        success: false,
        error: 'Provide amazonOrderId in body or sync at least one order first',
      });
    }

    const payload = flow.buildSampleOrderChangePayload({
      sellerId: user.amazonSellerId,
      amazonOrderId,
      orderStatus: req.body?.orderStatus || 'Unshipped',
    });

    const result = await notificationService.handleIncomingNotification(payload);

    res.status(200).json({
      success: true,
      message: 'Simulated ORDER_CHANGE processed — check bell icon',
      result,
      simulatedPayload: payload,
    });
  } catch (error) {
    console.error('[simulateAmazonOrderChange] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getSqsStatus = async (req, res) => {
  try {
    const status = await sqsSetupService.getStatusAsync();
    const poller = require('../services/sqsNotificationPoller');

    res.status(200).json({
      success: true,
      sqs: status,
      pollerRunning: poller.isEnabled(),
    });
  } catch (error) {
    console.error('[getSqsStatus] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.subscribeToNotifications = async (req, res) => {
  try {
    const sqsResult = await sqsSetupService.ensureConfigured();
    if (!sqsResult.configured) {
      return res.status(400).json({
        success: false,
        error: sqsResult.message || 'SQS is not configured',
        code: 'ORDER_NOTIFICATIONS_NOT_CONFIGURED',
        hint: 'POST /api/notifications/sqs/provision with AWS credentials, or set AWS_SQS_QUEUE_ARN and AWS_SQS_QUEUE_URL in .env and restart.',
      });
    }

    if (!process.env.AWS_SQS_QUEUE_URL || !process.env.AWS_SQS_QUEUE_ARN) {
      console.warn('[subscribeToNotifications] SQS URLs missing from .env — poller may stop after restart');
    }

    const user = await User.findById(req.user._id);

    if (!user?.amazonRefreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Amazon refresh token missing. Disconnect and reconnect Amazon on this page.',
        code: 'SP_NOT_CONNECTED',
      });
    }

    const subscription = await notificationService.subscribeToOrderNotifications(user);

    res.status(200).json({
      success: true,
      message: 'Successfully subscribed to ORDER_CHANGE notifications',
      subscription,
    });
  } catch (error) {
    console.error('[subscribeToNotifications] Error:', error);

    if (error.code === 'SP_NOT_CONNECTED' || error.code === 'SELLER_ID_MISSING') {
      return res.status(400).json({ success: false, error: error.message, code: error.code });
    }

    const notificationsApi = require('../utils/notificationsApi');
    if (notificationsApi.isSpApiConflict(error)) {
      try {
        const user = await User.findById(req.user._id);
        const subscription = await notificationService.subscribeToOrderNotifications(user);
        return res.status(200).json({
          success: true,
          message: 'ORDER_CHANGE subscription is already active (reused existing)',
          subscription,
        });
      } catch (retryErr) {
        console.error('[subscribeToNotifications] Conflict retry failed:', retryErr.message);
      }
    }

    if (
      error.message?.includes('AWS_SQS_QUEUE_ARN') ||
      error.message?.includes('NOTIFICATION_DESTINATION_ID')
    ) {
      return res.status(400).json({
        success: false,
        error: error.message,
        code: 'ORDER_NOTIFICATIONS_NOT_CONFIGURED',
        hint: 'Add AWS_SQS_QUEUE_ARN (and AWS_SQS_QUEUE_URL for polling) to auroraBackend/.env, then restart the server. This is only for Amazon ORDER_CHANGE live orders — the bell inbox still works for campaign sync.',
      });
    }

    res.status(500).json({ success: false, error: error.message });
  }
};

exports.unsubscribeFromNotifications = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    await notificationService.unsubscribeFromNotifications(user);

    res.status(200).json({
      success: true,
      message: 'Successfully unsubscribed from order notifications',
    });
  } catch (error) {
    console.error('[unsubscribeFromNotifications] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getSubscriptionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const status = await notificationService.getSubscriptionStatus(user);

    if (status.amazonSubscriptionActive && !user.orderNotificationsEnabled) {
      await User.findByIdAndUpdate(user._id, {
        orderNotificationsEnabled: true,
        orderNotificationSubscriptionId:
          status.amazonSubscriptionId || user.orderNotificationSubscriptionId,
      });
      status.subscribed = true;
      status.repairedDbFlag = true;
    }

    res.status(200).json({
      success: true,
      subscribed: status.subscribed,
      subscription: status,
    });
  } catch (error) {
    console.error('[getSubscriptionStatus] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.repairNotifications = async (req, res) => {
  try {
    const sqsResult = await sqsSetupService.ensureConfigured();
    if (!sqsResult.configured) {
      return res.status(400).json({
        success: false,
        error: 'SQS not configured',
        hint: 'Save AWS_SQS_QUEUE_ARN and AWS_SQS_QUEUE_URL to .env after Set up SQS queue',
        envHint: {
          AWS_SQS_QUEUE_ARN: sqsResult.queueArn,
          AWS_SQS_QUEUE_URL: sqsResult.queueUrl,
        },
      });
    }

    const user = await User.findById(req.user._id);
    const subscription = await notificationService.repairOrderNotificationSetup(user);

    res.status(200).json({
      success: true,
      message: 'Order notifications repaired and active',
      subscription,
      sqs: {
        queueUrl: process.env.AWS_SQS_QUEUE_URL,
        pollerEnabled: require('../services/sqsNotificationPoller').isEnabled(),
      },
      envReminder:
        'Add AWS_SQS_QUEUE_ARN and AWS_SQS_QUEUE_URL to auroraBackend/.env and restart so polling survives server restarts.',
    });
  } catch (error) {
    console.error('[repairNotifications] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/** Manual delta sync — recent orders only (not full history). */
exports.syncOrdersLive = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.amazonRefreshToken) {
      return res.status(400).json({ success: false, error: 'Amazon OAuth not connected' });
    }

    const { runOrderDeltaSyncForUser } = require('../services/orderDeltaSyncService');
    const result = await runOrderDeltaSyncForUser(user, { notifyMode: 'all' });

    res.status(200).json({
      success: true,
      message: `${result.syncedCount} recent order(s) synced`,
      ordersSync: result.syncedCount,
      orders: result.syncedOrders,
      lookbackMinutes: result.lookbackMinutes,
    });
  } catch (error) {
    console.error('[syncOrdersLive] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
