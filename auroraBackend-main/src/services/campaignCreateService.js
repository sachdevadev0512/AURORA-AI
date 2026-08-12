const Joi = require('joi');
const Ad = require('../models/Ad');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { isAdsSellerAligned } = require('../utils/adsAccessGuard');
const adsCampaignApi = require('../utils/amazonAdsCampaignApi');

const keywordSchema = Joi.object({
  keywordText: Joi.string().trim().min(1).required(),
  matchType: Joi.string().valid('EXACT', 'PHRASE', 'BROAD').required(),
  bid: Joi.number().min(0.02).optional(),
  state: Joi.string().valid('Active', 'Paused', 'Archived').optional(),
});

const negativeKeywordSchema = Joi.object({
  keywordText: Joi.string().trim().min(1).required(),
  matchType: Joi.string().valid('NEGATIVE_EXACT', 'NEGATIVE_PHRASE').required(),
  state: Joi.string().valid('Active', 'Paused', 'Archived').optional(),
});

const productAdSchema = Joi.object({
  sku: Joi.string().trim().allow('', null),
  asin: Joi.string().trim().allow('', null),
  state: Joi.string().valid('Active', 'Paused', 'Archived').optional(),
}).or('sku', 'asin');

const adGroupSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
  defaultBid: Joi.number().min(0.02).required(),
  state: Joi.string().valid('Active', 'Paused', 'Archived').optional(),
  productAds: Joi.array().items(productAdSchema).default([]),
  keywords: Joi.array().items(keywordSchema).default([]),
  negativeKeywords: Joi.array().items(negativeKeywordSchema).default([]),
  bidOptimization: Joi.string().valid('clicks', 'conversions', 'reach').optional(),
  tactic: Joi.string().valid('T00020', 'T00030').optional(),
});

const campaignSchema = Joi.object({
  name: Joi.string().trim().min(1).max(128).required(),
  state: Joi.string().valid('Active', 'Paused', 'Archived').default('Active'),
  startDate: Joi.date().required(),
  endDate: Joi.date().allow(null).optional(),
  dailyBudget: Joi.number().min(1).required(),
  portfolioId: Joi.string().trim().allow('', null),
  targetingType: Joi.string().valid('AUTO', 'MANUAL').optional(),
  biddingStrategy: Joi.string()
    .valid('LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL')
    .optional(),
  placementBidding: Joi.array()
    .items(
      Joi.object({
        placement: Joi.string()
          .valid('PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH')
          .required(),
        percentage: Joi.number().min(0).max(900).required(),
      }),
    )
    .default([]),
  brandEntityId: Joi.string().trim().allow('', null),
  bidding: Joi.object().unknown(true).optional(),
  costType: Joi.string().valid('cpc', 'vcpm').optional(),
  tactic: Joi.string().valid('T00020', 'T00030').optional(),
});

const sbCreativeSchema = Joi.object({
  name: Joi.string().trim().allow('', null),
  brandName: Joi.string().trim().min(1).required(),
  headline: Joi.string().trim().min(1).max(50).required(),
  asins: Joi.array().items(Joi.string().trim().min(10).max(10)).min(1).max(3).required(),
  brandLogoAssetId: Joi.string().trim().allow('', null),
  landingPage: Joi.object().unknown(true).optional(),
  state: Joi.string().valid('Active', 'Paused', 'Archived').optional(),
});

const createCampaignSchema = Joi.object({
  profileId: Joi.string().trim().required(),
  campaignType: Joi.string()
    .valid('Sponsored Products', 'Sponsored Brands', 'Sponsored Display')
    .required(),
  campaign: campaignSchema.required(),
  adGroups: Joi.array().items(adGroupSchema).min(1).required(),
  sbCreative: sbCreativeSchema.when('campaignType', {
    is: 'Sponsored Brands',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
});

function assertAdsConnected(user) {
  if (!user.amazonRefreshToken) {
    const error = new Error('Connect Amazon Seller Central before creating campaigns.');
    error.code = 'SP_NOT_CONNECTED';
    throw error;
  }
  if (!user.amazonAdsRefreshToken) {
    const error = new Error('Connect Amazon Ads from Integration before creating campaigns.');
    error.code = 'ADS_NOT_CONNECTED';
    throw error;
  }
  const alignment = isAdsSellerAligned(user);
  if (user.amazonSellerId && user.amazonAdsAccountId && !alignment.aligned) {
    const error = new Error(
      `Amazon Ads account does not match Seller Central. Reconnect Amazon Ads with the correct account.`,
    );
    error.code = 'ADS_SELLER_MISMATCH';
    error.details = alignment;
    throw error;
  }
}

async function buildAmazonApi(user) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  return new AmazonAPI(user, sellerAppCredentials);
}

function mapProfile(profile) {
  return {
    profileId: String(profile.profileId),
    countryCode: profile.countryCode,
    currencyCode: profile.currencyCode,
    timezone: profile.timezone,
    accountInfo: profile.accountInfo || null,
    accountType: profile.accountInfo?.type || 'seller',
    marketplaceStringId: profile.accountInfo?.marketplaceStringId || null,
    name: profile.accountInfo?.name || null,
  };
}

async function getAdsProfiles(user) {
  assertAdsConnected(user);
  const amazonAPI = await buildAmazonApi(user);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const profiles = await amazonAPI.getAdvertisingProfiles(accessToken);
  const list = Array.isArray(profiles) ? profiles : [];
  return list.map(mapProfile);
}

async function getAdsPortfolios(user, profileId) {
  assertAdsConnected(user);
  if (!profileId) {
    const error = new Error('profileId is required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  const amazonAPI = await buildAmazonApi(user);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const portfolios = await adsCampaignApi.listPortfolios(amazonAPI, accessToken, profileId);
  return portfolios.map((portfolio) => ({
    portfolioId: String(portfolio.portfolioId),
    name: portfolio.name || `Portfolio ${portfolio.portfolioId}`,
    state: portfolio.state,
  }));
}

async function upsertLocalCampaign(user, profileId, campaignType, campaign, campaignId, profileMeta) {
  const doc = {
    sellerId: user._id,
    profileId: String(profileId),
    campaignId: String(campaignId),
    campaignName: campaign.name,
    status: campaign.state || 'Active',
    country: profileMeta?.countryCode || undefined,
    campaignType,
    portfolio: campaign.portfolioId || undefined,
    startDate: campaign.startDate,
    endDate: campaign.endDate || undefined,
    budget: {
      amount: campaign.dailyBudget,
      currencyCode: profileMeta?.currencyCode || 'USD',
    },
    lastSynced: new Date(),
  };

  return Ad.findOneAndUpdate(
    { sellerId: user._id, profileId: String(profileId), campaignId: String(campaignId) },
    doc,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function createSpCampaignFlow(amazonAPI, accessToken, profileId, payload, profileMeta) {
  const { campaign, adGroups } = payload;
  const accountType = profileMeta?.accountType || 'seller';
  let campaignId;

  try {
    campaignId = await adsCampaignApi.createSpCampaign(amazonAPI, accessToken, profileId, campaign);
    const createdGroups = await adsCampaignApi.createSpAdGroups(
      amazonAPI,
      accessToken,
      profileId,
      campaignId,
      adGroups,
    );

    const groupIdByName = new Map(createdGroups.map((group) => [group.name, group.adGroupId]));

    const productAds = [];
    const keywords = [];
    const negativeKeywords = [];

    adGroups.forEach((group) => {
      const adGroupId = groupIdByName.get(group.name);
      if (!adGroupId) return;

      (group.productAds || []).forEach((ad) => {
        productAds.push({ ...ad, adGroupId, campaignId });
      });
      (group.keywords || []).forEach((keyword) => {
        keywords.push({ ...keyword, adGroupId, campaignId });
      });
      (group.negativeKeywords || []).forEach((keyword) => {
        negativeKeywords.push({ ...keyword, adGroupId, campaignId });
      });
    });

    if (productAds.length === 0) {
      const error = new Error('Sponsored Products campaigns require at least one product ad.');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }

    await adsCampaignApi.createSpProductAds(
      amazonAPI,
      accessToken,
      profileId,
      campaignId,
      productAds,
      accountType,
    );

    if (campaign.targetingType !== 'AUTO') {
      if (keywords.length > 0) {
        await adsCampaignApi.createSpKeywords(amazonAPI, accessToken, profileId, campaignId, keywords);
      }
    }

    if (negativeKeywords.length > 0) {
      await adsCampaignApi.createSpNegativeKeywords(
        amazonAPI,
        accessToken,
        profileId,
        campaignId,
        negativeKeywords,
      );
    }

    return {
      campaignId,
      adGroups: createdGroups,
      productAdsCreated: productAds.length,
      keywordsCreated: campaign.targetingType === 'AUTO' ? 0 : keywords.length,
      negativeKeywordsCreated: negativeKeywords.length,
      profileMeta,
    };
  } catch (error) {
    if (campaignId) {
      try {
        await adsCampaignApi.deleteSpCampaign(amazonAPI, accessToken, profileId, campaignId);
        error.message = `${error.message} (partial campaign was rolled back on Amazon)`;
      } catch (rollbackError) {
        console.warn('[createSpCampaignFlow] Rollback failed:', rollbackError.message);
        error.message = `${error.message} (warning: a partial campaign may remain on Amazon — campaign ID ${campaignId})`;
      }
    }
    throw error;
  }
}

async function createSbCampaignFlow(amazonAPI, accessToken, profileId, payload, profileMeta) {
  const { campaign, adGroups, sbCreative } = payload;

  const campaignId = await adsCampaignApi.createSbCampaign(amazonAPI, accessToken, profileId, campaign);
  const adGroup = adGroups[0];
  const adGroupId = await adsCampaignApi.createSbAdGroup(amazonAPI, accessToken, profileId, campaignId, adGroup);

  await adsCampaignApi.createSbAds(amazonAPI, accessToken, profileId, {
    ...sbCreative,
    adGroupId,
  });

  return {
    campaignId,
    adGroupId,
    profileMeta,
  };
}

async function createSdCampaignFlow(amazonAPI, accessToken, profileId, payload, profileMeta) {
  const { campaign, adGroups } = payload;

  const campaignId = await adsCampaignApi.createSdCampaign(amazonAPI, accessToken, profileId, campaign);
  const createdGroups = [];

  for (const group of adGroups) {
    const adGroupId = await adsCampaignApi.createSdAdGroup(amazonAPI, accessToken, profileId, campaignId, {
      ...group,
      tactic: group.tactic || campaign.tactic || 'T00020',
    });
    createdGroups.push({ name: group.name, adGroupId });

    const productAds = (group.productAds || []).map((ad) => ({
      ...ad,
      adGroupId,
      campaignId,
    }));

    if (productAds.length > 0) {
      await adsCampaignApi.createSdProductAds(
        amazonAPI,
        accessToken,
        profileId,
        productAds,
        profileMeta?.accountType || 'seller',
      );
    }
  }

  const totalProductAds = adGroups.reduce((sum, group) => sum + (group.productAds?.length || 0), 0);
  if (totalProductAds === 0) {
    const error = new Error('Sponsored Display campaigns require at least one product ad.');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  return {
    campaignId,
    adGroups: createdGroups,
    productAdsCreated: totalProductAds,
    profileMeta,
  };
}

async function createAmazonCampaign(user, payload) {
  const { error, value } = createCampaignSchema.validate(payload, { abortEarly: false, stripUnknown: true });
  if (error) {
    const validationError = new Error(error.details.map((detail) => detail.message).join('; '));
    validationError.code = 'VALIDATION_ERROR';
    validationError.details = error.details;
    throw validationError;
  }

  assertAdsConnected(user);

  const amazonAPI = await buildAmazonApi(user);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const profiles = await amazonAPI.getAdvertisingProfiles(accessToken);
  const profileMeta = (Array.isArray(profiles) ? profiles : []).find(
    (profile) => String(profile.profileId) === String(value.profileId),
  );

  if (!profileMeta) {
    const profileError = new Error('Selected advertising profile was not found for this account.');
    profileError.code = 'PROFILE_NOT_FOUND';
    throw profileError;
  }

  let result;
  if (value.campaignType === 'Sponsored Products') {
    result = await createSpCampaignFlow(
      amazonAPI,
      accessToken,
      value.profileId,
      value,
      mapProfile(profileMeta),
    );
  } else if (value.campaignType === 'Sponsored Brands') {
    result = await createSbCampaignFlow(
      amazonAPI,
      accessToken,
      value.profileId,
      value,
      mapProfile(profileMeta),
    );
  } else {
    result = await createSdCampaignFlow(
      amazonAPI,
      accessToken,
      value.profileId,
      value,
      mapProfile(profileMeta),
    );
  }

  const localAd = await upsertLocalCampaign(
    user,
    value.profileId,
    value.campaignType,
    value.campaign,
    result.campaignId,
    result.profileMeta,
  );

  return {
    message: `${value.campaignType} campaign created on Amazon.`,
    campaignId: result.campaignId,
    ad: localAd,
    details: result,
  };
}

module.exports = {
  createAmazonCampaign,
  getAdsProfiles,
  getAdsPortfolios,
  createCampaignSchema,
};
