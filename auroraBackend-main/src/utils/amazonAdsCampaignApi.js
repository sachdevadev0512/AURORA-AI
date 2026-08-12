const axios = require('axios');

function buildAdsHeaders(amazonAPI, accessToken, profileId, contentType, accept) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': amazonAPI.getAdvertisingClientId(),
    'Amazon-Advertising-API-Scope': String(profileId),
    'Content-Type': contentType,
    Accept: accept || contentType,
  };
}

function parseAdsDateParts(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return { y: isoMatch[1], m: isoMatch[2], d: isoMatch[3] };
    }
    const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compactMatch) {
      return { y: compactMatch[1], m: compactMatch[2], d: compactMatch[3] };
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    y: String(date.getFullYear()),
    m: String(date.getMonth() + 1).padStart(2, '0'),
    d: String(date.getDate()).padStart(2, '0'),
  };
}

/** SP/SB v3/v4 APIs expect YYYY-MM-DD */
function formatAdsDateIso(value) {
  const parts = parseAdsDateParts(value);
  if (!parts) return null;
  return `${parts.y}-${parts.m}-${parts.d}`;
}

/** SD API expects YYYYMMDD */
function formatAdsDateCompact(value) {
  const parts = parseAdsDateParts(value);
  if (!parts) return null;
  return `${parts.y}${parts.m}${parts.d}`;
}

function throwAdsAxiosError(err, label) {
  if (!err?.response?.data) throw err;
  const data = err.response.data;
  const apiMessage = data.message || data.details || JSON.stringify(data);
  const error = new Error(`${label}: ${apiMessage}`);
  error.code = 'ADS_CREATE_FAILED';
  error.amazonStatus = err.response.status;
  error.details = data;
  throw error;
}

async function adsPost(url, body, headers, label = 'Amazon Ads API request') {
  try {
    return await axios.post(url, body, { headers });
  } catch (err) {
    throwAdsAxiosError(err, label);
  }
}

function mapAuroraState(state) {
  const normalized = String(state || 'Active').toLowerCase();
  if (normalized === 'paused') return 'PAUSED';
  if (normalized === 'archived') return 'ARCHIVED';
  return 'ENABLED';
}

function mapSdState(state) {
  const normalized = String(state || 'Active').toLowerCase();
  if (normalized === 'paused') return 'paused';
  if (normalized === 'archived') return 'archived';
  return 'enabled';
}

function extractAmazonResults(payload, entityKey) {
  const block = payload?.[entityKey] || payload;
  if (Array.isArray(block)) {
    return { success: block, errors: [] };
  }

  const success = block?.success || [];
  const errors = block?.error || block?.errors || [];
  return { success, errors };
}

function extractErrorMessage(item) {
  if (item == null) return null;
  if (typeof item === 'string') return item;

  if (typeof item.message === 'string' && item.message) {
    return item.reason ? `${item.reason}: ${item.message}` : item.message;
  }
  if (typeof item.reason === 'string' && item.reason) return item.reason;
  if (typeof item.details === 'string' && item.details) return item.details;

  if (item.errorValue && typeof item.errorValue === 'object') {
    const nested = extractErrorMessage(item.errorValue);
    if (nested) return nested;
    const nestedMessages = Object.values(item.errorValue)
      .map((value) => extractErrorMessage(value))
      .filter(Boolean);
    if (nestedMessages.length) return nestedMessages.join('; ');
  }

  if (typeof item === 'object') {
    const nested = Object.values(item)
      .map((value) => extractErrorMessage(value))
      .filter(Boolean);
    if (nested.length) return nested.join('; ');
  }

  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function formatAmazonErrors(errors = []) {
  return errors.map((entry) => {
    const details = entry.errors || entry.error || [entry];
    const messages = details.map((item) => extractErrorMessage(item)).filter(Boolean);
    return {
      index: entry.index,
      messages: messages.length ? messages : ['Unknown Amazon Ads error'],
    };
  });
}

function assertNoAmazonErrors(errors, label) {
  if (!errors?.length) return;
  const formatted = formatAmazonErrors(errors);
  const error = new Error(`${label} failed: ${formatted.map((e) => e.messages.join('; ')).join(' | ')}`);
  error.code = 'ADS_CREATE_FAILED';
  error.details = formatted;
  throw error;
}

function buildSpProductAdPayload(ad, campaignId, accountType) {
  const payload = {
    campaignId: String(campaignId),
    adGroupId: String(ad.adGroupId),
    state: mapAuroraState(ad.state || 'Active'),
  };

  const sku = String(ad.sku || '').trim();
  const asin = String(ad.asin || '').trim();
  const isVendor = String(accountType || '').toLowerCase() === 'vendor';

  // Amazon rejects seller accounts when both SKU and ASIN are sent together.
  if (isVendor) {
    if (asin) payload.asin = asin;
    else if (sku) payload.sku = sku;
  } else if (sku) {
    payload.sku = sku;
  } else if (asin) {
    payload.asin = asin;
  }

  return payload;
}

async function deleteSpCampaign(amazonAPI, accessToken, profileId, campaignId) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spCampaign.v3+json',
    'application/vnd.spCampaign.v3+json',
  );

  await adsPost(
    `${baseUrl}/sp/campaigns/delete`,
    { campaignIdFilter: { include: [String(campaignId)] } },
    headers,
    'Delete Sponsored Products campaign',
  );
}

async function createSpCampaign(amazonAPI, accessToken, profileId, campaign) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spCampaign.v3+json',
    'application/vnd.spCampaign.v3+json',
  );

  const body = {
    campaigns: [
      {
        name: campaign.name,
        targetingType: campaign.targetingType || 'MANUAL',
        state: mapAuroraState(campaign.state),
        startDate: formatAdsDateIso(campaign.startDate),
        endDate: formatAdsDateIso(campaign.endDate) || undefined,
        budget: {
          budgetType: 'DAILY',
          budget: Number(campaign.dailyBudget),
        },
        dynamicBidding: {
          strategy: campaign.biddingStrategy || 'LEGACY_FOR_SALES',
          ...(campaign.placementBidding?.length
            ? {
                placementBidding: campaign.placementBidding.map((row) => ({
                  placement: row.placement,
                  percentage: Number(row.percentage),
                })),
              }
            : {}),
        },
        portfolioId: campaign.portfolioId || undefined,
      },
    ],
  };

  const response = await adsPost(`${baseUrl}/sp/campaigns`, body, headers, 'Sponsored Products campaign');
  const { success, errors } = extractAmazonResults(response.data, 'campaigns');
  assertNoAmazonErrors(errors, 'Sponsored Products campaign');
  const campaignId = success[0]?.campaignId;
  if (!campaignId) {
    throw new Error('Amazon did not return a campaign ID for Sponsored Products');
  }
  return String(campaignId);
}

async function createSpAdGroups(amazonAPI, accessToken, profileId, campaignId, adGroups) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spAdGroup.v3+json',
    'application/vnd.spAdGroup.v3+json',
  );

  const body = {
    adGroups: adGroups.map((group) => ({
      campaignId,
      name: group.name,
      defaultBid: Number(group.defaultBid),
      state: mapAuroraState(group.state || 'Active'),
    })),
  };

  const response = await adsPost(`${baseUrl}/sp/adGroups`, body, headers, 'Sponsored Products ad group');
  const { success, errors } = extractAmazonResults(response.data, 'adGroups');
  assertNoAmazonErrors(errors, 'Sponsored Products ad group');
  return success.map((row, index) => ({
    adGroupId: String(row.adGroupId),
    name: adGroups[index]?.name,
  }));
}

async function createSpProductAds(amazonAPI, accessToken, profileId, campaignId, productAds, accountType) {
  if (!productAds?.length) return [];

  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spProductAd.v3+json',
    'application/vnd.spProductAd.v3+json',
  );

  const body = {
    productAds: productAds.map((ad) => buildSpProductAdPayload(ad, campaignId, accountType)),
  };

  const response = await adsPost(`${baseUrl}/sp/productAds`, body, headers, 'Sponsored Products product ad');
  const { errors } = extractAmazonResults(response.data, 'productAds');
  assertNoAmazonErrors(errors, 'Sponsored Products product ad');
  return response.data;
}

async function createSpKeywords(amazonAPI, accessToken, profileId, campaignId, keywords) {
  if (!keywords?.length) return [];

  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spKeyword.v3+json',
    'application/vnd.spKeyword.v3+json',
  );

  const body = {
    keywords: keywords.map((keyword) => ({
      campaignId,
      adGroupId: keyword.adGroupId,
      keywordText: keyword.keywordText,
      matchType: keyword.matchType,
      bid: keyword.bid != null ? Number(keyword.bid) : undefined,
      state: mapAuroraState(keyword.state || 'Active'),
    })),
  };

  const response = await adsPost(`${baseUrl}/sp/keywords`, body, headers, 'Sponsored Products keyword');
  const { errors } = extractAmazonResults(response.data, 'keywords');
  assertNoAmazonErrors(errors, 'Sponsored Products keyword');
  return response.data;
}

async function createSpNegativeKeywords(amazonAPI, accessToken, profileId, campaignId, keywords) {
  if (!keywords?.length) return [];

  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spNegativeKeyword.v3+json',
    'application/vnd.spNegativeKeyword.v3+json',
  );

  const body = {
    negativeKeywords: keywords.map((keyword) => ({
      campaignId,
      adGroupId: keyword.adGroupId,
      keywordText: keyword.keywordText,
      matchType: keyword.matchType,
      state: mapAuroraState(keyword.state || 'Active'),
    })),
  };

  const response = await adsPost(
    `${baseUrl}/sp/negativeKeywords`,
    body,
    headers,
    'Sponsored Products negative keyword',
  );
  const { errors } = extractAmazonResults(response.data, 'negativeKeywords');
  assertNoAmazonErrors(errors, 'Sponsored Products negative keyword');
  return response.data;
}

async function createSbCampaign(amazonAPI, accessToken, profileId, campaign) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.sbcampaign.v4+json',
    'application/vnd.sbcampaign.v4+json',
  );

  const body = {
    campaigns: [
      {
        name: campaign.name,
        state: mapAuroraState(campaign.state),
        startDate: formatAdsDateIso(campaign.startDate),
        endDate: formatAdsDateIso(campaign.endDate) || undefined,
        budget: {
          budgetType: 'DAILY',
          budget: Number(campaign.dailyBudget),
        },
        brandEntityId: campaign.brandEntityId || undefined,
        portfolioId: campaign.portfolioId || undefined,
        bidding: campaign.bidding || undefined,
      },
    ],
  };

  const response = await adsPost(`${baseUrl}/sb/v4/campaigns`, body, headers, 'Sponsored Brands campaign');
  const { success, errors } = extractAmazonResults(response.data, 'campaigns');
  assertNoAmazonErrors(errors, 'Sponsored Brands campaign');
  const campaignId = success[0]?.campaignId;
  if (!campaignId) {
    throw new Error('Amazon did not return a campaign ID for Sponsored Brands');
  }
  return String(campaignId);
}

async function createSbAdGroup(amazonAPI, accessToken, profileId, campaignId, adGroup) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.sbadgroup.v4+json',
    'application/vnd.sbadgroup.v4+json',
  );

  const body = {
    adGroups: [
      {
        campaignId,
        name: adGroup.name,
        state: mapAuroraState(adGroup.state || 'Active'),
      },
    ],
  };

  const response = await adsPost(`${baseUrl}/sb/v4/adGroups`, body, headers, 'Sponsored Brands ad group');
  const { success, errors } = extractAmazonResults(response.data, 'adGroups');
  assertNoAmazonErrors(errors, 'Sponsored Brands ad group');
  return String(success[0]?.adGroupId);
}

async function createSbAds(amazonAPI, accessToken, profileId, creative) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.sbadresource.v4+json',
    'application/vnd.sbadresource.v4+json',
  );

  const body = {
    ads: [
      {
        adGroupId: creative.adGroupId,
        name: creative.name || 'Aurora SB Ad',
        state: mapAuroraState(creative.state || 'Active'),
        creative: {
          brandLogoAssetID: creative.brandLogoAssetId || undefined,
          brandName: creative.brandName,
          headline: creative.headline,
          asins: creative.asins,
          landingPage: creative.landingPage || undefined,
        },
      },
    ],
  };

  const response = await adsPost(`${baseUrl}/sb/v4/ads`, body, headers, 'Sponsored Brands ad');
  const { errors } = extractAmazonResults(response.data, 'ads');
  assertNoAmazonErrors(errors, 'Sponsored Brands ad');
  return response.data;
}

async function createSdCampaign(amazonAPI, accessToken, profileId, campaign) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(amazonAPI, accessToken, profileId, 'application/json', 'application/json');

  const body = [
    {
      name: campaign.name,
      budgetType: 'daily',
      budget: Number(campaign.dailyBudget),
      startDate: formatAdsDateCompact(campaign.startDate),
      endDate: formatAdsDateCompact(campaign.endDate) || undefined,
      costType: campaign.costType || 'cpc',
      state: mapSdState(campaign.state),
      tactic: campaign.tactic || 'T00020',
      portfolioId: campaign.portfolioId ? Number(campaign.portfolioId) : undefined,
    },
  ];

  const response = await adsPost(`${baseUrl}/sd/campaigns`, body, headers, 'Sponsored Display campaign');
  const created = Array.isArray(response.data) ? response.data : [response.data];
  const campaignId = created[0]?.campaignId;
  if (!campaignId) {
    throw new Error('Amazon did not return a campaign ID for Sponsored Display');
  }
  return String(campaignId);
}

async function createSdAdGroup(amazonAPI, accessToken, profileId, campaignId, adGroup) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(amazonAPI, accessToken, profileId, 'application/json', 'application/json');

  const body = [
    {
      campaignId: Number(campaignId),
      name: adGroup.name,
      defaultBid: Number(adGroup.defaultBid),
      bidOptimization: adGroup.bidOptimization || 'clicks',
      state: mapSdState(adGroup.state || 'Active'),
      tactic: adGroup.tactic || 'T00020',
    },
  ];

  const response = await adsPost(`${baseUrl}/sd/adGroups`, body, headers, 'Sponsored Display ad group');
  const created = Array.isArray(response.data) ? response.data : [response.data];
  const adGroupId = created[0]?.adGroupId;
  if (!adGroupId) {
    throw new Error('Amazon did not return an ad group ID for Sponsored Display');
  }
  return String(adGroupId);
}

async function createSdProductAds(amazonAPI, accessToken, profileId, productAds, accountType) {
  if (!productAds?.length) return [];

  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(amazonAPI, accessToken, profileId, 'application/json', 'application/json');

  const body = productAds.map((ad) => {
    const payload = {
      adGroupId: Number(ad.adGroupId),
      campaignId: Number(ad.campaignId),
      state: mapSdState(ad.state || 'Active'),
    };
    const sku = String(ad.sku || '').trim();
    const asin = String(ad.asin || '').trim();
    const isVendor = String(accountType || '').toLowerCase() === 'vendor';
    if (isVendor) {
      if (asin) payload.asin = asin;
      else if (sku) payload.sku = sku;
    } else if (sku) {
      payload.sku = sku;
    } else if (asin) {
      payload.asin = asin;
    }
    return payload;
  });

  const response = await adsPost(`${baseUrl}/sd/productAds`, body, headers, 'Sponsored Display product ad');
  return response.data;
}

async function listPortfolios(amazonAPI, accessToken, profileId) {
  const baseUrl = amazonAPI.getAdvertisingApiBaseUrl();
  const headers = buildAdsHeaders(
    amazonAPI,
    accessToken,
    profileId,
    'application/vnd.spPortfolio.v3+json',
    'application/vnd.spPortfolio.v3+json',
  );

  try {
    const response = await axios.post(
      `${baseUrl}/portfolios/list`,
      {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
      },
      { headers },
    );

    const data = response.data;
    if (Array.isArray(data?.portfolios)) return data.portfolios;

    const block = data?.portfolios;
    if (Array.isArray(block?.success)) {
      return block.success.map((entry) => entry.portfolio || entry);
    }

    return amazonAPI.normalizeAdsApiList(data, 'portfolios');
  } catch (err) {
    console.warn('[listPortfolios] Portfolios unavailable:', err.response?.status || err.message);
    return [];
  }
}

module.exports = {
  formatAdsDateIso,
  formatAdsDateCompact,
  mapAuroraState,
  createSpCampaign,
  createSpAdGroups,
  createSpProductAds,
  createSpKeywords,
  createSpNegativeKeywords,
  deleteSpCampaign,
  createSbCampaign,
  createSbAdGroup,
  createSbAds,
  createSdCampaign,
  createSdAdGroup,
  createSdProductAds,
  listPortfolios,
};
