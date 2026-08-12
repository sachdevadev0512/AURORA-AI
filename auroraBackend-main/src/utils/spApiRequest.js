const Joi = require('joi');
const AmazonAPI = require('./amazonAPI');
const { getSellerAppCredentials } = require('./sellerAppHelper');

const CREDENTIALS_MISSING = {
  status: 400,
  body: { error: 'Amazon SP-API credentials not configured' },
};

function requireAmazonRefreshToken(user) {
  if (!user?.amazonRefreshToken) {
    return CREDENTIALS_MISSING;
  }
  return null;
}

function validateWithJoi(schema, value) {
  const { error, value: validated } = schema.validate(value);
  if (error) {
    return {
      error: {
        status: 400,
        body: { error: error.details[0].message },
      },
    };
  }
  return { value: validated };
}

async function createAmazonClientForUser(user) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  return new AmazonAPI(user, sellerAppCredentials);
}

function apiFailure(message, apiError) {
  return {
    status: 400,
    body: {
      error: message,
      details: process.env.NODE_ENV === 'development' ? apiError.message : undefined,
    },
  };
}

module.exports = {
  Joi,
  requireAmazonRefreshToken,
  validateWithJoi,
  createAmazonClientForUser,
  apiFailure,
};
