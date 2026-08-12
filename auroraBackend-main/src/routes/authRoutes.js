const express = require('express');
const {
  register,
  login,
  getMe,
  updateAmazonCredentials,
  getAmazonInfo,
  assignSellerApplication,
  getAvailableSellerApps,
} = require('../controllers/authController');

const {
  getAmazonAuthorizationURL,
  getAmazonAdsAuthorizationURL,
  handleAmazonCallback,
  handleAmazonAdsCallback,
  disconnectAmazon,
  getConnectionStatus,
} = require('../controllers/amazonOAuthController');

const { protect, authorize } = require('../middleware/auth');
const {
  authLimiter,
  authLoginLimiter,
  oauthCallbackLimiter,
} = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', authLimiter, register);
router.post('/login', authLoginLimiter, login);
router.get('/me', protect, getMe);
router.put('/amazon-credentials', protect, updateAmazonCredentials);
router.get('/amazon-info', protect, getAmazonInfo);
router.get('/available-seller-apps', protect, getAvailableSellerApps);

// Admin-only routes
router.put('/assign-seller-app', protect, authorize('admin'), assignSellerApplication);

// Amazon OAuth routes
router.get('/amazon/authorize', protect, getAmazonAuthorizationURL);
router.get('/amazon/callback', oauthCallbackLimiter, handleAmazonCallback); // Public - no auth required
router.get('/amazon/ads-authorize', protect, getAmazonAdsAuthorizationURL);
router.get('/amazon/ads-callback', oauthCallbackLimiter, handleAmazonAdsCallback); // Public - no auth required
router.post('/amazon/disconnect', protect, disconnectAmazon);
router.get('/amazon/connection-status', protect, getConnectionStatus);

module.exports = router;
