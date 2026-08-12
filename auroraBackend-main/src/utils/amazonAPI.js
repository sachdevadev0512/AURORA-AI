const SellingPartnerAPI = require('amazon-sp-api');
const axios = require('axios');
const { callWithSpApiRetry, buildSpApiLabel } = require('./spApiCall');
const { aggregateSalesAndTrafficByAsin: parseSalesAndTrafficByAsin } = require('./salesTrafficWindow');

class AmazonAPI {
  constructor(user, sellerAppCredentials = null) {
    this.user = user;
    
    // Determine LWA credentials from seller app or environment
    let lwaClientId;
    let lwaClientSecret;

    if (sellerAppCredentials) {
      // Use seller app credentials (should already be decrypted)
      lwaClientId = sellerAppCredentials.amazonLwaClientId;
      lwaClientSecret = sellerAppCredentials.amazonLwaClientSecret;
    } else {
      // Fallback to environment variables
      lwaClientId = process.env.AMAZON_LWA_CLIENT_ID || process.env.AMAZON_CLIENT_ID;
      lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET || process.env.AMAZON_CLIENT_SECRET;
    }

    this.sellingPartner = new SellingPartnerAPI({
      region: (user.marketplace || 'NA').toLowerCase(),
      refresh_token: user.amazonRefreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: lwaClientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: lwaClientSecret,
      },
    });

    this._spApiGovernance = {
      label: user?._id ? `seller:${String(user._id)}` : 'anon',
      shouldAbort: null,
      maxAttempts: undefined,
      baseDelayMs: undefined,
    };
  }

  /**
   * Configure shared SP-API pacing/retry for all calls on this instance.
   * Sync jobs typically set shouldAbort + a service label once per run.
   */
  setSpApiOptions({ shouldAbort, label, maxAttempts, baseDelayMs } = {}) {
    if (shouldAbort !== undefined) this._spApiGovernance.shouldAbort = shouldAbort;
    if (label !== undefined) this._spApiGovernance.label = label;
    if (maxAttempts !== undefined) this._spApiGovernance.maxAttempts = maxAttempts;
    if (baseDelayMs !== undefined) this._spApiGovernance.baseDelayMs = baseDelayMs;
    return this;
  }

  async callSpApi(params, overrides = {}) {
    const options = {
      shouldAbort: overrides.shouldAbort ?? this._spApiGovernance.shouldAbort ?? undefined,
      label: overrides.label || buildSpApiLabel(this._spApiGovernance.label, params),
      maxAttempts: overrides.maxAttempts ?? this._spApiGovernance.maxAttempts,
      baseDelayMs: overrides.baseDelayMs ?? this._spApiGovernance.baseDelayMs,
    };

    return callWithSpApiRetry(() => this.sellingPartner.callAPI(params), options);
  }

  // Get orders
  async getOrders(createdAfter = null, createdBefore = null, nextToken = null) {
    try {
      const params = nextToken
        ? { NextToken: nextToken }
        : {
            MarketplaceIds: this.getMarketplaceIds(),
          };

      if (!nextToken) {
        if (createdAfter) params.CreatedAfter = createdAfter;
        if (createdBefore) params.CreatedBefore = createdBefore;
      }

      const response = await this.callSpApi({
        operation: 'getOrders',
        endpoint: 'orders',
        query: params,
      });

      return {
        orders: response.Orders || [],
        nextToken: response.NextToken || null,
      };
    } catch (error) {
      console.error('Error fetching orders:', error);
      throw error;
    }
  }

  // Get order items with detailed information
  async getOrderItems(orderId) {
    try {
      const response = await this.callSpApi({
        operation: 'getOrderItems',
        endpoint: 'orders',
        path: {
          orderId,
        },
      });

      return response.OrderItems || [];
    } catch (error) {
      console.error('Error fetching order items:', error);
      throw error;
    }
  }

  // Get financial events (payments, refunds, fees) — single page.
  async getFinancialEvents(startDate, endDate) {
    try {
      const params = {
        PostedAfter: startDate,
      };

      if (endDate) params.PostedBefore = endDate;

      const response = await this.callSpApi({
        operation: 'listFinancialEvents',
        endpoint: 'finances',
        query: params,
      });

      return response.FinancialEvents || {};
    } catch (error) {
      console.error('Error fetching financial events:', error);
      throw error;
    }
  }

  /**
   * Walk paginated Finances events over a window, yielding one page at a time
   * via the async callback. Finances is 0.5 req/s; the caller can stop early
   * by returning `false` from the callback when they've collected enough.
   *
   * `onPage(pageEvents, pageIndex)` receives the raw `FinancialEvents` object
   * for each page and may return `false` to break.
   */
  async iterateFinancialEvents(startDate, endDate, onPage, options = {}) {
    const maxPages = parseInt(
      options.maxPages || process.env.FINANCE_EVENTS_MAX_PAGES || '200', 10);
    const interPageDelayMs = parseInt(
      options.interPageDelayMs || process.env.FINANCE_EVENTS_INTER_PAGE_DELAY_MS || '2100', 10);

    // Amazon rejects ranges wider than 180 days when BOTH PostedAfter and
    // PostedBefore are set. For open-ended walks (no endDate) we only send
    // PostedAfter — Amazon defaults the upper bound to "now". For chunked
    // walks (endDate provided) we send both so each short window is bounded
    // and recent refunds aren't starved by a page-cap on an older window.
    let nextToken = null;
    for (let page = 0; page < maxPages; page += 1) {
      let query;
      if (nextToken) {
        query = { NextToken: nextToken };
      } else {
        query = { PostedAfter: startDate, MaxResultsPerPage: 100 };
        if (endDate) {
          query.PostedBefore = endDate;
        }
      }

      const response = await this.callSpApi({
        operation: 'listFinancialEvents',
        endpoint: 'finances',
        query,
      });

      const events = response.FinancialEvents || {};
      // Compact per-page breadcrumb so long walks aren't silent.
      const svc = (events.ServiceFeeEventList || []).length;
      const shp = (events.ShipmentEventList || []).length;
      const rfd = (events.RefundEventList || []).length;
      const adj = (events.AdjustmentEventList || []).length;
      console.log(
        `[FinancesWalk] page=${page + 1} service=${svc} shipment=${shp} refund=${rfd} adj=${adj} nextToken=${response.NextToken ? 'yes' : 'no'}`,
      );
      const stop = await Promise.resolve(onPage(events, page));
      if (stop === false) return;

      nextToken = response.NextToken || null;
      if (!nextToken) return;

      await this.sleep(interPageDelayMs);
    }
    console.log(
      `[FinancesWalk] hit maxPages=${maxPages} cap; stopping walk`,
    );
  }

  /**
   * Finances API v2024-06-19 listTransactions — every row carries postedDate.
   * Used for DEFERRED refunds (Seller Central "Refund applied") that Finances
   * v0 RefundEventList omits until RELEASED, and for inbound placement fees.
   * Prefer this for placement fee dating (ServiceFeeEventList often omits PostedDate).
   */
  async iterateTransactions(startDate, endDate, onPage, options = {}) {
    const maxPages = parseInt(
      options.maxPages || process.env.FINANCE_TX_MAX_PAGES || '200', 10);
    const interPageDelayMs = parseInt(
      options.interPageDelayMs || process.env.FINANCE_EVENTS_INTER_PAGE_DELAY_MS || '2100', 10);

    let nextToken = null;
    for (let page = 0; page < maxPages; page += 1) {
      let query;
      if (nextToken) {
        query = { nextToken };
      } else {
        query = { postedAfter: startDate };
        if (endDate) query.postedBefore = endDate;
      }

      const response = await this.callSpApi({
        operation: 'listTransactions',
        endpoint: 'finances',
        query,
        options: { version: '2024-06-19' },
      });

      const txs = response?.transactions || response?.payload?.transactions || [];
      const token = response?.nextToken || response?.payload?.nextToken || null;
      console.log(
        `[TransactionsWalk] page=${page + 1} txs=${txs.length} nextToken=${token ? 'yes' : 'no'}`,
      );
      const stop = await Promise.resolve(onPage(txs, page));
      if (stop === false) return;

      nextToken = token;
      if (!nextToken) return;
      await this.sleep(interPageDelayMs);
    }
    console.log(`[TransactionsWalk] hit maxPages=${maxPages} cap; stopping walk`);
  }

  // Get order metrics/reporting data
  async getOrderMetrics(startDate, endDate, granularity = 'Day') {
    try {
      const params = {
        interval: `${startDate}/${endDate}`,
        granularity: granularity,
        granularityTimeZone: 'UTC',
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      };

      const response = await this.callSpApi({
        operation: 'getReport',
        endpoint: 'reports',
        query: params,
      });

      return response;
    } catch (error) {
      console.error('Error fetching order metrics:', error);
      throw error;
    }
  }

  // Get inventory summaries (single page)
  async getInventorySummariesPage(nextToken = null) {
    try {
      const marketplaceId = this.getMarketplaceId();
      const params = {
        marketplaceIds: [marketplaceId],
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        details: true,
      };
      if (nextToken) params.nextToken = nextToken;

      const response = await this.callSpApi({
        operation: 'getInventorySummaries',
        endpoint: 'fbaInventory',
        query: params,
      });

      return {
        items: response.inventorySummaries || [],
        nextToken: response.nextToken || response.pagination?.nextToken || null,
      };
    } catch (error) {
      console.error('Error fetching inventory:', error);
      throw error;
    }
  }

  // Get all inventory summaries (legacy helper)
  async getInventorySummaries(skus = null) {
    try {
      if (skus) {
        const marketplaceId = this.getMarketplaceId();
        const response = await this.callSpApi({
          operation: 'getInventorySummaries',
          endpoint: 'fbaInventory',
          query: {
            marketplaceIds: [marketplaceId],
            granularityType: 'Marketplace',
            granularityId: marketplaceId,
            sellerSkus: skus,
            details: true,
          },
        });
        return response.inventorySummaries || [];
      }

      const all = [];
      let nextToken = null;
      do {
        const page = await this.getInventorySummariesPage(nextToken);
        all.push(...page.items);
        nextToken = page.nextToken;
      } while (nextToken);
      return all;
    } catch (error) {
      console.error('Error fetching inventory:', error);
      throw error;
    }
  }

  // Get catalog item (images, identifiers/EAN, sales rank, summaries)
  async getCatalogItem(asin) {
    try {
      const response = await this.callSpApi({
        operation: 'getCatalogItem',
        endpoint: 'catalogItems',
        path: {
          asin,
        },
        query: {
          marketplaceIds: [this.getMarketplaceId()],
          includedData: ['images', 'productTypes', 'salesRanks', 'identifiers', 'summaries'],
        },
      });

      return response;
    } catch (error) {
      const code = error.code || error.response?.data?.errors?.[0]?.code;
      if (code === 'NOT_FOUND') {
        return null;
      }
      console.error('Error fetching catalog item:', error.message || error);
      throw error;
    }
  }

  async getListingsItem(sku) {
    if (!this.user.amazonSellerId || !sku) return null;
    try {
      const response = await this.callSpApi({
        operation: 'getListingsItem',
        endpoint: 'listingsItems',
        path: {
          sellerId: this.user.amazonSellerId,
          sku,
        },
        query: {
          marketplaceIds: [this.getMarketplaceId()],
          includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability'],
        },
      });
      return response;
    } catch (error) {
      const code = error.code || error.response?.data?.errors?.[0]?.code;
      if (code === 'NOT_FOUND') {
        return null;
      }
      // Non-404 failures must not be treated as deleted listings by reconcile.
      console.error(`Error fetching listing ${sku}:`, error.message || error);
      error.code = code || error.code || 'GET_LISTINGS_ITEM_FAILED';
      throw error;
    }
  }

  // Paginate all seller listings (FBA + FBM) — matches Seller Central catalog scope
  async searchListingsItemsPage(pageToken = null) {
    if (!this.user.amazonSellerId) {
      const error = new Error('Amazon seller ID is required to sync all listings');
      error.code = 'SELLER_ID_REQUIRED';
      throw error;
    }
    try {
      const query = {
        marketplaceIds: [this.getMarketplaceId()],
        includedData: [
          'summaries',
          'attributes',
          'offers',
          'fulfillmentAvailability',
          'issues',
        ],
        pageSize: 20,
        sortBy: 'lastUpdatedDate',
        sortOrder: 'DESC',
      };
      if (pageToken) query.pageToken = pageToken;

      const response = await this.callSpApi({
        operation: 'searchListingsItems',
        endpoint: 'listingsItems',
        path: {
          sellerId: this.user.amazonSellerId,
        },
        query,
      });

      return {
        items: response.items || [],
        nextToken: response.pagination?.nextToken || null,
        numberOfResults: response.numberOfResults || 0,
      };
    } catch (error) {
      console.error('Error searching listings:', error.message || error);
      throw error;
    }
  }

  async loadAllFbaInventoryBySku() {
    const bySku = new Map();
    let nextToken = null;
    do {
      const page = await this.getInventorySummariesPage(nextToken);
      for (const item of page.items) {
        if (item.sellerSku) bySku.set(item.sellerSku, item);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return bySku;
  }

  async getCompetitivePricing(asins) {
    const ids = [...new Set((asins || []).filter(Boolean))].slice(0, 20);
    if (ids.length === 0) return [];
    try {
      const response = await this.callSpApi({
        operation: 'getCompetitivePricing',
        endpoint: 'productPricing',
        query: {
          MarketplaceId: this.getMarketplaceId(),
          ItemType: 'Asin',
          Asins: ids,
        },
      });
      return response || [];
    } catch (error) {
      console.error('Error fetching competitive pricing:', error.message || error);
      return [];
    }
  }

  async getItemOffers(asin) {
    if (!asin) return null;
    try {
      return await this.callSpApi({
        operation: 'getItemOffers',
        endpoint: 'productPricing',
        path: { Asin: asin },
        query: {
          MarketplaceId: this.getMarketplaceId(),
          ItemCondition: 'New',
        },
      });
    } catch (error) {
      console.error(`Error fetching item offers for ${asin}:`, error.message || error);
      return null;
    }
  }

  /**
   * Update listing price via Listings Items API.
   * productType is required by Amazon — pass summaries[0].productType from getListingsItem.
   */
  async patchListingsItemPrice(sku, amount, currency = 'USD', productType = 'PRODUCT') {
    if (!this.user.amazonSellerId || !sku) {
      throw new Error('Seller ID and SKU are required to update price');
    }
    const marketplaceId = this.getMarketplaceId();
    const price = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Price must be a positive number');
    }

    const response = await this.callSpApi({
      operation: 'patchListingsItem',
      endpoint: 'listingsItems',
      path: {
        sellerId: this.user.amazonSellerId,
        sku: String(sku),
      },
      query: {
        marketplaceIds: [marketplaceId],
      },
      body: {
        productType: productType || 'PRODUCT',
        patches: [
          {
            op: 'replace',
            path: '/attributes/purchasable_offer',
            value: [
              {
                marketplace_id: marketplaceId,
                currency: currency || 'USD',
                our_price: [
                  {
                    schedule: [
                      {
                        value_with_tax: price,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    return response;
  }

  async getMyFeesEstimateForSku(sku, priceAmount, currency = 'USD', isFba = true) {
    if (!sku || !priceAmount || priceAmount <= 0) return null;
    try {
      const response = await this.callSpApi({
        operation: 'getMyFeesEstimateForSKU',
        endpoint: 'productFees',
        path: { SellerSKU: sku },
        body: {
          FeesEstimateRequest: {
            MarketplaceId: this.getMarketplaceId(),
            IsAmazonFulfilled: isFba,
            PriceToEstimateFees: {
              ListingPrice: {
                CurrencyCode: currency,
                Amount: priceAmount,
              },
            },
            Identifier: sku,
          },
        },
      });
      return response;
    } catch (error) {
      console.error(`Error fetching fees for ${sku}:`, error.message || error);
      return null;
    }
  }

  // Get seller performance data
  async getSellerPerformance() {
    try {
      const response = await this.callSpApi({
        operation: 'getSellerPerformance',
        endpoint: 'sellers',
      });

      return response;
    } catch (error) {
      console.error('Error fetching seller performance:', error);
      throw error;
    }
  }

  async getLinkedAdvertisingProfiles(accessToken) {
    const {
      filterProfilesForSeller,
      normalizeSellerId,
      getProfileAccountId,
    } = require('./adsProfileResolver');

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
  }

  // Get ads from Amazon Advertising API
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
  }

  // Get advertising API access token
  // async getAdvertisingAccessToken() {
  //   try {
  //     console.log('[getAdvertisingAccessToken] Requesting access token for Advertising API...');
      
  //     // Try specific Advertising API credentials first
  //     let clientId = process.env.AMAZON_ADVERTISING_CLIENT_ID;
  //     let clientSecret = process.env.AMAZON_ADVERTISING_CLIENT_SECRET;
      
  //     // If Advertising credentials not provided, fall back to Selling Partner credentials
  //     // (your app might be authorized for both APIs)
  //     if (!clientId || !clientSecret) {
  //       console.log('[getAdvertisingAccessToken] Advertising API credentials not found, trying Selling Partner credentials as fallback...');
  //       clientId = process.env.AMAZON_LWA_CLIENT_ID || process.env.AMAZON_CLIENT_ID;
  //       clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET || process.env.AMAZON_CLIENT_SECRET;
        
  //       if (!clientId || !clientSecret) {
  //         console.error('[getAdvertisingAccessToken] No credentials available at all');
  //         return null;
  //       }
  //       console.log('[getAdvertisingAccessToken] Using Selling Partner credentials for Advertising API');
  //     }

  //     const response = await axios.post('https://api.amazon.com/auth/o2/token', {
  //       grant_type: 'refresh_token',
  //       refresh_token: this.user.amazonRefreshToken,
  //       client_id: clientId,
  //       client_secret: clientSecret,
  //     });

  //     console.log('[getAdvertisingAccessToken] Successfully obtained Advertising API access token');
  //     return response.data.access_token;
  //   } catch (error) {
  //     console.error('[getAdvertisingAccessToken] Failed to get Advertising API access token:', {
  //       status: error.response?.status,
  //       statusText: error.response?.statusText,
  //       errorData: error.response?.data,
  //       message: error.message
  //     });
  //     return null;
  //   }
  // }

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
  }

  // Get advertising profiles
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
  }

  // Get campaigns for a profile
//   async getAdvertisingCampaigns(accessToken, profileId, profile = {}) {
//     try {
//       console.log(`[getAdvertisingCampaigns] Fetching campaigns for profile ${profileId}...`);
//       const clientId = this.getAdvertisingClientId();
//       const baseUrl = this.getAdvertisingApiBaseUrl();
//       // const headers = {
//       //   'Authorization': `Bearer ${accessToken}`,
//       //   'Amazon-Advertising-API-ClientId': clientId,
//       //   'Amazon-Advertising-API-Scope': String(profileId),
//       //   'Content-Type': 'application/json',
//       // };

//       const headers = {
//         Authorization: `Bearer ${accessToken}`,
//         'Amazon-Advertising-API-ClientId': clientId,
//         'Amazon-Advertising-API-Scope': String(profileId),
//         'Content-Type': 'application/json',
//         Accept: 'application/json',
//       };

//       // const campaignRequests = [
//       //   { url: `${baseUrl}/v2/sp/campaigns`, campaignType: 'Sponsored Products' },
//       //   { url: `${baseUrl}/v2/hsa/campaigns`, campaignType: 'Sponsored Brands' },
//       //   { url: `${baseUrl}/sd/campaigns`, campaignType: 'Sponsored Display' },
//       // ];

//       const campaignRequests = [
//         {
//           url: `${baseUrl}/sp/campaigns/list`,
//           method: 'post',
//           campaignType: 'Sponsored Products',
//           body: {},
//         },
//         {
//           url: `${baseUrl}/sb/campaigns/list`,
//           method: 'post',
//           campaignType: 'Sponsored Brands',
//           body: {},
//         },
//         {
//           url: `${baseUrl}/sd/campaigns`,
//           method: 'get',
//           campaignType: 'Sponsored Display',
//         },
//       ];
//       const campaigns = [];

//       // for (const request of campaignRequests) {
//       //   try {
//       //     // const response = await axios.get(request.url, { headers });
//       //     let response;

//       //     if (request.method === 'post') {
//       //       response = await axios.post(
//       //         request.url,
//       //         request.body,
//       //         { headers }
//       //       );
//       //     } else {
//       //       response = await axios.get(request.url, { headers });
//       //     }
//       //     const items = this.normalizeAdsApiList(response.data, 'campaigns');
//       //     campaigns.push(
//       //       ...items.map((campaign) => this.normalizeCampaign(campaign, request.campaignType, profile))
//       //     );
//       //     console.log(`[getAdvertisingCampaigns] ${request.campaignType}: ${items.length} campaigns`);
//       //   } catch (error) {
//       //     console.error(`[getAdvertisingCampaigns] Error fetching ${request.campaignType} for profile ${profileId}:`, {
//       //       status: error.response?.status,
//       //       errorData: error.response?.data,
//       //       message: error.message,
//       //     });
//       //   }
//       // }

//       for (const request of campaignRequests) {
//   try {
//     let response;

//     if (request.method === 'post') {
//       response = await axios.post(
//         request.url,
//         request.body,
//         { headers }
//       );
//     } else {
//       response = await axios.get(
//         request.url,
//         { headers }
//       );
//     }

//     console.log(
//       request.campaignType,
//       JSON.stringify(response.data, null, 2)
//     );

//     const items = this.normalizeAdsApiList(
//       response.data,
//       'campaigns'
//     );

//     campaigns.push(
//       ...items.map((campaign) =>
//         this.normalizeCampaign(
//           campaign,
//           request.campaignType,
//           profile
//         )
//       )
//     );

//     console.log(
//       `[getAdvertisingCampaigns] ${request.campaignType}: ${items.length} campaigns`
//     );
//   } catch (error) {
//     console.error({
//       endpoint: request.url,
//       status: error.response?.status,
//       data: error.response?.data,
//     });
//   }
// }

//       console.log(`[getAdvertisingCampaigns] Successfully fetched campaigns for profile ${profileId}:`, {
//         campaignCount: campaigns.length,
//       });
//       return campaigns;
//     } catch (error) {
//       console.error(`[getAdvertisingCampaigns] Error fetching campaigns for profile ${profileId}:`, {
//         status: error.response?.status,
//         errorData: error.response?.data,
//         message: error.message,
//       });
//       throw error;
//     }
//   }

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
}

  getAdvertisingClientId() {
    const clientId = process.env.AMAZON_ADVERTISING_CLIENT_ID || process.env.AMAZON_LWA_CLIENT_ID;

    if (!clientId) {
      throw new Error('Missing Amazon Ads client id. Configure AMAZON_ADVERTISING_CLIENT_ID or AMAZON_LWA_CLIENT_ID.');
    }

    return clientId;
  }

  getAdvertisingClientSecret() {
    const clientSecret = process.env.AMAZON_ADVERTISING_CLIENT_SECRET || process.env.AMAZON_LWA_CLIENT_SECRET;

    if (!clientSecret) {
      throw new Error('Missing Amazon Ads client secret. Configure AMAZON_ADVERTISING_CLIENT_SECRET or AMAZON_LWA_CLIENT_SECRET.');
    }

    return clientSecret;
  }

  getLwaTokenUrl() {
    const region = (this.user.marketplace || 'NA').toUpperCase();
    const endpoints = {
      NA: 'https://api.amazon.com/auth/o2/token',
      EU: 'https://api.amazon.co.uk/auth/o2/token',
      FE: 'https://api.amazon.co.jp/auth/o2/token',
    };

    return endpoints[region] || endpoints.NA;
  }

  getAdvertisingApiBaseUrl() {
    const region = (this.user.marketplace || 'NA').toUpperCase();
    const endpoints = {
      NA: 'https://advertising-api.amazon.com',
      EU: 'https://advertising-api-eu.amazon.com',
      FE: 'https://advertising-api-fe.amazon.com',
    };

    return endpoints[region] || endpoints.NA;
  }

  normalizeAdsApiList(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

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
  }

  getAdsReportingHeaders(accessToken, profileId) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': this.getAdvertisingClientId(),
      'Amazon-Advertising-API-Scope': String(profileId),
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static createAbortError() {
    const error = new Error('Sync aborted');
    error.code = 'SYNC_ABORTED';
    return error;
  }

  async sleepInterruptible(ms, shouldAbort, stepMs = 500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const aborted = await Promise.resolve(shouldAbort?.());
      if (aborted) throw AmazonAPI.createAbortError();
      await this.sleep(Math.min(stepMs, Math.max(0, deadline - Date.now())));
    }
  }

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
  }

  async getCampaignPerformanceReportStatus(accessToken, profileId, reportId) {
    const baseUrl = this.getAdvertisingApiBaseUrl();
    const headers = {
      ...this.getAdsReportingHeaders(accessToken, profileId),
      Accept: 'application/vnd.getasyncreportresponse.v3+json',
    };

    const response = await axios.get(`${baseUrl}/reporting/reports/${reportId}`, { headers });
    return response.data;
  }

  async downloadCampaignPerformanceReport(downloadUrl) {
    const { parseGzipJsonReport } = require('./adsReportParser');
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
    });
    return parseGzipJsonReport(Buffer.from(response.data));
  }

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
  }

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
  }

  /**
   * V2 SP daily reports — more reliable than v3 when async reports stay PENDING.
   */
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
  }

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

  // Get reports list
  async getReports(reportTypes = null, processingStatuses = null) {
    try {
      const params = {};

      if (reportTypes) params.reportTypes = reportTypes;
      if (processingStatuses) params.processingStatuses = processingStatuses;

      const response = await this.callSpApi({
        operation: 'getReports',
        endpoint: 'reports',
        query: params,
      });

      return response.reports || [];
    } catch (error) {
      console.error('Error fetching reports:', error);
      throw error;
    }
  }

  // Create a report
  async createReport(reportType, startDate = null, endDate = null, marketplaceIds = null) {
    try {
      const params = {
        reportType,
        // Prefer a single primary marketplace. Passing every NA participation
        // (MX/CA/BR/…) often yields InvalidInput or FATAL for inventory reports.
        marketplaceIds: marketplaceIds || [this.getMarketplaceId()],
      };

      if (startDate) params.dataStartTime = startDate;
      if (endDate) params.dataEndTime = endDate;

      const response = await this.callSpApi({
        operation: 'createReport',
        endpoint: 'reports',
        body: params,
      });

      return response;
    } catch (error) {
      console.error('Error creating report:', error);
      throw error;
    }
  }

  async waitForReportDocument(reportId, options = {}) {
    const maxAttempts = parseInt(
      options.maxAttempts || process.env.ORDER_REPORT_POLL_MAX_ATTEMPTS || '120',
      10
    );
    const basePollMs = parseInt(
      options.basePollMs || process.env.ORDER_REPORT_POLL_INTERVAL_MS || '5000',
      10
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const aborted = await Promise.resolve(options.shouldAbort?.());
      if (aborted) throw AmazonAPI.createAbortError();

      const report = await this.getReportById(reportId);
      const statusText = String(report?.processingStatus || '').toUpperCase();

      if (statusText === 'DONE') {
        if (!report?.reportDocumentId) {
          throw new Error(`Report ${reportId} completed without reportDocumentId`);
        }
        return this.getReportDocumentById(report.reportDocumentId);
      }

      if (statusText === 'CANCELLED' || statusText === 'FATAL') {
        throw new Error(`Report ${reportId} ended with status ${statusText}`);
      }

      if (attempt > 0 && attempt % 12 === 0) {
        console.log(`[AmazonAPI] Order report ${reportId} still ${statusText || 'PENDING'} (poll ${attempt})`);
      }

      await this.sleepInterruptible(
        Math.min(15000, basePollMs + Math.floor(attempt / 6) * 1000),
        options.shouldAbort,
      );
    }

    throw new Error(`Timed out waiting for report ${reportId}`);
  }

  async fetchFlatFileOrdersByOrderDateReport(startDate, endDate, options = {}) {
    const reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';
    const created = await this.createReport(reportType, startDate, endDate);
    const reportId = created?.reportId;

    if (!reportId) {
      throw new Error('Order report creation did not return a reportId');
    }

    const documentInfo = await this.waitForReportDocument(reportId, options);
    if (await Promise.resolve(options.shouldAbort?.())) {
      throw AmazonAPI.createAbortError();
    }
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  async fetchFbaCustomerReturnsReport(startDate, endDate) {
    const reportType = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
    const created = await this.createReport(reportType, startDate, endDate);
    const reportId = created?.reportId;

    if (!reportId) {
      throw new Error('FBA customer returns report creation did not return a reportId');
    }

    const documentInfo = await this.waitForReportDocument(reportId, {
      maxAttempts: parseInt(process.env.RETURNS_REPORT_POLL_MAX_ATTEMPTS || '90', 10),
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  // All Listings Report (GET_MERCHANT_LISTINGS_ALL_DATA) — mirrors Seller Central
  // "Manage All Inventory" export: every SKU (Active AND Inactive), FBA + FBM, with
  // no ~1000-item cap. Returns an array of row objects keyed by the TSV headers.
  async fetchAllListingsReport() {
    const created = await this.createReport(
      'GET_MERCHANT_LISTINGS_ALL_DATA',
      null,
      null,
      [this.getMarketplaceId()]
    );
    const reportId = created?.reportId;
    if (!reportId) {
      throw new Error('All Listings report creation did not return a reportId');
    }

    const documentInfo = await this.waitForReportDocument(reportId, {
      maxAttempts: parseInt(process.env.PRODUCT_REPORT_POLL_MAX_ATTEMPTS || '120', 10),
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  // FBA Inventory Planning report (GET_FBA_INVENTORY_PLANNING_DATA) — snapshot;
  // per-SKU aged-inventory-surcharge projections (`estimated-ais-*-days` columns)
  // plus historical-days-of-supply. Returns an array of row objects keyed by TSV
  // headers.
  async fetchFbaInventoryPlanningReport() {
    const created = await this.createReport(
      'GET_FBA_INVENTORY_PLANNING_DATA',
      null,
      null,
      [this.getMarketplaceId()]
    );
    const reportId = created?.reportId;
    if (!reportId) {
      throw new Error('FBA inventory planning report creation did not return a reportId');
    }
    const documentInfo = await this.waitForReportDocument(reportId, {
      maxAttempts: parseInt(process.env.INVENTORY_PLANNING_REPORT_POLL_MAX_ATTEMPTS || '120', 10),
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  // FBA Inbound Placement Fees Charges report
  // (GET_FBA_INBOUND_PLACEMENT_FEES_CHARGES_DATA). Per-shipment breakdown
  // of the charges Amazon applied for FBA inbound placement, keyed by SKU
  // + received quantity + fee amount. Requires a date range.
  async fetchFbaInboundPlacementFeeReport(startDate, endDate) {
    const created = await this.createReport(
      'GET_FBA_INBOUND_PLACEMENT_FEES_CHARGES_DATA',
      startDate,
      endDate,
      [this.getMarketplaceId()]
    );
    const reportId = created?.reportId;
    if (!reportId) {
      throw new Error('FBA inbound placement fee report creation did not return a reportId');
    }
    const documentInfo = await this.waitForReportDocument(reportId, {
      maxAttempts: parseInt(process.env.PLACEMENT_FEE_REPORT_POLL_MAX_ATTEMPTS || '90', 10),
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  // FBA Manage Inventory Report (GET_FBA_MYI_ALL_INVENTORY_DATA) — mirrors Seller
  // Central "Manage FBA Inventory" export including suppressed listings. Returns an
  // array of row objects keyed by the TSV headers (sku, fnsku, asin, afn-* quantities).
  async fetchFbaInventoryReport() {
    const created = await this.createReport(
      'GET_FBA_MYI_ALL_INVENTORY_DATA',
      null,
      null,
      [this.getMarketplaceId()]
    );
    const reportId = created?.reportId;
    if (!reportId) {
      throw new Error('FBA inventory report creation did not return a reportId');
    }

    const documentInfo = await this.waitForReportDocument(reportId, {
      maxAttempts: parseInt(process.env.PRODUCT_REPORT_POLL_MAX_ATTEMPTS || '120', 10),
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  }

  /**
   * Build a sellerSku → inventorySummary map. Prefer the MYI report; if Amazon
   * returns FATAL/rejects it (common for some NA multi-marketplace accounts),
   * fall back to getInventorySummaries which still matches Seller Central.
   */
  async loadFbaInventoryBySkuMap(options = {}) {
    const { shouldAbort } = options;
    try {
      if (await Promise.resolve(shouldAbort?.())) {
        throw AmazonAPI.createAbortError();
      }
      const rows = await this.fetchFbaInventoryReport();
      return { source: 'report', rows };
    } catch (error) {
      if (error?.code === 'SYNC_ABORTED' || error?.code === 'ABORTED') throw error;
      const message = error?.message || String(error);
      const isFatal =
        /ended with status FATAL/i.test(message) ||
        /not allowed for this Report/i.test(message) ||
        /InvalidInput/i.test(message) ||
        error?.code === 'InvalidInput';
      if (!isFatal) throw error;
      console.warn(
        `[AmazonAPI] FBA MYI report unavailable (${message}). Falling back to getInventorySummaries.`,
      );
      const items = await this.getInventorySummaries();
      return { source: 'live_api', items: items || [] };
    }
  }

  // Create a GET_SALES_AND_TRAFFIC_REPORT (units ordered + page views, by ASIN).
  async createSalesAndTrafficReport(
    startDate,
    endDate,
    { asinGranularity = 'CHILD', dateGranularity = 'DAY' } = {}
  ) {
    const response = await this.callSpApi({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [this.getMarketplaceId()],
        dataStartTime: startDate,
        dataEndTime: endDate,
        reportOptions: { asinGranularity, dateGranularity },
      },
    });
    return response?.reportId || null;
  }

  async getReportById(reportId) {
    return this.callSpApi({
      operation: 'getReport',
      endpoint: 'reports',
      path: { reportId },
    });
  }

  async getReportDocumentById(reportDocumentId) {
    return this.callSpApi({
      operation: 'getReportDocument',
      endpoint: 'reports',
      path: { reportDocumentId },
    });
  }

  /**
   * Fetch the Sales & Traffic report and aggregate units ordered + page views
   * per ASIN over the given window. Returns a Map<asin, {unitsSold, pageViews}>.
   */
  async fetchSalesAndTrafficByAsin(startDate, endDate, options = {}) {
    const reportId = await this.createSalesAndTrafficReport(startDate, endDate, options);
    if (!reportId) {
      throw new Error('Sales & Traffic report creation did not return a reportId');
    }

    const maxAttempts = parseInt(process.env.SALES_TRAFFIC_POLL_MAX_ATTEMPTS || '60', 10);
    const basePollMs = parseInt(process.env.SALES_TRAFFIC_POLL_INTERVAL_MS || '5000', 10);

    let reportDocumentId = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const report = await this.getReportById(reportId);
      const statusText = String(report?.processingStatus || '').toUpperCase();

      if (statusText === 'DONE') {
        reportDocumentId = report.reportDocumentId;
        break;
      }
      if (statusText === 'CANCELLED' || statusText === 'FATAL') {
        throw new Error(`Sales & Traffic report ${reportId} ended with status ${statusText}`);
      }

      await this.sleep(Math.min(15000, basePollMs + Math.floor(attempt / 5) * 1000));
    }

    if (!reportDocumentId) {
      throw new Error(`Timed out waiting for Sales & Traffic report ${reportId}`);
    }

    const documentInfo = await this.getReportDocumentById(reportDocumentId);
    let content = await this.sellingPartner.download(documentInfo, { json: true });
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (err) {
        throw new Error(`Failed to parse Sales & Traffic report: ${err.message}`);
      }
    }

    return parseSalesAndTrafficByAsin(content);
  }

  aggregateSalesAndTrafficByAsin(report) {
    return parseSalesAndTrafficByAsin(report);
  }

  // Legacy helpers — use notificationsApi.js + notificationService for ORDER_CHANGE.

  // Get full order details
  async getOrderDetails(orderId) {
    try {
      const orderResponse = await this.callSpApi({
        operation: 'getOrder',
        endpoint: 'orders',
        path: {
          orderId,
        },
      });

      const order = orderResponse.Payload || orderResponse;

      // Get order items
      const orderItems = await this.getOrderItems(orderId);

      return {
        amazonOrderId: order.AmazonOrderId,
        sellerOrderId: order.SellerOrderId || '',
        purchaseDate: order.PurchaseDate,
        lastUpdateDate: order.LastUpdateDate,
        orderStatus: order.OrderStatus,
        fulfillmentChannel: order.FulfillmentChannel,
        salesChannel: order.SalesChannel,
        shipServiceLevel: order.ShipServiceLevel,
        shippingAddress: order.ShippingAddress || {},
        orderTotal: order.OrderTotal || {},
        numberOfItemsShipped: order.NumberOfItemsShipped || 0,
        numberOfItemsUnshipped: order.NumberOfItemsUnshipped || 0,
        paymentMethod: order.PaymentMethod,
        paymentMethodDetails: order.PaymentMethodDetails,
        isBusinessOrder: order.IsBusinessOrder || false,
        isPrime: order.IsPrime || false,
        isReplacementOrder: order.IsReplacementOrder || false,
        isGlobalExpressEnabled: order.IsGlobalExpressEnabled || false,
        replacedOrderId: order.ReplacedOrderId,
        isISPU: order.IsISPU || false,
        merchantFulfillmentData: order.MerchantFulfillmentData,
        hasRegulatedItems: order.HasRegulatedItems || false,
        electronicInvoiceStatus: order.ElectronicInvoiceStatus,
        orderItems,
        marketplaceId: order.MarketplaceId,
        buyerEmail: order.BuyerEmail,
        buyerName: order.BuyerName,
        buyerCounty: order.BuyerCounty,
        buyerTaxInfo: order.BuyerTaxInfo,
      };
    } catch (error) {
      console.error('Error fetching order details:', error);
      throw error;
    }
  }

  // Get marketplace ID based on region
  getMarketplaceId() {
    const { preferMarketplaceId } = require('./marketplacePriority');
    return preferMarketplaceId(this.user?.amazonMarketplaceIds, this.user?.marketplace || 'NA');
  }

  getMarketplaceIds() {
    const { sortMarketplaceIds } = require('./marketplacePriority');
    const sorted = sortMarketplaceIds(this.user?.amazonMarketplaceIds, this.user?.marketplace || 'NA');
    if (sorted.length > 0) return sorted;
    return [this.getMarketplaceId()];
  }

  async getFbaInboundShipments({
    lastUpdatedAfter,
    lastUpdatedBefore,
    shipmentStatusList,
    nextToken,
    marketplaceId,
  } = {}) {
    const ALL_FBA_SHIPMENT_STATUSES = [
      'WORKING',
      'SHIPPED',
      'RECEIVING',
      'CANCELLED',
      'DELETED',
      'CLOSED',
      'ERROR',
      'IN_TRANSIT',
      'DELIVERED',
      'CHECKED_IN',
    ];

    try {
      const query = {
        MarketplaceId: marketplaceId || this.getMarketplaceId(),
        QueryType: nextToken ? 'NEXT_TOKEN' : 'DATE_RANGE',
      };

      if (nextToken) {
        query.NextToken = nextToken;
      } else {
        if (lastUpdatedAfter) query.LastUpdatedAfter = lastUpdatedAfter;
        if (lastUpdatedBefore) query.LastUpdatedBefore = lastUpdatedBefore;
        query.ShipmentStatusList =
          shipmentStatusList?.length > 0 ? shipmentStatusList : ALL_FBA_SHIPMENT_STATUSES;
      }

      const response = await this.callSpApi({
        operation: 'getShipments',
        endpoint: 'fulfillmentInbound',
        query,
      });

      return {
        shipments: response.ShipmentData || response.shipmentData || [],
        nextToken: response.NextToken || response.nextToken || null,
      };
    } catch (error) {
      console.error('Error fetching FBA inbound shipments:', error);
      throw error;
    }
  }

  async getFbaShipmentItems(shipmentId, nextToken = null) {
    try {
      const query = { MarketplaceId: this.getMarketplaceId() };
      if (nextToken) query.NextToken = nextToken;

      const response = await this.callSpApi({
        operation: 'getShipmentItemsByShipmentId',
        endpoint: 'fulfillmentInbound',
        path: { shipmentId },
        query,
      });

      return {
        items: response.ItemData || response.itemData || [],
        nextToken: response.NextToken || response.nextToken || null,
      };
    } catch (error) {
      console.error(`Error fetching FBA shipment items for ${shipmentId}:`, error);
      throw error;
    }
  }

  async getFbaTransportDetails(shipmentId) {
    try {
      const response = await this.callSpApi({
        method: 'GET',
        api_path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/transport`,
        restore_rate: 0.5,
      });
      return response.payload || response;
    } catch (error) {
      return null;
    }
  }

  async listFbaInboundPlans({ nextToken, status, sortBy = 'LAST_UPDATED_TIME' } = {}) {
    try {
      const query = { sortBy };
      if (nextToken) query.paginationToken = nextToken;
      if (status) query.status = status;

      const response = await this.callSpApi({
        operation: 'listInboundPlans',
        endpoint: 'fulfillmentInbound',
        query,
        options: { version: '2024-03-20' },
      });

      return {
        plans: response.inboundPlans || [],
        nextToken: response.pagination?.nextToken || null,
      };
    } catch (error) {
      console.warn('Error listing FBA inbound plans:', error.message);
      return { plans: [], nextToken: null };
    }
  }

  async getFbaInboundPlan(inboundPlanId) {
    try {
      const response = await this.callSpApi({
        operation: 'getInboundPlan',
        endpoint: 'fulfillmentInbound',
        path: { inboundPlanId },
        options: { version: '2024-03-20' },
      });
      return response;
    } catch (error) {
      return null;
    }
  }

  async getFbaInboundShipmentV2024(inboundPlanId, shipmentId) {
    try {
      const response = await this.callSpApi({
        operation: 'getShipment',
        endpoint: 'fulfillmentInbound',
        path: { inboundPlanId, shipmentId },
        options: { version: '2024-03-20' },
      });
      return response;
    } catch (error) {
      return null;
    }
  }

  async listAwdInboundShipments({
    nextToken,
    updatedAfter,
    updatedBefore,
    shipmentStatus,
    sortBy = 'UPDATED_AT',
    maxResults = 25,
  } = {}) {
    try {
      const query = { maxResults, sortBy };
      if (nextToken) query.nextToken = nextToken;
      if (updatedAfter) query.updatedAfter = updatedAfter;
      if (updatedBefore) query.updatedBefore = updatedBefore;
      if (shipmentStatus) query.shipmentStatus = shipmentStatus;

      const response = await this.callSpApi({
        operation: 'listInboundShipments',
        endpoint: 'amazonWarehousingAndDistribution',
        query,
      });

      return {
        shipments: response.shipments || [],
        nextToken: response.nextToken || null,
      };
    } catch (error) {
      console.error('Error listing AWD inbound shipments:', error);
      throw error;
    }
  }

  async getAwdInboundShipment(shipmentId) {
    try {
      const response = await this.callSpApi({
        operation: 'getInboundShipment',
        endpoint: 'amazonWarehousingAndDistribution',
        path: { shipmentId },
        query: { skuQuantities: 'SHOW' },
      });
      return response;
    } catch (error) {
      console.error(`Error fetching AWD inbound shipment ${shipmentId}:`, error);
      throw error;
    }
  }
}

module.exports = AmazonAPI;
