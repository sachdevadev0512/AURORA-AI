const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const SellerApplication = require('../models/SellerApplication');
const AmazonAPI = require('../utils/amazonAPI');
const Joi = require('joi');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  filterProfilesForSeller,
  getProfileAccountId,
  summarizeProfiles,
  normalizeSellerId,
} = require('../utils/adsProfileResolver');
const { invalidateAuthUserCache } = require('../utils/authUserCache');

function buildIntegrationCapabilities(user) {
  const isConnected = !!(user.amazonRefreshToken && user.isVerified);
  const isAdsConnected = !!user.amazonAdsRefreshToken;

  return [
    {
      key: 'orders',
      title: 'Order Management',
      description: isConnected
        ? 'Order sync, dashboard views, exports, notes, and analytics are available.'
        : 'Connect Amazon to enable order sync, exports, and dashboard reporting.',
      enabled: isConnected,
      route: '/orders',
    },
    {
      key: 'inventory',
      title: 'Inventory Sync',
      description: isConnected
        ? 'Catalog and inventory sync can pull SKU, ASIN, FNSKU, and stock data.'
        : 'Connect Amazon to enable product catalog and inventory sync.',
      enabled: isConnected,
      route: '/products',
    },
    {
      key: 'analytics',
      title: 'Performance Analytics',
      description: isConnected
        ? 'Revenue, fee, and fulfillment analytics can be generated from synced orders.'
        : 'Connect Amazon to enable revenue, fee, and fulfillment analytics.',
      enabled: isConnected,
      route: '/dashboard',
    },
    {
      key: 'ads',
      title: 'Advertising Campaigns',
      description: isAdsConnected
        ? 'Campaign sync can pull Amazon Ads profiles and sponsored campaign data.'
        : 'Connect Amazon Ads separately to sync advertising campaigns.',
      enabled: isAdsConnected,
      route: '/ads',
    },
  ];
}

function getAmazonAdsOAuthConfig() {
  return {
    clientId: process.env.AMAZON_ADVERTISING_CLIENT_ID,
    clientSecret: process.env.AMAZON_ADVERTISING_CLIENT_SECRET,
    redirectUri: process.env.AMAZON_ADS_REDIRECT_URI,
    scope: process.env.AMAZON_ADS_SCOPE || 'advertising::campaign_management',
  };
}

// @desc    Get Amazon authorization URL for OAuth flow
// @route   GET /api/auth/amazon/authorize
// @access  Private
const getAmazonAuthorizationURL = async (req, res, next) => {
  try {
    // Fetch user with seller application
    const user = await User.findById(req.user._id).populate('sellerApplicationId');

    let sellerApp = null;
    let amazonApplicationId;
    let redirectUri;

    // Try to get seller app credentials
    if (user.sellerApplicationId) {
      sellerApp = user.sellerApplicationId;
      amazonApplicationId = sellerApp.amazonApplicationId;
      redirectUri = sellerApp.redirectUri;
    } else {
      // Fallback to environment variables for backward compatibility
      amazonApplicationId = process.env.AMAZON_APPLICATION_ID || process.env.AMAZON_CLIENT_ID;
      redirectUri = process.env.AMAZON_REDIRECT_URI;
    }

    if (!amazonApplicationId || !redirectUri) {
      throw new Error('Missing Amazon application configuration. Please assign a seller application or configure environment variables.');
    }

    // Generate a random state parameter for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');

    // Store state in user document temporarily
    await User.findByIdAndUpdate(req.user._id, { amazonOAuthState: state });

    // Amazon OAuth authorization URL parameters
    const params = new URLSearchParams({
      application_id: amazonApplicationId,
      version: 'beta',
      redirect_uri: redirectUri,
      state: state,
      'selling_partner_id': req.user.amazonSellerId || '',
    });

    const authorizationURL = `https://sellercentral.amazon.com/apps/authorize/consent?${params.toString()}`;

    res.status(200).json({
      success: true,
      authorizationURL,
      state,
      sellerApplicationName: sellerApp ? sellerApp.organizationName : 'Default Configuration',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Amazon Ads authorization URL
// @route   GET /api/auth/amazon/ads-authorize
// @access  Private
const getAmazonAdsAuthorizationURL = async (req, res, next) => {
  try {
    // Use LWA Client ID for Advertising API OAuth (not the Selling Partner app ID)
    const { clientId, redirectUri, scope } = getAmazonAdsOAuthConfig();

    if (!clientId || !redirectUri) {
      throw new Error('Missing Advertising API OAuth configuration. Please check AMAZON_ADVERTISING_CLIENT_ID/AMAZON_LWA_CLIENT_ID and AMAZON_ADS_REDIRECT_URI in .env');
    }

    const state = crypto.randomBytes(16).toString('hex');

    await User.findByIdAndUpdate(req.user._id, {
      amazonAdsOAuthState: state,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      scope,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: state,
    });

    const authorizationURL = `https://www.amazon.com/ap/oa?${params.toString()}`;

    res.status(200).json({
      success: true,
      authorizationURL,
      state,
    });
  } catch (error) {
    console.error('[getAmazonAdsAuthorizationURL] Error:', error.message);
    next(error);
  }
};

// @desc    Handle Amazon Ads OAuth callback
// @route   GET /api/auth/amazon/ads-callback
// @access  Public
const handleAmazonAdsCallback = async (req, res, next) => {
  try {
    const { code, state } = req.query;

    const user = await User.findOne({ amazonAdsOAuthState: state });

    if (!user) {
      console.error('[handleAmazonAdsCallback] User not found for state:', state);
      return res.redirect(`${process.env.FRONTEND_URL}/integration?error=Invalid state`);
    }

    const { clientId, clientSecret, redirectUri } = getAmazonAdsOAuthConfig();

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Missing Advertising API OAuth configuration. Please check Amazon Ads client ID, client secret, and redirect URI.');
    }

    const response = await axios.post(
      'https://api.amazon.com/auth/o2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const previewUser = {
      ...user.toObject(),
      amazonAdsRefreshToken: response.data.refresh_token,
    };
    const sellerAppCredentials = await getSellerAppCredentials(user._id);
    const amazonAPI = new AmazonAPI(previewUser, sellerAppCredentials);
    const accessToken = await amazonAPI.getAdvertisingAccessToken();
    const profilesResponse = await amazonAPI.getAdvertisingProfiles(accessToken);
    const allProfiles = amazonAPI.normalizeAdsApiList(profilesResponse, 'profiles');
    const matchedProfiles = filterProfilesForSeller(allProfiles, user.amazonSellerId);

    if (user.amazonSellerId && matchedProfiles.length === 0) {
      const foundAccountId = getProfileAccountId(allProfiles[0]) || 'unknown';
      console.warn('[handleAmazonAdsCallback] Ads seller mismatch:', {
        userId: user._id,
        expectedSellerId: user.amazonSellerId,
        adsAccountId: foundAccountId,
        profiles: summarizeProfiles(allProfiles),
      });
      return res.redirect(
        `${process.env.FRONTEND_URL}/integration?error=ads_seller_mismatch&expected=${encodeURIComponent(user.amazonSellerId)}&found=${encodeURIComponent(foundAccountId)}`
      );
    }

    const profileIds = matchedProfiles.map((p) => String(p.profileId));
    const adsAccountId = getProfileAccountId(matchedProfiles[0]) || getProfileAccountId(allProfiles[0]);

    // Update user with ads refresh token
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        amazonAdsRefreshToken: response.data.refresh_token,
        amazonAdsOAuthState: null,
        amazonAdsProfileIds: profileIds,
        amazonAdsAccountId: adsAccountId || null,
      },
      { new: true }
    );

    await invalidateAuthUserCache(user._id);

    if (process.env.ADS_LIVE_SYNC_ENABLED !== 'false') {
      try {
        const { ensureAdsLiveSyncForUser } = require('../services/adsSyncService');
        await ensureAdsLiveSyncForUser(updatedUser._id);
      } catch (registerError) {
        console.error('[handleAmazonAdsCallback] Failed to register live sync:', registerError.message);
      }
    }

    res.redirect(`${process.env.FRONTEND_URL}/integration?ads_connected=true`);
  } catch (error) {
    console.error('[handleAmazonAdsCallback] Error:', {
      status: error.response?.status,
      errorData: error.response?.data,
      message: error.message,
    });
    res.redirect(`${process.env.FRONTEND_URL}/integration?error=ads_auth_failed`);
  }
};

// @desc    Handle Amazon OAuth callback and exchange code for tokens
// @route   GET /api/auth/amazon/callback
// @access  Public (no auth required for callback)
const handleAmazonCallback = async (req, res, next) => {
  try {
    const { spapi_oauth_code, state, error, error_description, selling_partner_id } = req.query;
    const code = spapi_oauth_code;

    // Handle OAuth errors from Amazon
    if (error) {
      console.error('Amazon OAuth error:', error, error_description);
      return res.redirect(`${process.env.FRONTEND_URL}/integration?error=${encodeURIComponent(error_description || error)}`);
    }

    // Validate required parameters
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/integration?error=Missing authorization code or state`);
    }

    // Find user by state parameter (CSRF protection)
    const user = await User.findOne({ amazonOAuthState: state }).populate('sellerApplicationId');
    if (!user) {
      return res.redirect(`${process.env.FRONTEND_URL}/integration?error=Invalid state parameter`);
    }

    try {
      // Get seller app or use environment variables
      let sellerApp = null;
      if (user.sellerApplicationId) {
        sellerApp = user.sellerApplicationId;
      }

      // Exchange authorization code for tokens using seller-specific credentials
      const tokenResponse = await exchangeCodeForTokens(code, sellerApp);
      const marketplaceContext = await discoverMarketplaceContext(
        tokenResponse.refresh_token,
        sellerApp,
        user.marketplace || 'NA'
      );

      const newSellerId =
        selling_partner_id || tokenResponse.selling_partner_id || user.amazonSellerId;

      const { assertUniqueAmazonSellerId } = require('../utils/userLoader');
      await assertUniqueAmazonSellerId(newSellerId, user._id);

      await User.findByIdAndUpdate(user._id, {
        amazonRefreshToken: tokenResponse.refresh_token,
        amazonSellerId: newSellerId,
        marketplace: marketplaceContext.region || user.marketplace || 'NA',
        amazonMarketplaceIds: marketplaceContext.marketplaceIds,
        isVerified: true,
        amazonOAuthState: null,
        amazonTokenExpiresAt: new Date(Date.now() + (tokenResponse.expires_in * 1000)),
      });

      await invalidateAuthUserCache(user._id);

      if (process.env.ADS_LIVE_SYNC_ENABLED !== 'false') {
        try {
          const { ensureAdsLiveSyncForUser } = require('../services/adsSyncService');
          const updatedForAds = await User.findById(user._id);
          await ensureAdsLiveSyncForUser(updatedForAds._id);
        } catch (adsRegisterErr) {
          console.warn('[handleAmazonCallback] Ads live sync register:', adsRegisterErr.message);
        }
      }

      if (process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false') {
        try {
          const { ensureProductFeeLiveSyncForUser } = require('../services/productFeeLiveSync');
          await ensureProductFeeLiveSyncForUser(user._id);
        } catch (feeSyncErr) {
          console.warn('[handleAmazonCallback] Product fee live sync register:', feeSyncErr.message);
        }
      }

      // Update seller app lastUsedAt timestamp
      if (sellerApp && sellerApp._id) {
        await SellerApplication.findByIdAndUpdate(sellerApp._id, {
          lastUsedAt: new Date(),
        });
      }

      if (process.env.ORDER_NOTIFICATIONS_ENABLED !== 'false') {
        try {
          const sqsSetupService = require('../services/sqsSetupService');
          const sqsResult = await sqsSetupService.ensureConfigured();
          if (!sqsResult.configured) {
            console.warn(
              '[handleAmazonCallback] Skipping ORDER_CHANGE subscribe — SQS not configured:',
              sqsResult.message
            );
          } else {
            const updatedUser = await User.findById(user._id);
            const notificationService = require('../services/notificationService');
            await notificationService.subscribeToOrderNotifications(updatedUser);
          }
        } catch (subscribeError) {
          console.error('[handleAmazonCallback] Order notification subscribe failed:', subscribeError.message);
        }
      }

      // Redirect to frontend with success
      res.redirect(`${process.env.FRONTEND_URL}/integration?success=true`);

    } catch (tokenError) {
      console.error('Token exchange error:', tokenError.message);
      if (tokenError.code === 'AMAZON_SELLER_ALREADY_LINKED') {
        return res.redirect(
          `${process.env.FRONTEND_URL}/integration?error=${encodeURIComponent(tokenError.message)}`
        );
      }
      res.redirect(`${process.env.FRONTEND_URL}/integration?error=Failed to exchange authorization code`);
    }

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/integration?error=Internal server error`);
  }
};

// @desc    Disconnect Amazon account
// @route   POST /api/auth/amazon/disconnect
// @access  Private
const disconnectAmazon = async (req, res, next) => {
  try {
    try {
      const notificationService = require('../services/notificationService');
      const userBeforeDisconnect = await User.findById(req.user._id);
      if (userBeforeDisconnect?.orderNotificationsEnabled) {
        await notificationService.unsubscribeFromNotifications(userBeforeDisconnect);
      }
    } catch (unsubscribeError) {
      console.error('[disconnectAmazon] Failed to unsubscribe order notifications:', unsubscribeError.message);
    }

    // Clear Amazon credentials from user
    await User.findByIdAndUpdate(req.user._id, {
      amazonRefreshToken: null,
      amazonAdsRefreshToken: null,
      amazonSellerId: null,
      marketplace: null,
      amazonMarketplaceIds: [],
      isVerified: false,
      amazonOAuthState: null,
      amazonAdsOAuthState: null,
      amazonTokenExpiresAt: null,
      amazonAdsTokenExpiresAt: null,
      lastAdsSyncedAt: null,
      amazonAdsProfileIds: [],
      amazonAdsAccountId: null,
      orderNotificationSubscriptionId: null,
      orderNotificationsEnabled: false,
      orderNotificationsSubscribedAt: null,
    });

    await invalidateAuthUserCache(req.user._id);

    try {
      const { adsLiveSyncScheduler } = require('../services/adsSyncService');
      adsLiveSyncScheduler.unregisterUser(req.user._id);
    } catch (unregisterError) {
      console.error('[disconnectAmazon] Failed to unregister ads live sync:', unregisterError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Amazon account disconnected successfully',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Amazon connection status
// @route   GET /api/auth/amazon/connection-status
// @access  Private
const getConnectionStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select(
      'amazonRefreshToken amazonAdsRefreshToken amazonSellerId amazonAdsAccountId amazonAdsProfileIds marketplace amazonMarketplaceIds isVerified orderNotificationsEnabled orderNotificationSubscriptionId orderNotificationsSubscribedAt'
    );

    const isConnected = !!(user.amazonRefreshToken && user.isVerified);
    const capabilities = buildIntegrationCapabilities(user);
    const amazonAdsProfileMatch =
      user.amazonSellerId && user.amazonAdsAccountId
        ? normalizeSellerId(user.amazonAdsAccountId) === normalizeSellerId(user.amazonSellerId)
        : null;

    res.status(200).json({
      success: true,
      isConnected,
      amazonSellerId: user.amazonSellerId,
      marketplace: user.marketplace,
      amazonMarketplaceIds: user.amazonMarketplaceIds || [],
      isVerified: user.isVerified,
      isAdsConnected: !!user.amazonAdsRefreshToken,
      amazonAdsAccountId: user.amazonAdsAccountId || null,
      amazonAdsProfileIds: user.amazonAdsProfileIds || [],
      amazonAdsProfileMatch,
      orderNotificationsEnabled: !!user.orderNotificationsEnabled,
      orderNotificationsSubscribedAt: user.orderNotificationsSubscribedAt || null,
      capabilities,
    });
  } catch (error) {
    next(error);
  }
};

const discoverMarketplaceContext = async (refreshToken, sellerApp = null, preferredRegion = 'NA') => {
  const regions = [
    preferredRegion,
    ...(sellerApp?.supportedRegions || []),
    'NA',
    'EU',
    'FE',
  ].filter(Boolean);
  const uniqueRegions = [...new Set(regions)];

  for (const region of uniqueRegions) {
    try {
      const amazonAPI = new AmazonAPI(
        { amazonRefreshToken: refreshToken, marketplace: region },
        sellerApp
      );

      const response = await amazonAPI.callSpApi({
        operation: 'getMarketplaceParticipations',
        endpoint: 'sellers',
      });

      const participations = response?.payload || response?.marketplaceParticipations || response || [];
      const marketplaceIds = Array.isArray(participations)
        ? participations
          .map((participation) => (
            participation?.marketplace?.id ||
            participation?.Marketplace?.Id ||
            participation?.marketplaceId
          ))
          .filter(Boolean)
        : [];

      if (marketplaceIds.length > 0) {
        const { sortMarketplaceIds } = require('../utils/marketplacePriority');
        return { region, marketplaceIds: sortMarketplaceIds(marketplaceIds, region) };
      }
    } catch (error) {
      console.warn('[discoverMarketplaceContext] Failed marketplace discovery for region:', {
        region,
        message: error.message,
      });
    }
  }

  return { region: preferredRegion || 'NA', marketplaceIds: [] };
};

// Helper function to exchange authorization code for tokens
const exchangeCodeForTokens = async (authorizationCode, sellerApp = null) => {
  try {
    let lwaClientId;
    let lwaClientSecret;
    let redirectUri;

    if (sellerApp) {
      // Use seller app credentials (already decrypted by Mongoose post hook)
      lwaClientId = sellerApp.amazonLwaClientId;
      lwaClientSecret = sellerApp.amazonLwaClientSecret;
      redirectUri = sellerApp.redirectUri;
    } else {
      // Fallback to environment variables for backward compatibility
      lwaClientId = process.env.AMAZON_LWA_CLIENT_ID || process.env.AMAZON_CLIENT_ID;
      lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET || process.env.AMAZON_CLIENT_SECRET;
      redirectUri = process.env.AMAZON_REDIRECT_URI;
    }

    if (!lwaClientId || !lwaClientSecret || !redirectUri) {
      throw new Error('Missing Amazon OAuth credentials');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
      redirect_uri: redirectUri,
    });

    const response = await axios.post('https://api.amazon.com/auth/o2/token', body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });

    return response.data; // Contains refresh_token, access_token, expires_in, etc.
  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
    throw new Error('Failed to exchange authorization code for tokens');
  }
};

module.exports = {
  getAmazonAuthorizationURL,
  getAmazonAdsAuthorizationURL,
  handleAmazonCallback,
  handleAmazonAdsCallback,
  disconnectAmazon,
  getConnectionStatus,
};
