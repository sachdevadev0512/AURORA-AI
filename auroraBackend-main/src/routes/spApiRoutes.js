const express = require('express');
const {
  getSellerPerformance,
  getFinancialEvents,
  getReports,
  createReport,
} = require('../controllers/spApiController');

const { protect } = require('../middleware/auth');

const router = express.Router();

// All SP-API routes require authentication and Amazon credentials
router.get('/performance', protect, getSellerPerformance);
router.get('/financial-events', protect, getFinancialEvents);
router.get('/reports', protect, getReports);
router.post('/reports', protect, createReport);

module.exports = router;