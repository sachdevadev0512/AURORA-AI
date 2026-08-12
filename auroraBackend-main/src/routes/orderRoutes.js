const express = require('express');
const {
  getOrders,
  getOrder,
  syncOrders,
  getOrderSyncStatus,
  stopOrderSync,
  getOrderStats,
  getDashboardOrders,
  getOrderAnalytics,
  bulkUpdateOrderStatus,
  bulkExportOrders,
  exportOrdersCsv,
  updateOrderStatus,
  addOrderNote,
} = require('../controllers/orderController');

const { protect } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.route('/')
  .get(protect, getOrders);

router.get('/sync/status', protect, getOrderSyncStatus);
router.post('/sync/stop', protect, syncLimiter, stopOrderSync);
router.post('/sync', protect, syncLimiter, syncOrders);
router.get('/stats/summary', protect, getOrderStats);
router.get('/dashboard', protect, getDashboardOrders);
router.get('/analytics', protect, getOrderAnalytics);
router.get('/export/csv', protect, exportOrdersCsv);

router.route('/:id')
  .get(protect, getOrder);

// Bulk operations
router.post('/bulk/status', protect, bulkUpdateOrderStatus);
router.post('/bulk/export', protect, bulkExportOrders);

// Order management
router.put('/:id/status', protect, updateOrderStatus);
router.post('/:id/notes', protect, addOrderNote);

module.exports = router;