/** AmazonAPI ads methods (façade mixins). */
const axios = require('axios');

module.exports = {
  async getLinkedAdvertisingProfiles(accessToken) {
    const {
      filterProfilesForSeller,
      normalizeSellerId,
      getProfileAccountId,
    } = require('../adsProfileResolver');

    if (!this.user.amazonSellerId) {
      console.warn('[AmazonAPI.getAds] No Seller Central seller id — refusing to sync unscoped profiles');
      return [];
    }

    const profilesResponse = await this.getAdvertisingProfiles(accessToken);
    const allProfiles = this.normalizeAdsApiList(profilesResponse, 'profiles');
    const linkedProfiles = filterProfilesForSeller(allProfiles, this.user.amazonSellerId);

    if (linkedProfiles.length > 0) {
      return linkedProfiles;
    }

    // No profile matched the seller. Amazon returned nothing to compare against —
    // treat as "no campaigns" (the caller no-ops safely without deleting data).
    if (allProfiles.length === 0) {
      return [];
    }

    // Profiles came back but none matched. Distinguish a *confirmed* mismatch (profiles
    // carry resolvable account IDs that differ from the seller) from an *indeterminate*
    // response (Amazon returned profiles without account identifiers — a common transient
    // on /v2/profiles). Only a confirmed mismatch may trigger the destructive cleanup
    // upstream; an indeterminate response must never wipe campaigns.
    const resolvedAccountIds = [
      ...new Set(
        allProfiles.map((p) => normalizeSellerId(getProfileAccountId(p))).filter(Boolean),
      ),
    ];

    if (resolvedAccountIds.length === 0) {
      const indeterminateError = new Error(
        'Amazon Ads returned advertising profiles without account identifiers. Skipping this sync to avoid removing campaigns; it will retry automatically.'
      );
      indeterminateError.code = 'ADS_PROFILES_INDETERMINATE';
      throw indeterminateError;
    }

    const mismatchError = new Error(
      'Amazon Ads is connected to a different seller account than Seller Central. Sign in with the Amazon user that manages ads for this seller, then reconnect Amazon Ads.'
    );
    mismatchError.code = 'ADS_SELLER_MISMATCH';
    mismatchError.details = {
      expectedSellerId: this.user.amazonSellerId,
      adsAccountIds: resolvedAccountIds,
      adsAccountNames: [...new Set(allProfiles.map((p) => p.accountInfo?.name).filter(Boolean))],
    };
    throw mismatchError;
  },

  async getAds() {
    try {
      const accessToken = await this.getAdvertisingAccessToken();
      
      if (!accessToken) {
        return [];
      }

      try {
        const profiles = await this.getLinkedAdvertisingProfiles(accessToken);

        if (profiles.length === 0) {
          return [];
        }

        const allCampaigns = [];
        for (const profile of profiles) {
          try {
            const campaigns = await this.getAdvertisingCampaigns(accessToken, profile.profileId, profile);
            allCampaigns.push(...campaigns);
          } catch (error) {
            console.error(`[AmazonAPI] Campaign fetch failed for profile ${profile.profileId}:`, error.message);
          }
        }

        return allCampaigns;
      } catch (profileError) {
        console.error('[AmazonAPI.getAds] Error fetching profiles:', profileError.message);
        throw profileError;
      }
    } catch (error) {
      console.error('[AmazonAPI.getAds] Error fetching ads:', error.message);
      throw error;
    }
  },

  async getAdvertisingAccessToken() {
    try {
      const refreshToken = this.user.amazonAdsRefreshToken;

      if (!refreshToken) {
        const error = new Error('Amazon Ads is not connected. Connect Amazon Ads from the integration page before syncing campaigns.');
        error.code = 'ADS_NOT_CONNECTED';
        throw error;
      }

      const clientId = this.getAdvertisingClientId();
      const clientSecret = this.getAdvertisingClientSecret();

      if (!clientId || !clientSecret) {
        throw new Error('Missing Amazon Ads OAuth credentials. Configure AMAZON_ADVERTISING_CLIENT_ID/SECRET or AMAZON_LWA_CLIENT_ID/SECRET.');
      }

      const response = await axios.post(
        this.getLwaTokenUrl(),
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return response.data.access_token;
    } catch (error) {
      console.error('[AmazonAPI] Ads access token error:', error.response?.status || error.message);

      if (error.response?.status === 401) {
        const authError = new Error('Amazon Ads authorization failed. Reconnect Amazon Ads and confirm your LWA app is approved for Amazon Ads API access.');
        authError.code = 'ADS_UNAUTHORIZED';
        authError.status = 401;
        throw authError;
      } else if (error.response?.status === 400) {
        const badRequestError = new Error('Invalid Amazon Ads token request. Check your Amazon Ads client ID, client secret, redirect URI, and approved scopes.');
        badRequestError.code = 'ADS_TOKEN_REQUEST_INVALID';
        badRequestError.status = 400;
        throw badRequestError;
      }

      throw new Error(`Failed to get Advertising API access token: ${error.message}`);
    }
  },

  async getAdvertisingProfiles(accessToken) {
    try {
      const endpoint = `${this.getAdvertisingApiBaseUrl()}/v2/profiles`;
      const clientId = this.getAdvertisingClientId();

      const response = await axios.get(endpoint, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Content-Type': 'application/json',
          'User-Agent': 'Aurora-Ad-Manager',
        },
      });

      return response.data;
    } catch (error) {
      console.error('[AmazonAPI] Profiles error:', error.response?.status || error.message);
      if (error.response?.status === 401) {
        error.code = 'ADS_UNAUTHORIZED';
        error.message = 'Amazon Ads profile request was unauthorized. Reconnect Amazon Ads and confirm the authorizing user has access to Campaign Manager/Advertising reports.';
      }
      throw error;
    }
  },

  async getAdvertisingCampaigns(accessToken, profileId, profile = {}) {
  try {
    const clientId = this.getAdvertisingClientId();
    const baseUrl = this.getAdvertisingApiBaseUrl();

    const baseHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
    };

    const campaigns = [];

    /* Sponsored Products — paginated list including archived campaigns */
    try {
      const spHeaders = {
        ...baseHeaders,
        'Content-Type': 'application/vnd.spcampaign.v3+json',
        Accept: 'application/vnd.spcampaign.v3+json',
      };

      let nextToken = null;
      do {
        const body = {
          stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
          maxResults: 100,
        };
        if (nextToken) body.nextToken = nextToken;

        const spResponse = await axios.post(`${baseUrl}/sp/campaigns/list`, body, { headers: spHeaders });
        const spItems = spResponse.data?.campaigns || spResponse.data || [];

        campaigns.push(
          ...spItems.map((campaign) =>
            this.normalizeCampaign(campaign, 'Sponsored Products', profile),
          ),
        );

        nextToken = spResponse.data?.nextToken || null;
      } while (nextToken);
    } catch (error) {
      console.error(`[AmazonAPI] SP campaigns error (profile ${profileId}):`, error.response?.status || error.message);
    }

    /* Sponsored Brands — v4 list endpoint */
    try {
      const sbHeaders = {
        ...baseHeaders,
        'Content-Type': 'application/vnd.sbcampaign.v4+json',
        Accept: 'application/vnd.sbcampaign.v4+json',
      };

      let nextToken = null;
      do {
        const body = { maxResults: 100 };
        if (nextToken) body.nextToken = nextToken;

        const sbResponse = await axios.post(`${baseUrl}/sb/v4/campaigns/list`, body, { headers: sbHeaders });
        const sbItems = sbResponse.data?.campaigns || sbResponse.data || [];

        campaigns.push(
          ...sbItems.map((campaign) =>
            this.normalizeCampaign(campaign, 'Sponsored Brands', profile),
          ),
        );

        nextToken = sbResponse.data?.nextToken || null;
      } while (nextToken);
    } catch (error) {
      try {
        const sbHeaders = {
          ...baseHeaders,
          'Content-Type': 'application/vnd.sbcampaign.v4+json',
          Accept: 'application/vnd.sbcampaign.v4+json',
        };
        const sbResponse = await axios.get(`${baseUrl}/sb/v4/campaigns`, { headers: sbHeaders });
        const sbItems = sbResponse.data?.campaigns || sbResponse.data || [];
        campaigns.push(
          ...sbItems.map((campaign) =>
            this.normalizeCampaign(campaign, 'Sponsored Brands', profile),
          ),
        );
      } catch (fallbackError) {
        console.error(`[AmazonAPI] SB campaigns error (profile ${profileId}):`, error.response?.status || error.message);
      }
    }

    /* Sponsored Display */
    try {
      const sdHeaders = {
        ...baseHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const sdResponse = await axios.get(`${baseUrl}/sd/campaigns`, { headers: sdHeaders });
      const sdItems = sdResponse.data?.campaigns || sdResponse.data || [];

      campaigns.push(
        ...sdItems.map((campaign) =>
          this.normalizeCampaign(campaign, 'Sponsored Display', profile),
        ),
      );
    } catch (error) {
      console.error(`[AmazonAPI] SD campaigns error (profile ${profileId}):`, error.response?.status || error.message);
    }

    return campaigns;
  } catch (error) {
    console.error(`[AmazonAPI] Campaigns error (profile ${profileId}):`, error.response?.status || error.message);
    throw error;
  }
},

  getAdvertisingClientId() {
    const clientId = process.env.AMAZON_ADVERTISING_CLIENT_ID || process.env.AMAZON_LWA_CLIENT_ID;

    if (!clientId) {
      throw new Error('Missing Amazon Ads client id. Configure AMAZON_ADVERTISING_CLIENT_ID or AMAZON_LWA_CLIENT_ID.');
    }

    return clientId;
  },

  getAdvertisingClientSecret() {
    const clientSecret = process.env.AMAZON_ADVERTISING_CLIENT_SECRET || process.env.AMAZON_LWA_CLIENT_SECRET;

    if (!clientSecret) {
      throw new Error('Missing Amazon Ads client secret. Configure AMAZON_ADVERTISING_CLIENT_SECRET or AMAZON_LWA_CLIENT_SECRET.');
    }

    return clientSecret;
  },

  getLwaTokenUrl() {
    const region = (this.user.marketplace || 'NA').toUpperCase();
    const endpoints = {
      NA: 'https://api.amazon.com/auth/o2/token',
      EU: 'https://api.amazon.co.uk/auth/o2/token',
      FE: 'https://api.amazon.co.jp/auth/o2/token',
    };

    return endpoints[region] || endpoints.NA;
  },

  getAdvertisingApiBaseUrl() {
    const region = (this.user.marketplace || 'NA').toUpperCase();
    const endpoints = {
      NA: 'https://advertising-api.amazon.com',
      EU: 'https://advertising-api-eu.amazon.com',
      FE: 'https://advertising-api-fe.amazon.com',
    };

    return endpoints[region] || endpoints.NA;
  },

  normalizeAdsApiList(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  },

  normalizeCampaign(campaign, campaignType, profile) {
    const budgetAmount = campaign.dailyBudget ?? campaign.budget?.budget ?? campaign.budget?.amount;
    const currencyCode = campaign.currency || profile.currencyCode || profile.currency || 'USD';

    return {
      ...campaign,
      profileId: String(profile.profileId),
      campaignId: String(campaign.campaignId || campaign.campaign_id || campaign.id),
      name: campaign.name || campaign.campaignName || 'Untitled campaign',
      state: campaign.state || campaign.status,
      campaignType,
      marketplace: profile.countryCode || campaign.marketplace || campaign.country,
      portfolioId: campaign.portfolioId || campaign.portfolio_id,
      dailyBudget: budgetAmount,
      currency: currencyCode,
    };
  },

  getAdsReportingHeaders(accessToken, profileId) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': this.getAdvertisingClientId(),
      'Amazon-Advertising-API-Scope': String(profileId),
    };
  },

  async createCampaignPerformanceReport(
    accessToken,
    profileId,
    reportConfig,
    startDate,
    endDate,
    options = {},
  ) {
    const baseUrl = this.getAdvertisingApiBaseUrl();
    const headers = {
      ...this.getAdsReportingHeaders(accessToken, profileId),
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      Accept: 'application/vnd.createasyncreportresponse.v3+json',
    };

    const timeUnit = options.timeUnit === 'DAILY' ? 'DAILY' : 'SUMMARY';
    const baseColumns =
      reportConfig.columns ||
      ['campaignId', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
    const columns =
      timeUnit === 'DAILY' && !baseColumns.includes('date')
        ? ['date', ...baseColumns]
        : baseColumns;

    const uniqueSuffix = options.uniqueSuffix || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const body = {
      name: `Aurora ${reportConfig.reportTypeId} ${startDate}..${endDate} ${uniqueSuffix}`,
      startDate,
      endDate,
      configuration: {
        adProduct: reportConfig.adProduct,
        reportTypeId: reportConfig.reportTypeId,
        groupBy: ['campaign'],
        columns,
        timeUnit,
        format: 'GZIP_JSON',
      },
    };

    try {
      const response = await axios.post(`${baseUrl}/reporting/reports`, body, { headers });
      return response.data?.reportId || response.data?.id;
    } catch (error) {
      if (error.response?.status === 425) {
        const detail = String(error.response.data?.detail || '');
        const duplicateMatch = detail.match(/duplicate of\s*:?\s*([a-f0-9-]+)/i);
        if (duplicateMatch?.[1] && !options.retryDuplicate) {
          return this.createCampaignPerformanceReport(
            accessToken,
            profileId,
            reportConfig,
            startDate,
            endDate,
            { ...options, retryDuplicate: true, uniqueSuffix: `${Date.now()}-retry` },
          );
        }
        if (duplicateMatch?.[1]) {
          return duplicateMatch[1];
        }
      }

      const detail =
        error.response?.data?.detail ||
        error.response?.data?.message ||
        error.message;
      throw new Error(`Create report failed (${error.response?.status || 'unknown'}): ${detail}`);
    }
  },

  async getCampaignPerformanceReportStatus(accessToken, profileId, reportId) {
    const baseUrl = this.getAdvertisingApiBaseUrl();
    const headers = {
      ...this.getAdsReportingHeaders(accessToken, profileId),
      Accept: 'application/vnd.getasyncreportresponse.v3+json',
    };

    const response = await axios.get(`${baseUrl}/reporting/reports/${reportId}`, { headers });
    return response.data;
  },

  async downloadCampaignPerformanceReport(downloadUrl) {
    const { parseGzipJsonReport } = require('../adsReportParser');
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
    });
    return parseGzipJsonReport(Buffer.from(response.data));
  },

  async pollV2AdsReport(accessToken, profileId, reportId) {
    const baseUrl = this.getAdvertisingApiBaseUrl();
    const headers = {
      ...this.getAdsReportingHeaders(accessToken, profileId),
      'Content-Type': 'application/json',
    };
    const maxAttempts = parseInt(process.env.ADS_V2_REPORT_POLL_MAX_ATTEMPTS || '60', 10);
    const basePollMs = parseInt(process.env.ADS_REPORT_POLL_INTERVAL_MS || '2000', 10);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await axios.get(`${baseUrl}/v2/reports/${reportId}`, { headers });
      const status = String(response.data?.status || '').toUpperCase();

      if (status === 'SUCCESS' || status === 'COMPLETED') {
        const downloadUrl = response.data.location || response.data.url;
        if (!downloadUrl) {
          throw new Error(`V2 report ${reportId} succeeded but no download URL`);
        }
        return this.downloadCampaignPerformanceReport(downloadUrl);
      }

      if (status === 'FAILURE' || status === 'FAILED' || status === 'CANCELLED') {
        throw new Error(response.data.statusDetails || `V2 report ${reportId} failed`);
      }

      await this.sleep(Math.min(10000, basePollMs + Math.floor(attempt / 5) * 500));
    }

    throw new Error(`Timed out waiting for V2 report ${reportId}`);
  },

  async createV2SpCampaignReport(accessToken, profileId, reportDateYmd) {
    const baseUrl = this.getAdvertisingApiBaseUrl();
    const headers = {
      ...this.getAdsReportingHeaders(accessToken, profileId),
      'Content-Type': 'application/json',
    };

    const reportDate = String(reportDateYmd).replace(/-/g, '');

    try {
      const response = await axios.post(
        `${baseUrl}/v2/sp/campaigns/report`,
        {
          reportDate,
          metrics:
            'campaignId,impressions,clicks,cost,attributedConversions14d,attributedSales14d',
        },
        { headers }
      );
      return response.data?.reportId;
    } catch (error) {
      if (error.response?.status === 425) {
        const detail = String(error.response.data?.detail || '');
        const duplicateMatch = detail.match(/duplicate of\s*:?\s*([a-f0-9-]+)/i);
        if (duplicateMatch?.[1]) {
          return duplicateMatch[1];
        }
      }
      const detail =
        error.response?.data?.detail ||
        error.response?.data?.message ||
        error.message;
      throw new Error(`V2 SP report failed (${error.response?.status || 'unknown'}): ${detail}`);
    }
  },

  async fetchSpCampaignMetricsV2Range(accessToken, profileId, startDate, endDate) {
    const rowsByCampaign = new Map();
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);

    for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
      const ymd = day.toISOString().slice(0, 10);
      const reportId = await this.createV2SpCampaignReport(accessToken, profileId, ymd);
      if (!reportId) continue;

      const dayRows = await this.pollV2AdsReport(accessToken, profileId, reportId);

      for (const row of dayRows) {
        const campaignId = String(row.campaignId ?? row.campaign_id ?? '');
        if (!campaignId) continue;

        const existing = rowsByCampaign.get(campaignId) || {
          campaignId,
          impressions: 0,
          clicks: 0,
          cost: 0,
          attributedConversions14d: 0,
          attributedSales14d: 0,
        };

        existing.impressions += Number(row.impressions) || 0;
        existing.clicks += Number(row.clicks) || 0;
        existing.cost += Number(row.cost) || 0;
        existing.attributedConversions14d += Number(row.attributedConversions14d) || 0;
        existing.attributedSales14d += Number(row.attributedSales14d) || 0;
        rowsByCampaign.set(campaignId, existing);
      }

      await this.sleep(parseInt(process.env.ADS_V2_REPORT_DAY_DELAY_MS || '1500', 10));
    }

    return [...rowsByCampaign.values()];
  },

  async fetchCampaignPerformanceReport(accessToken, profileId, reportConfig, startDate, endDate) {
    const reportId = await this.createCampaignPerformanceReport(
      accessToken,
      profileId,
      reportConfig,
      startDate,
      endDate
    );

    if (!reportId) {
      throw new Error('Amazon Ads report creation did not return a reportId');
    }

    const maxAttempts = parseInt(process.env.ADS_REPORT_POLL_MAX_ATTEMPTS || '200', 10);
    const basePollMs = parseInt(process.env.ADS_REPORT_POLL_INTERVAL_MS || '3000', 10);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const statusPayload = await this.getCampaignPerformanceReportStatus(
        accessToken,
        profileId,
        reportId
      );
      const status = String(statusPayload?.status || '').toUpperCase();

      if (status === 'COMPLETED') {
        const downloadUrl = statusPayload.url || statusPayload.location;
        if (!downloadUrl) {
          throw new Error('Report completed but no download URL was returned');
        }
        return this.downloadCampaignPerformanceReport(downloadUrl);
      }

      if (status === 'FAILED' || status === 'CANCELLED') {
        throw new Error(
          statusPayload.failureReason ||
            statusPayload.statusDetails ||
            `Report ${reportId} failed with status ${status}`
        );
      }

      if (attempt > 0 && attempt % 20 === 0) {
        console.log(`[AmazonAPI] Report ${reportId} still ${status || 'PENDING'} (poll ${attempt}/${maxAttempts})`);
      }

      const pollMs = Math.min(15000, basePollMs + Math.floor(attempt / 10) * 1000);
      await this.sleep(pollMs);
    }

    throw new Error(`Timed out waiting for report ${reportId} after ${maxAttempts} polls`);
  }
};
