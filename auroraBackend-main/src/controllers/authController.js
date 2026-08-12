const jwt = require('jsonwebtoken');
const User = require('../models/User');
const SellerApplication = require('../models/SellerApplication');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const Joi = require('joi');
const { ensureAdsLiveSyncForUser } = require('../services/adsSyncService');
const { ensureProductFeeLiveSyncForUser } = require('../services/productFeeLiveSync');
const { ensureShipmentLiveTrackingForUser } = require('../services/shipmentLiveTracking');
const { loadUserSafe } = require('../utils/userLoader');
const { invalidateAuthUserCache } = require('../utils/authUserCache');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res, next) => {
  try {
    const schema = Joi.object({
      name: Joi.string().min(2).max(50).required(),
      email: Joi.string().email().required(),
      password: Joi.string().min(6).required(),
      sellerApplicationId: Joi.string().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { name, email, password, sellerApplicationId } = value;

    // Check if user exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Verify seller application exists if provided
    if (sellerApplicationId) {
      const sellerApp = await SellerApplication.findById(sellerApplicationId);
      if (!sellerApp || !sellerApp.isActive) {
        return res.status(400).json({ error: 'Invalid or inactive seller application' });
      }
    }

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      sellerApplicationId: sellerApplicationId || null,
    });

    if (user) {
      const safeUser = await loadUserSafe(user._id);
      const profile = safeUser?.toObject?.() || safeUser || {};

      res.status(201).json({
        ...profile,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ error: 'Invalid user data' });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res, next) => {
  try {
    const schema = Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().required(),
    });

    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password } = req.body;

    // Check for user email
    const user = await User.findOne({ email }).select('+password');

    if (user && (await user.comparePassword(password))) {
      if (process.env.ADS_LIVE_SYNC_ENABLED !== 'false') {
        await ensureAdsLiveSyncForUser(user._id);
      }
      if (process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false' && user.amazonRefreshToken) {
        await ensureProductFeeLiveSyncForUser(user._id);
      }
      if (process.env.SHIPMENT_LIVE_TRACKING_ENABLED !== 'false' && user.amazonRefreshToken) {
        await ensureShipmentLiveTrackingForUser(user._id);
      }

      const safeUser = await loadUserSafe(user._id);

      res.json({
        ...safeUser?.toObject?.() || safeUser,
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res, next) => {
  try {
    const user = await loadUserSafe(req.user._id);

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update Amazon credentials and validate SP-API access
// @route   PUT /api/auth/amazon-credentials
// @access  Private
const updateAmazonCredentials = async (req, res, next) => {
  try {
    const schema = Joi.object({
      amazonSellerId: Joi.string().required(),
      amazonRefreshToken: Joi.string().required(),
      marketplace: Joi.string().valid('NA', 'EU', 'FE').required(),
    });

    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { amazonSellerId, amazonRefreshToken, marketplace } = req.body;

    const { assertUniqueAmazonSellerId } = require('../utils/userLoader');
    await assertUniqueAmazonSellerId(amazonSellerId, req.user._id);

    let amazonMarketplaceIds = [];

    // Validate SP-API credentials by making a test call
    try {
      const sellerAppCredentials = await getSellerAppCredentials(req.user._id);
      const testAPI = new AmazonAPI({
        amazonRefreshToken,
        marketplace,
      }, sellerAppCredentials);

      // Test with a simple API call (get marketplace participations)
      const marketplaceResponse = await testAPI.callSpApi({
        operation: 'getMarketplaceParticipations',
        endpoint: 'sellers',
      });

      const participations = marketplaceResponse?.payload || marketplaceResponse || [];
      amazonMarketplaceIds = Array.isArray(participations)
        ? participations
          .map((participation) => participation?.marketplace?.id || participation?.Marketplace?.Id || participation?.marketplaceId)
          .filter(Boolean)
        : [];
      const { sortMarketplaceIds } = require('../utils/marketplacePriority');
      amazonMarketplaceIds = sortMarketplaceIds(amazonMarketplaceIds, marketplace || 'NA');

    } catch (apiError) {
      console.error('SP-API validation error:', apiError);
      if (apiError.code === 'AMAZON_SELLER_ALREADY_LINKED') {
        return res.status(400).json({ error: apiError.message, code: apiError.code });
      }
      return res.status(400).json({
        error: 'Invalid Amazon SP-API credentials. Please check your Seller ID and Refresh Token.',
        details: process.env.NODE_ENV === 'development' ? apiError.message : undefined,
      });
    }

    // Update user with validated credentials
    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        amazonSellerId,
        amazonRefreshToken,
        marketplace,
        amazonMarketplaceIds,
        isVerified: true,
      },
      { new: true, runValidators: true }
    );

    await invalidateAuthUserCache(req.user._id);

    if (process.env.ADS_LIVE_SYNC_ENABLED !== 'false') {
      await ensureAdsLiveSyncForUser(user._id);
    }
    if (process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false') {
      await ensureProductFeeLiveSyncForUser(user._id);
    }
    if (process.env.SHIPMENT_LIVE_TRACKING_ENABLED !== 'false') {
      await ensureShipmentLiveTrackingForUser(user._id);
    }

    res.status(200).json({
      success: true,
      message: 'Amazon SP-API credentials validated and saved successfully',
      data: {
        amazonSellerId: user.amazonSellerId,
        marketplace: user.marketplace,
        isVerified: user.isVerified,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Amazon seller information via SP-API
// @route   GET /api/auth/amazon-info
// @access  Private
const getAmazonInfo = async (req, res, next) => {
  try {
    if (!req.user.amazonRefreshToken) {
      return res.status(400).json({
        error: 'Amazon credentials not configured. Please set up your SP-API credentials first.',
      });
    }

    const sellerAppCredentials = await getSellerAppCredentials(req.user._id);
    const amazonAPI = new AmazonAPI(req.user, sellerAppCredentials);

    try {
      // Get marketplace participations
      const marketplaceResponse = await amazonAPI.callSpApi({
        operation: 'getMarketplaceParticipations',
        endpoint: 'sellers',
      });

      // Get account information
      const accountResponse = await amazonAPI.callSpApi({
        operation: 'getAccount',
        endpoint: 'sellers',
      });

      res.status(200).json({
        success: true,
        data: {
          sellerId: accountResponse?.payload?.sellerId,
          marketplaceParticipations: marketplaceResponse?.payload || [],
          accountInfo: accountResponse?.payload,
        },
      });
    } catch (apiError) {
      console.error('SP-API error fetching seller info:', apiError);
      return res.status(400).json({
        error: 'Failed to fetch Amazon seller information. Please verify your SP-API credentials.',
        details: process.env.NODE_ENV === 'development' ? apiError.message : undefined,
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Assign seller application to user (Admin)
// @route   PUT /api/auth/assign-seller-app
// @access  Private (Admin only)
const assignSellerApplication = async (req, res, next) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().required(),
      sellerApplicationId: Joi.string().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { userId, sellerApplicationId } = value;

    // Verify seller application exists and is active
    const sellerApp = await SellerApplication.findById(sellerApplicationId);
    if (!sellerApp || !sellerApp.isActive) {
      return res.status(400).json({ error: 'Invalid or inactive seller application' });
    }

    // Update user with seller application
    const user = await User.findByIdAndUpdate(
      userId,
      { sellerApplicationId },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await invalidateAuthUserCache(user._id);

    res.status(200).json({
      success: true,
      message: 'Seller application assigned to user successfully',
      data: {
        userId: user._id,
        sellerApplicationId: user.sellerApplicationId,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get available seller applications for current user/admin
// @route   GET /api/auth/available-seller-apps
// @access  Private
const getAvailableSellerApps = async (req, res, next) => {
  try {
    const apps = await SellerApplication.find({ isActive: true })
      .select('_id organizationName organizationDescription supportedRegions')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: apps,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  getMe,
  updateAmazonCredentials,
  getAmazonInfo,
  assignSellerApplication,
  getAvailableSellerApps,
};
