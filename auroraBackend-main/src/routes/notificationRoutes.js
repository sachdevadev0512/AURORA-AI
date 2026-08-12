const express = require('express');
const {
  subscribeToNotifications,
  unsubscribeFromNotifications,
  getSubscriptionStatus,
  syncOrdersLive,
  provisionSqs,
  getSqsStatus,
  getFlowDiagnostics,
  simulateAmazonOrderChange,
  repairNotifications,
} = require('../controllers/notificationsController');

const { protect } = require('../middleware/auth');

const router = express.Router();

// Subscribe to notifications
router.post('/subscribe', protect, subscribeToNotifications);

// Unsubscribe from notifications
router.post('/unsubscribe', protect, unsubscribeFromNotifications);

// Get subscription status
router.get('/status', protect, getSubscriptionStatus);
router.post('/repair', protect, repairNotifications);

// SQS infrastructure for ORDER_CHANGE (requires AWS credentials on server)
router.get('/sqs/status', protect, getSqsStatus);
router.post('/sqs/provision', protect, provisionSqs);

router.get('/flow', protect, getFlowDiagnostics);
router.post('/test/simulate-order-change', protect, simulateAmazonOrderChange);

// Manual sync trigger (fallback)
router.post('/sync', protect, syncOrdersLive);

module.exports = router;
