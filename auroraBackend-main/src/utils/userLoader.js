const User = require('../models/User');

const SAFE_USER_SELECT =
  '-password -amazonRefreshToken -amazonAdsRefreshToken -amazonOAuthState -amazonAdsOAuthState';

/**
 * Load full user document for Amazon API calls (includes refresh tokens).
 */
async function loadUserForAmazon(userId) {
  if (!userId) return null;
  return User.findById(userId);
}

/**
 * Load user for API responses (no secrets).
 */
async function loadUserSafe(userId) {
  if (!userId) return null;
  const user = await User.findById(userId);
  if (!user) return null;

  const obj = user.toObject();
  delete obj.password;
  delete obj.amazonRefreshToken;
  delete obj.amazonAdsRefreshToken;
  delete obj.amazonOAuthState;
  delete obj.amazonAdsOAuthState;

  const { normalizeSellerId } = require('./adsProfileResolver');
  const amazonAdsProfileMatch =
    user.amazonSellerId && user.amazonAdsAccountId
      ? normalizeSellerId(user.amazonAdsAccountId) === normalizeSellerId(user.amazonSellerId)
      : null;

  return {
    ...obj,
    hasAmazonSpConnected: Boolean(user.amazonRefreshToken),
    hasAmazonAdsConnected: Boolean(user.amazonAdsRefreshToken),
    adsLiveSyncEligible: Boolean(user.amazonRefreshToken && user.amazonAdsRefreshToken),
    amazonAdsProfileMatch,
  };
}

async function assertUniqueAmazonSellerId(amazonSellerId, excludeUserId) {
  if (!amazonSellerId) return;

  const existing = await User.findOne({
    amazonSellerId: String(amazonSellerId).trim(),
    _id: { $ne: excludeUserId },
  }).select('_id email');

  if (existing) {
    const error = new Error(
      'This Amazon Seller account is already linked to another Aurora user. Each login must use its own Seller Central authorization.'
    );
    error.code = 'AMAZON_SELLER_ALREADY_LINKED';
    throw error;
  }
}

module.exports = {
  loadUserForAmazon,
  loadUserSafe,
  assertUniqueAmazonSellerId,
  SAFE_USER_SELECT,
};
