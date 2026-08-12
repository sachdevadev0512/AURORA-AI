/** AmazonAPI inventory methods (façade mixins). */
const { createAbortError } = require('./abortError');

module.exports = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  async fetchFbaReimbursementsReport(startDate, endDate) {
    const reportType = 'GET_FBA_REIMBURSEMENTS_DATA';
    const created = await this.createReport(reportType, startDate, endDate);
    const reportId = created?.reportId;
    if (!reportId) {
      throw new Error('FBA reimbursements report creation did not return a reportId');
    }
    const documentInfo = await this.waitForReportDocument(reportId, {
      // Keep this bounded — reimbursements reports often stall/FATAL.
      maxAttempts: parseInt(process.env.REIMBURSEMENTS_REPORT_POLL_MAX_ATTEMPTS || '24', 10),
      basePollMs: 3000,
    });
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  },

  async getFbaReimbursementsForLocatedAdjustments() {
    if (this._fbaReimbursementsCache) return this._fbaReimbursementsCache;

    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 24);

    try {
      const rows = await this.fetchFbaReimbursementsReport(
        start.toISOString(),
        end.toISOString(),
      );
      this._fbaReimbursementsCache = rows;
      console.log(
        `[AmazonAPI] Loaded ${rows.length} FBA reimbursement row(s) for located adjustments`,
      );
      return this._fbaReimbursementsCache;
    } catch (error) {
      console.warn(
        '[AmazonAPI] Single reimbursements pull failed, trying 60-day chunks:',
        error.message,
      );
    }

    const chunkMs = 60 * 24 * 60 * 60 * 1000;
    const rows = [];
    for (let cursor = start.getTime(); cursor < end.getTime(); cursor += chunkMs) {
      const chunkStart = new Date(cursor);
      const chunkEnd = new Date(Math.min(cursor + chunkMs, end.getTime()));
      try {
        const chunk = await this.fetchFbaReimbursementsReport(
          chunkStart.toISOString(),
          chunkEnd.toISOString(),
        );
        if (chunk.length) rows.push(...chunk);
      } catch (error) {
        console.warn(
          `[AmazonAPI] Reimbursements chunk ${chunkStart.toISOString().slice(0, 10)} failed:`,
          error.message,
        );
      }
      await this.sleepInterruptible(2500);
    }

    this._fbaReimbursementsCache = rows;
    console.log(
      `[AmazonAPI] Loaded ${rows.length} FBA reimbursement row(s) for located adjustments`,
    );
    return this._fbaReimbursementsCache;
  },

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
  },

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
  },

  async loadFbaInventoryBySkuMap(options = {}) {
    const { shouldAbort } = options;
    try {
      if (await Promise.resolve(shouldAbort?.())) {
        throw createAbortError();
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
};
