const User = require('../models/User');
const Ad = require('../models/Ad');
const { normalizeSellerId } = require('./adsProfileResolver');

function isAdsSellerAligned(user) {
  if (!user?.amazonSellerId || !user?.amazonAdsRefreshToken) {
    return { aligned: true, reason: 'not_fully_connected' };
  }

  const spSeller = normalizeSellerId(user.amazonSellerId);
  const adsAccount = normalizeSellerId(user.amazonAdsAccountId);

  if (!adsAccount) {
    return { aligned: false, reason: 'ads_account_unknown', spSeller, adsAccount: null };
  }

  if (adsAccount !== spSeller) {
    return { aligned: false, reason: 'ads_seller_mismatch', spSeller, adsAccount };
  }

  return { aligned: true, reason: 'ok', spSeller, adsAccount };
}

async function loadUserAdsContext(userId) {
  return User.findById(userId).select(
    'amazonSellerId amazonAdsRefreshToken amazonAdsAccountId amazonAdsProfileIds'
  );
}

function buildAdsReadQuery(user) {
  const query = { sellerId: user._id };
  const alignment = isAdsSellerAligned(user);

  if (user.amazonAdsRefreshToken && user.amazonSellerId && !alignment.aligned) {
    query._id = { $exists: false };
    return { query, alignment, blocked: true };
  }

  if (user.amazonAdsProfileIds?.length) {
    query.profileId = { $in: user.amazonAdsProfileIds.map(String) };
  }

  return { query, alignment, blocked: false };
}

async function purgeAdsIfMisaligned(userId) {
  const user = await loadUserAdsContext(userId);
  if (!user) return { purged: 0 };

  const alignment = isAdsSellerAligned(user);
  if (alignment.aligned) return { purged: 0, alignment };

  const result = await Ad.deleteMany({ sellerId: userId });
  return { purged: result.deletedCount || 0, alignment };
}

module.exports = {
  isAdsSellerAligned,
  loadUserAdsContext,
  buildAdsReadQuery,
  purgeAdsIfMisaligned,
};
