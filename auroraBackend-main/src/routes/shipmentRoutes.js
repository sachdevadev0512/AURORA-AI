const express = require('express');
const {
  getShipments,
  getDelayedShipmentsSummary,
  getShipment,
  refreshShipmentTrackingNow,
  syncShipments,
  getShipmentSyncStatus,
  stopShipmentSync,
  exportShipments,
} = require('../controllers/shipmentController');
const { protect } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/export', protect, exportShipments);
router.get('/delayed/summary', protect, getDelayedShipmentsSummary);
router.get('/sync/status', protect, getShipmentSyncStatus);
router.post('/sync/stop', protect, syncLimiter, stopShipmentSync);
router.post('/sync', protect, syncLimiter, syncShipments);

router.route('/').get(protect, getShipments);
router.post('/:id/track', protect, syncLimiter, refreshShipmentTrackingNow);
router.route('/:id').get(protect, getShipment);

module.exports = router;
