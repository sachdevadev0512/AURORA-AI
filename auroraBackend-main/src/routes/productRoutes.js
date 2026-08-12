const express = require('express');
const {
  getProducts,
  getProduct,
  exportProducts,
  syncProducts,
  getInventorySyncStatus,
  stopInventorySync,
  updateProduct,
  deleteProduct,
  reconcileListings,
} = require('../controllers/productController');
const {
  configureRepricer,
  bulkConfigure,
  bulkSetPrice,
  runRepricerForProduct,
  runRepricerForSeller,
  listRepricerLogs,
  listAllRepricerLogs,
  getDashboard,
} = require('../controllers/repricerController');

const { protect } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.route('/')
  .get(protect, getProducts);

router.post('/sync', protect, syncLimiter, syncProducts);
router.post('/reconcile-listings', protect, syncLimiter, reconcileListings);
router.get('/sync/status', protect, getInventorySyncStatus);
router.post('/sync/stop', protect, syncLimiter, stopInventorySync);
router.get('/export', protect, exportProducts);

router.post('/repricer/run-all', protect, syncLimiter, runRepricerForSeller);
router.post('/repricer/bulk', protect, syncLimiter, bulkConfigure);
router.post('/repricer/bulk-price', protect, syncLimiter, bulkSetPrice);
router.get('/repricer/logs', protect, listAllRepricerLogs);
router.get('/repricer/dashboard', protect, getDashboard);

router.put('/:id/repricer', protect, configureRepricer);
router.post('/:id/repricer/run', protect, syncLimiter, runRepricerForProduct);
router.get('/:id/repricer/logs', protect, listRepricerLogs);

router.route('/:id')
  .get(protect, getProduct)
  .put(protect, updateProduct)
  .delete(protect, deleteProduct);

module.exports = router;