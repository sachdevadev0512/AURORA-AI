const SellingPartnerAPI = require('amazon-sp-api');
const { getEnvironmentCredentials } = require('./sellerAppHelper');

const GRANTLESS_SCOPE = 'sellingpartnerapi::notifications';

/** SP-API region: na | eu | fe (not AWS region codes). */
function normalizeSpApiRegion(value) {
  const raw = String(value || 'NA')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  if (raw === 'na' || raw === 'us-east-1' || raw === 'us-west-2') return 'na';
  if (raw === 'eu' || raw.startsWith('eu-')) return 'eu';
  if (raw === 'fe' || raw.startsWith('ap-')) return 'fe';
  return 'na';
}

function getRegion() {
  return normalizeSpApiRegion(
    process.env.AMAZON_SELLING_REGION || process.env.AMAZON_REGION || 'NA'
  );
}

function buildCredentials(credentials = null) {
  const creds = credentials || getEnvironmentCredentials();
  return {
    SELLING_PARTNER_APP_CLIENT_ID: creds.amazonLwaClientId,
    SELLING_PARTNER_APP_CLIENT_SECRET: creds.amazonLwaClientSecret,
  };
}

async function createGrantlessClient(credentials = null) {
  const client = new SellingPartnerAPI({
    region: getRegion(),
    credentials: buildCredentials(credentials),
    options: {
      auto_request_tokens: true,
      only_grantless_operations: true,
    },
  });

  await client.refreshAccessToken(GRANTLESS_SCOPE);
  return client;
}

async function createSellerClient(user, sellerAppCredentials = null) {
  const refreshToken = user?.amazonRefreshToken;
  if (!refreshToken) {
    throw new Error('Amazon refresh token is required for ORDER_CHANGE subscription');
  }

  return new SellingPartnerAPI({
    region: normalizeSpApiRegion(user.marketplace || process.env.AMAZON_SELLING_REGION || 'NA'),
    refresh_token: refreshToken,
    credentials: buildCredentials(sellerAppCredentials),
    options: { auto_request_tokens: true },
  });
}

module.exports = {
  GRANTLESS_SCOPE,
  createGrantlessClient,
  createSellerClient,
  getRegion,
  normalizeSpApiRegion,
};
