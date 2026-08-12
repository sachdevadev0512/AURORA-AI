const User = require('../models/User');
const SellerApplication = require('../models/SellerApplication');

/**
 * Get seller application credentials for a user
 * Returns seller app credentials if assigned, otherwise falls back to environment variables
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object>} Seller application credentials or environment defaults
 */
const getSellerAppCredentials = async (userId) => {
  try {
    const user = await User.findById(userId).select('sellerApplicationId');
    
    if (!user) {
      console.warn(`User not found: ${userId}`);
      return getEnvironmentCredentials();
    }

    if (user.sellerApplicationId) {
      const sellerApp = await SellerApplication.findById(user.sellerApplicationId);
      if (sellerApp && sellerApp.isActive) {
        return {
          amazonLwaClientId: sellerApp.amazonLwaClientId,
          amazonLwaClientSecret: sellerApp.amazonLwaClientSecret,
          amazonClientId: sellerApp.amazonClientId,
          amazonClientSecret: sellerApp.amazonClientSecret,
          amazonApplicationId: sellerApp.amazonApplicationId,
          redirectUri: sellerApp.redirectUri,
          sellerAppId: sellerApp._id,
          source: 'seller_app',
        };
      }
    }

    // Fallback to environment variables
    return getEnvironmentCredentials();
  } catch (error) {
    console.error('Error fetching seller app credentials:', error);
    // Fallback to environment variables on error
    return getEnvironmentCredentials();
  }
};

/**
 * Get environment variable credentials
 * @returns {Object} Environment credentials
 */
function getEnvironmentCredentials() {
  return {
    amazonLwaClientId: process.env.AMAZON_LWA_CLIENT_ID || process.env.AMAZON_CLIENT_ID,
    amazonLwaClientSecret: process.env.AMAZON_LWA_CLIENT_SECRET || process.env.AMAZON_CLIENT_SECRET,
    amazonClientId: process.env.AMAZON_CLIENT_ID,
    amazonClientSecret: process.env.AMAZON_CLIENT_SECRET,
    amazonApplicationId: process.env.AMAZON_APPLICATION_ID || process.env.AMAZON_CLIENT_ID,
    redirectUri: process.env.AMAZON_REDIRECT_URI,
    source: 'environment',
  };
}

/**
 * Get seller application for a user (with seller app details)
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object|null>} Seller application object or null
 */
const getSellerApplication = async (userId) => {
  try {
    const user = await User.findById(userId).select('sellerApplicationId');
    
    if (!user || !user.sellerApplicationId) {
      return null;
    }

    const sellerApp = await SellerApplication.findById(user.sellerApplicationId);
    return sellerApp && sellerApp.isActive ? sellerApp : null;
  } catch (error) {
    console.error('Error fetching seller application:', error);
    return null;
  }
};

/**
 * Get user with seller application populated
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object>} User with populated sellerApplicationId
 */
const getUserWithSellerApp = async (userId) => {
  try {
    return await User.findById(userId).populate('sellerApplicationId');
  } catch (error) {
    console.error('Error fetching user with seller app:', error);
    return await User.findById(userId);
  }
};

module.exports = {
  getSellerAppCredentials,
  getSellerApplication,
  getUserWithSellerApp,
  getEnvironmentCredentials,
};
