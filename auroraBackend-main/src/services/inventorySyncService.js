const Product = require('../models/Product');
const InventorySyncJob = require('../models/InventorySyncJob');
const {
  parseFeesEstimate,
  hasPriorProductFees,
  diffProductFees,
} = require('../utils/productFeeParser');
const {
  notifyProductFeeChanges,
  applyProductFeeUpdate,
} = require('./productFeeNotificationService');
const User = require('../models/User');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  getWorkerId,
  tryAcquireJobLock,
  renewJobLock,
  releaseJobLock,
  findRemoteActiveJob,
  startLockHeartbeat,
} = require('../utils/syncJobLock');
const readResponseCache = require('../utils/readResponseCache');
const {
  reconcileDeletedListingsWithAmazon,
} = require('./listingReconcileService');
const {
  buildListingPriceUpdate,
  listingPriceFieldsDiffer,
  enrichListingItemForBoundPrices,
  backfillListingBoundPrices,
} = require('./listingPriceBackfillService');
const { backfillClosedListingStatuses } = require('./closedListingStatusService');
const { syncListingDatesFromListingsApi } = require('./listingDatesSyncService');
const {
  money,
  normalizeFulfillmentType,
  getListingSummary,
  getMerchantQuantity,
  parseListingItem,
  isUnchangedProduct,
  reportItemChanged,
  buildListingDatePatch,
} = require('../utils/listingItemParse');
const { mapAmazonListingStatus, parseAmazonOpenDate } = require('../utils/productListingUtils');
const { buildProductDocument } = require('../utils/productDocumentBuilder');
const { runInventoryCpuTask } = require('../utils/cpuWorkerPool');
const { yieldToEventLoop } = require('../utils/eventLoopYield');
const { mergeLiveInventoryOntoFbaItem } = require('../utils/fbaInventoryFields');

const CATALOG_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.INVENTORY_SYNC_CATALOG_CONCURRENCY || '5', 10)
);
const FETCH_CATALOG = process.env.INVENTORY_SYNC_FETCH_CATALOG !== 'false';
const FETCH_LISTINGS = process.env.INVENTORY_SYNC_FETCH_LISTINGS !== 'false';
const FETCH_PRICING = process.env.INVENTORY_SYNC_FETCH_PRICING !== 'false';
// 'reports' (default) sources listings + inventory from Seller Central report files
// (no ~1000-item cap, atomic snapshot). 'listings' and 'fba' remain as fallbacks.
const SYNC_SOURCE = process.env.INVENTORY_SYNC_SOURCE || 'reports';
const REPORT_PAGE_SIZE = Math.max(1, parseInt(process.env.INVENTORY_SYNC_REPORT_PAGE_SIZE || '20', 10));
const EVENT_LOOP_YIELD_EVERY = Math.max(
  1,
  parseInt(process.env.INVENTORY_SYNC_EVENT_LOOP_YIELD_EVERY || '5', 10),
);
const BULK_WRITE_SIZE = Math.max(10, parseInt(process.env.INVENTORY_SYNC_BULK_SIZE || '50', 10));
const PROGRESS_EVERY = Math.max(5, parseInt(process.env.INVENTORY_SYNC_PROGRESS_EVERY || '25', 10));
const SKIP_UNCHANGED = process.env.INVENTORY_SYNC_SKIP_UNCHANGED !== 'false';
const ENRICH_BOUND_PRICES_AT_SYNC_END =
  process.env.INVENTORY_SYNC_ENRICH_BOUND_PRICES !== 'false';
const ENRICH_LISTING_DATES_AT_SYNC_END =
  process.env.INVENTORY_SYNC_ENRICH_LISTING_DATES !== 'false';
const LISTINGS_SEARCH_API_CAP = 1000;
const FBA_SKU_LOOKUP_CHUNK = 50;

const { sleep, mapWithConcurrency: mapWithConcurrencyBase } = require('../utils/async');
const { emitToUser } = require('../utils/socketEmit');
const {
  clearStopFlag,
  refreshStopFromDb,
  createAbortHelpers,
  abortSessionByJobId,
} = require('./sync/persistedJobControl');

function jobToStatus(job) {
  if (!job) {
    return { syncing: false, processed: 0, message: null, startedAt: null };
  }
  const syncing = job.status === 'RUNNING' || job.status === 'STOPPING';
  return {
    syncing,
    processed: job.processed || 0,
    saved: job.saved || 0,
    skipped: job.skipped || 0,
    failed: job.failed || 0,
    totalListings: job.totalListings || null,
    phase: job.phase,
    message: job.message,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    stoppedByUser: job.stoppedByUser || false,
    error: job.error || null,
  };
}

function amazonTimestampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function parseCompetitivePricing(competitivePayload, asin) {
  const entry = (competitivePayload || []).find(
    (row) => row.ASIN === asin || row.asin === asin
  );
  const product = entry?.Product || entry?.product;
  const competitive = product?.CompetitivePricing || product?.competitivePricing;
  const prices = competitive?.CompetitivePrices || competitive?.competitivePrices || [];

  let lowestPrice = 0;
  let featuredOffer = { isBuyBox: false, price: money(0) };

  for (const row of prices) {
    const landed =
      row.Price?.LandedPrice?.Amount ??
      row.price?.landedPrice?.amount ??
      row.Price?.ListingPrice?.Amount ??
      row.price?.listingPrice?.amount;
    const amount = Number(landed);
    if (!Number.isFinite(amount)) continue;
    if (lowestPrice === 0 || amount < lowestPrice) lowestPrice = amount;

    const belongsToRequester = row.belongsToRequester ?? row.BelongsToRequester;
    const condition = String(row.condition || row.Condition || '').toLowerCase();
    if (belongsToRequester && (!condition || condition === 'new')) {
      featuredOffer = {
        isBuyBox: true,
        price: money(amount),
      };
    }
  }

  return {
    lowestPrice: money(lowestPrice),
    featuredOffer,
  };
}

async function recheckProductFeesOnly({ user, amazonAPI, existing, listing, asin, sku }) {
  if (!existing?._id || !FETCH_PRICING || !listing?.price?.amount) return;

  const feesResponse = await amazonAPI.getMyFeesEstimateForSku(
    sku,
    listing.price.amount,
    listing.price.currency,
    listing.fulfillmentType !== 'FBM'
  );
  const fees = parseFeesEstimate(feesResponse);
  await applyProductFeeUpdate(user, existing, fees, {
    notify: true,
    price: listing.price?.amount > 0 ? listing.price : undefined,
  });
}

function reportCell(row, key) {
  if (row == null) return undefined;
  if (row[key] !== undefined) return row[key];
  // Report headers occasionally arrive with surrounding whitespace.
  const match = Object.keys(row).find((k) => k.trim() === key);
  return match ? row[match] : undefined;
}

function reportNumber(row, key) {
  const value = Number(reportCell(row, key));
  return Number.isFinite(value) ? value : 0;
}

// Convert a GET_FBA_MYI_ALL_INVENTORY_DATA row into the fbaItem shape that
// buildProductDocument / isUnchangedProduct already understand.
function parseFbaInventoryReportRow(row) {
  const sellerSku = reportCell(row, 'sku');
  if (!sellerSku) return null;
  return {
    sellerSku,
    asin: reportCell(row, 'asin') || null,
    fnSku: reportCell(row, 'fnsku') || null,
    productName: reportCell(row, 'product-name') || null,
    condition: reportCell(row, 'condition') || null,
    totalQuantity: reportNumber(row, 'afn-total-quantity'),
    lastUpdatedTime: null,
    inventoryDetails: {
      fulfillableQuantity: reportNumber(row, 'afn-fulfillable-quantity'),
      reservedQuantity: {
        totalReservedQuantity: reportNumber(row, 'afn-reserved-quantity'),
      },
      inboundWorkingQuantity: reportNumber(row, 'afn-inbound-working-quantity'),
      inboundShippedQuantity: reportNumber(row, 'afn-inbound-shipped-quantity'),
      inboundReceivingQuantity: reportNumber(row, 'afn-inbound-receiving-quantity'),
      unfulfillableQuantity: {
        totalUnfulfillableQuantity: reportNumber(row, 'afn-unsellable-quantity'),
      },
    },
  };
}

// Convert a GET_MERCHANT_LISTINGS_ALL_DATA row into a listingItem carrying a
// pre-parsed `reportListing` so processListingBatch can skip parseListingItem and
// the per-SKU getListingsItem bound-price probe.
function buildReportListingItem(row, marketplaceId) {
  const sku = reportCell(row, 'seller-sku');
  if (!sku) return { sku: null };

  const asin = reportCell(row, 'asin1') || reportCell(row, 'asin') || null;
  const status = mapAmazonListingStatus(reportCell(row, 'status'));

  // Keep listingStatus in the BUYABLE/DISCOVERABLE vocabulary the rest of the
  // codebase (isBuyableListingStatus, repricer) already relies on.
  const listingStatus = status === 'Active' ? 'BUYABLE, DISCOVERABLE' : 'DISCOVERABLE';

  const fulfillmentChannel = reportCell(row, 'fulfillment-channel') || null;
  const fulfillmentType = normalizeFulfillmentType(fulfillmentChannel);
  const openDateRaw = reportCell(row, 'open-date');
  const openDate = parseAmazonOpenDate(openDateRaw);
  const priceAmount = reportNumber(row, 'price');
  const quantity = reportNumber(row, 'quantity');
  const imageUrl = String(reportCell(row, 'image-url') || '').trim() || null;

  return {
    sku,
    reportListing: {
      listingStatus,
      status,
      imageUrl,
      mainImage: imageUrl ? { link: imageUrl } : null,
      listingCreatedDate: openDate,
      listingLastUpdated: null,
      price: money(priceAmount),
      shippingCost: money(0),
      // Bound prices (min/max/business) come from Listings Items attributes.
      // Leave unset here so mergeMoneyField won't wipe previously backfilled values,
      // and end-of-sync backfillListingBoundPrices can fill missing rows.
      fulfillmentChannel,
      fulfillmentType,
    },
    summaries: [
      {
        marketplaceId,
        asin,
        itemName: reportCell(row, 'item-name') || null,
        conditionType: reportCell(row, 'item-condition') || null,
        createdDate: openDateRaw || null,
        ...(imageUrl ? { mainImage: { link: imageUrl } } : {}),
      },
    ],
    fulfillmentAvailability: [
      { marketplaceId, quantity, fulfillmentChannelCode: fulfillmentChannel },
    ],
  };
}

/** Per-page FBA inventory lookup for listings mode (avoids loading entire catalog into memory). */
class LazyFbaInventoryMap {
  constructor(amazonAPI) {
    this.amazonAPI = amazonAPI;
    /** @type {Map<string, object|null>} */
    this.cache = new Map();
  }

  get(sku) {
    if (!sku || !this.cache.has(sku)) return null;
    return this.cache.get(sku);
  }

  async ensureSkus(skus, shouldAbort) {
    const missing = [...new Set((skus || []).filter((sku) => sku && !this.cache.has(sku)))];
    if (missing.length === 0) return;

    for (let i = 0; i < missing.length; i += FBA_SKU_LOOKUP_CHUNK) {
      if (shouldAbort?.()) return;
      const chunk = missing.slice(i, i + FBA_SKU_LOOKUP_CHUNK);
      const items = await this.amazonAPI.getInventorySummaries(chunk);
      for (const item of items) {
        if (item.sellerSku) this.cache.set(item.sellerSku, item);
      }
      for (const sku of chunk) {
        if (!this.cache.has(sku)) this.cache.set(sku, null);
      }
    }
  }
}

function mapWithConcurrency(items, limit, mapper, shouldAbort) {
  return mapWithConcurrencyBase(items, limit, mapper, shouldAbort, {
    yieldEvery: EVENT_LOOP_YIELD_EVERY,
    yieldFn: yieldToEventLoop,
  });
}

class InventorySyncManager {
  constructor() {
    this.sessions = new Map();
    /** @type {Map<string, boolean>} */
    this.stopFlags = new Map();
  }

  clearStopFlag(userId) {
    clearStopFlag(this.stopFlags, userId);
  }

  async refreshStopFromDb(jobId, userId, abortController) {
    return refreshStopFromDb(InventorySyncJob, this.stopFlags, jobId, userId, abortController);
  }

  createAbortHelpers(userId, abortController, jobId) {
    return createAbortHelpers(
      this.stopFlags,
      userId,
      abortController,
      () => this.refreshStopFromDb(jobId, userId, abortController),
    );
  }

  async getStatus(userId) {
    const session = this.sessions.get(String(userId));
    if (session) return { ...session.status };

    const job = await InventorySyncJob.findOne({
      sellerId: userId,
      status: { $in: ['RUNNING', 'STOPPING'] },
    })
      .sort({ startedAt: -1 })
      .lean();

    return jobToStatus(job);
  }

  async stop(userId) {
    const id = String(userId);
    this.stopFlags.set(id, true);

    const job = await InventorySyncJob.findOneAndUpdate(
      { sellerId: userId, status: { $in: ['RUNNING', 'STOPPING'] } },
      {
        stopRequested: true,
        stoppedByUser: true,
        status: 'STOPPING',
        message: 'Stopping inventory sync…',
        updatedAt: new Date(),
      },
      { new: true }
    );

    if (!job) {
      this.stopFlags.delete(id);
      return { stopped: false, reason: 'not_running', syncing: false, stopping: false };
    }

    const session = this.sessions.get(id);
    const stoppingStatus = {
      ...jobToStatus(job),
      syncing: true,
      stopping: true,
      phase: 'stopping',
      message: 'Stopping inventory sync…',
    };

    if (session) {
      session.abortController.abort();
      Object.assign(session.status, stoppingStatus);
    }

    emitToUser(id, 'inventorySyncStatus', {
      event: 'INVENTORY_SYNC_STOPPING',
      ...stoppingStatus,
    });

    return {
      stopped: true,
      processed: session?.status?.processed ?? job.processed ?? 0,
      stopping: true,
      syncing: true,
      message: 'Stopping inventory sync…',
    };
  }

  async start(userId) {
    const id = String(userId);
    const existing = this.sessions.get(id);
    if (existing) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...existing.status,
        message: existing.status.message || 'Inventory sync already in progress',
      };
    }

    const user = await User.findById(id);
    if (!user?.amazonRefreshToken) {
      const error = new Error('Amazon SP-API credentials not configured');
      error.code = 'SP_NOT_CONNECTED';
      throw error;
    }

    if (SYNC_SOURCE !== 'fba' && !user.amazonSellerId) {
      const error = new Error(
        'Amazon seller ID is required to sync all listings (FBA + FBM). Reconnect your Amazon account.'
      );
      error.code = 'SELLER_ID_REQUIRED';
      throw error;
    }

    let job = await InventorySyncJob.findOne({
      sellerId: user._id,
      status: 'RUNNING',
      stopRequested: false,
    }).sort({ startedAt: -1 });

    const remoteActive = await findRemoteActiveJob(InventorySyncJob, user._id);
    if (remoteActive) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...jobToStatus(remoteActive),
        message: 'Inventory sync already in progress on another server instance.',
      };
    }

    if (!job) {
      try {
        job = await InventorySyncJob.create({
          sellerId: user._id,
          status: 'RUNNING',
          phase: 'starting',
          message: 'Starting inventory sync…',
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        job = await InventorySyncJob.findOne({
          sellerId: user._id,
          status: 'RUNNING',
          stopRequested: false,
        }).sort({ startedAt: -1 });
      }
    } else {
      console.log(`[InventorySync] Resuming existing job ${job._id} for user ${id}`);
    }

    if (!job) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        message: 'Inventory sync already in progress on another server instance.',
      };
    }

    const claimed = await tryAcquireJobLock(InventorySyncJob, job._id);
    if (!claimed) {
      const active = await findRemoteActiveJob(InventorySyncJob, user._id);
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...(active ? jobToStatus(active) : {}),
        message: 'Inventory sync already in progress on another server instance.',
      };
    }

    return this._launchSession(user, claimed);
  }

  async resumeJob(job) {
    const user = await User.findById(job.sellerId);
    if (!user?.amazonRefreshToken) {
      await releaseJobLock(InventorySyncJob, job._id).catch(() => {});
      await InventorySyncJob.findByIdAndUpdate(job._id, {
        status: 'FAILED',
        error: 'Amazon SP-API credentials not configured',
        message: 'Inventory sync failed: credentials missing',
        lockedBy: null,
        lockExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      return;
    }

    const id = String(user._id);
    if (this.sessions.has(id)) return;

    const claimed = await tryAcquireJobLock(InventorySyncJob, job._id);
    if (!claimed) {
      console.log(
        `[InventorySync] Skipping resume for job ${job._id} — held by another instance (${job.lockedBy || 'unknown'})`
      );
      return;
    }

    console.log(
      `[InventorySync] Auto-resuming job ${claimed._id} for user ${id} on ${getWorkerId()} (processed: ${claimed.processed || 0})`
    );
    await this._launchSession(user, claimed);
  }

  _launchSession(user, job) {
    const id = String(user._id);
    this.clearStopFlag(id);
    const abortController = new AbortController();
    const status = { ...jobToStatus(job), syncing: true };

    const promise = this.runSync(user, abortController, status, job)
      .catch((err) => {
        console.error(`[InventorySync] Background job error for ${id}:`, err.message);
      })
      .finally(() => {
        this.sessions.delete(id);
        releaseJobLock(InventorySyncJob, job._id).catch((err) => {
          console.warn(`[InventorySync] Failed to release lock for job ${job._id}:`, err.message);
        });
      });

    this.sessions.set(id, {
      abortController,
      promise,
      status,
      jobId: String(job._id),
    });

    emitToUser(id, 'inventorySyncStatus', {
      event: job.processed > 0 ? 'INVENTORY_SYNC_PROGRESS' : 'INVENTORY_SYNC_STARTED',
      ...status,
    });

    return {
      success: true,
      syncing: true,
      resumed: (job.processed || 0) > 0,
      message:
        job.processed > 0
          ? `Resuming inventory sync from ${job.processed} item(s). Runs on the server — safe to close this tab.`
          : 'Inventory sync started on the server. You can close this tab — progress is saved and resumes after server restart.',
      ...status,
    };
  }

  updateStatus(userId, status, patch) {
    Object.assign(status, patch);
    emitToUser(String(userId), 'inventorySyncStatus', {
      event: 'INVENTORY_SYNC_PROGRESS',
      ...status,
    });
  }

  abortSessionByJobId(jobId) {
    abortSessionByJobId(this.sessions, jobId);
  }

  async persistJob(jobId, status, checkpoint = null, userId = null, abortController = null, lockGeneration = null) {
    if (userId && abortController) {
      const stopped = await this.refreshStopFromDb(jobId, userId, abortController);
      if (stopped) {
        this.abortSessionByJobId(jobId);
        return false;
      }
    }

    const renewed = await renewJobLock(
      InventorySyncJob,
      jobId,
      getWorkerId(),
      lockGeneration,
    );
    if (!renewed) {
      console.warn(`[InventorySync] Lost lock on job ${jobId}; aborting local session`);
      this.abortSessionByJobId(jobId);
      return false;
    }

    const patch = {
      processed: status.processed || 0,
      saved: status.saved || 0,
      skipped: status.skipped || 0,
      failed: status.failed || 0,
      totalListings: status.totalListings ?? null,
      phase: status.phase,
      message: status.message,
      error: status.error || null,
      stoppedByUser: status.stoppedByUser || false,
      updatedAt: new Date(),
    };
    if (checkpoint) patch.checkpoint = checkpoint;
    await InventorySyncJob.findByIdAndUpdate(jobId, patch);
    return true;
  }

  recordBulkWriteResult(status, result, counters) {
    if (!result || result.failed === 0) return;

    counters.totalFailed += result.failed;
    counters.totalSaved = Math.max(0, counters.totalSaved - result.failed);
    status.failed = counters.totalFailed;
    status.saved = counters.totalSaved;

    for (const failure of result.failures.slice(0, 5)) {
      console.warn(
        `[InventorySync] Bulk write failed for SKU ${failure.sku}: ${failure.message}`
      );
    }
    if (result.failures.length > 5) {
      console.warn(
        `[InventorySync] Bulk write partial errors: ${result.failures.length} total`
      );
    }

    const sample = result.failures
      .slice(0, 3)
      .map((f) => `${f.sku} (${f.message})`)
      .join('; ');
    status.error = `Database write failed for ${result.failed} SKU(s): ${sample}`;
  }

  async flushBulkOps(bulkOps) {
    if (bulkOps.length === 0) {
      return { failed: 0, failures: [], attempted: 0 };
    }

    const opsSnapshot = bulkOps.slice();
    const attempted = opsSnapshot.length;

    try {
      await Product.bulkWrite(bulkOps, { ordered: false, runValidators: true });
      bulkOps.length = 0;
      return { failed: 0, failures: [], attempted };
    } catch (err) {
      const writeErrors = err.writeErrors || err.result?.writeErrors || [];
      bulkOps.length = 0;

      if (!writeErrors.length) {
        throw err;
      }

      const failures = writeErrors.map((we) => {
        const op = opsSnapshot[we.index];
        const filter = op?.updateOne?.filter || op?.replaceOne?.filter || {};
        return {
          sku: filter.sku || 'unknown',
          message: we.errmsg || we.message || String(we),
        };
      });

      return { failed: failures.length, failures, attempted };
    }
  }

  async finalizeJob(jobId, status, finalStatus) {
    status.syncing = false;
    await InventorySyncJob.findByIdAndUpdate(jobId, {
      status: finalStatus,
      processed: status.processed || 0,
      saved: status.saved || 0,
      skipped: status.skipped || 0,
      failed: status.failed || 0,
      totalListings: status.totalListings ?? null,
      phase: status.phase,
      message: status.message,
      error: status.error || null,
      stoppedByUser: status.stoppedByUser || false,
      lockedBy: null,
      lockExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async runSync(user, abortController, status, job) {
    const userId = String(user._id);
    const jobId = String(job._id);
    const { shouldAbort, shouldAbortAsync } = this.createAbortHelpers(
      userId,
      abortController,
      jobId
    );
    const lockGeneration = Number(job.lockGeneration) || 0;
    const persist = (checkpoint = null) =>
      this.persistJob(jobId, status, checkpoint, userId, abortController, lockGeneration);
    const stopHeartbeat = startLockHeartbeat(
      InventorySyncJob,
      jobId,
      getWorkerId(),
      lockGeneration,
      () => abortController.abort(),
    );

    try {
      const sellerAppCredentials = await getSellerAppCredentials(user._id);
      // Persist preferred marketplace order so reporting/API stay US-first for NA.
      try {
        const { sortMarketplaceIds } = require('../utils/marketplacePriority');
        const sorted = sortMarketplaceIds(
          user.amazonMarketplaceIds || [],
          user.marketplace || 'NA',
        );
        if (
          sorted.length > 0 &&
          JSON.stringify(sorted) !== JSON.stringify(user.amazonMarketplaceIds || [])
        ) {
          await User.findByIdAndUpdate(user._id, { amazonMarketplaceIds: sorted });
          user.amazonMarketplaceIds = sorted;
          console.log(
            `[InventorySync] Prefer marketplace ${sorted[0]} for seller ${userId}`,
          );
        }
      } catch (sortErr) {
        console.warn('[InventorySync] marketplace prefer failed:', sortErr.message);
      }

      const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
      amazonAPI.setSpApiOptions({ shouldAbort, label: `seller:${userId}:inventory` });

      let totalProcessed = job.processed || 0;
      let totalSkipped = job.skipped || 0;
      let totalFailed = job.failed || 0;
      let totalSaved = job.saved || 0;

      status.processed = totalProcessed;
      status.skipped = totalSkipped;
      status.failed = totalFailed;
      status.saved = totalSaved;

      let nextToken = null;
      if (SYNC_SOURCE === 'fba') {
        if (!job.checkpoint?.phase || job.checkpoint.phase === 'fba') {
          nextToken = job.checkpoint?.nextToken || null;
        }
      } else if (job.checkpoint?.phase === 'listings') {
        nextToken = job.checkpoint?.nextToken || null;
      }
      const bulkOps = [];
      let listingsPartialCap = false;
      const flushBulk = async () => {
        const result = await this.flushBulkOps(bulkOps);
        this.recordBulkWriteResult(status, result, {
          get totalSaved() {
            return totalSaved;
          },
          set totalSaved(v) {
            totalSaved = v;
          },
          get totalFailed() {
            return totalFailed;
          },
          set totalFailed(v) {
            totalFailed = v;
          },
        });
      };
      const catalogCache = new Map();
      const syncedSkus = new Set();
      let totalListings = status.totalListings || null;

      const marketplaceId = amazonAPI.getMarketplaceId();

      const getCatalogCached = async (asin) => {
        if (!FETCH_CATALOG || !asin) return null;
        if (!catalogCache.has(asin)) {
          catalogCache.set(
            asin,
            amazonAPI.getCatalogItem(asin).catch(() => null)
          );
        }
        return catalogCache.get(asin);
      };

      const buildProgressMessage = (suffix = '') => {
        const parts = [`Processed ${totalProcessed} SKU(s)`];
        if (totalListings) parts.unshift(`${totalListings} listings in Seller Central`);
        if (totalSaved > 0) parts.push(`${totalSaved} saved`);
        if (totalSkipped > 0) parts.push(`${totalSkipped} unchanged skipped`);
        if (totalFailed > 0) parts.push(`${totalFailed} failed`);
        return `${parts.join(' — ')}${suffix}`;
      };

      const processListingBatch = async (listingItems, fbaBySku) => {
        const skus = listingItems.map((i) => i.sku).filter(Boolean);
        if (typeof fbaBySku.ensureSkus === 'function') {
          await fbaBySku.ensureSkus(skus, shouldAbort);
        }
        const existingProducts = skus.length
          ? await Product.find(
              { sellerId: user._id, sku: { $in: skus } },
              {
                sku: 1,
                asin: 1,
                status: 1,
                title: 1,
                images: 1,
                listingCreatedDate: 1,
                lastUpdatedTime: 1,
                inventoryManualOverrideAt: 1,
                inventory: 1,
                price: 1,
                minimumPrice: 1,
                maximumPrice: 1,
                businessPrice: 1,
                shippingCost: 1,
                unitsSold: 1,
                pageViews: 1,
              }
            ).lean()
          : [];
        const existingMap = new Map(existingProducts.map((p) => [p.sku, p]));

        let competitiveByAsin = new Map();
        if (FETCH_PRICING) {
          const pageAsins = [
            ...new Set(
              listingItems
                .map((listingItem) => {
                  const summary = getListingSummary(listingItem, marketplaceId);
                  const fbaItem = fbaBySku.get(listingItem.sku);
                  return fbaItem?.asin || summary?.asin;
                })
                .filter(Boolean)
            ),
          ];
          if (pageAsins.length > 0) {
            const competitivePayload = await amazonAPI.getCompetitivePricing(pageAsins);
            for (const asin of pageAsins) {
              competitiveByAsin.set(asin, parseCompetitivePricing(competitivePayload, asin));
            }
          }
        }

        return mapWithConcurrency(
          listingItems,
          CATALOG_CONCURRENCY,
          async (listingItem) => {
            if (shouldAbort()) return null;
            const sku = listingItem.sku;
            if (!sku) return { failed: true };

            try {
              const listingSummary = getListingSummary(listingItem, marketplaceId);
              const fbaItem = fbaBySku.get(sku) || null;
              const asin = fbaItem?.asin || listingSummary?.asin;
              if (!asin) {
                console.warn(`[InventorySync] SKU ${sku}: missing ASIN, skipped`);
                return { failed: true };
              }

              const existing = existingMap.get(sku);
              let listing;
              if (listingItem.reportListing) {
                listing = listingItem.reportListing;
              } else {
                const listingItemForPrices = await enrichListingItemForBoundPrices(
                  amazonAPI,
                  listingItem,
                  existing,
                  marketplaceId
                );
                listing = parseListingItem(listingItemForPrices, marketplaceId);
              }

              if (listingItem.reportListing) {
                if (
                  existing &&
                  !reportItemChanged(existing, listing, fbaItem, listingItem, marketplaceId)
                ) {
                  syncedSkus.add(sku);
                  const datePatch = buildListingDatePatch(existing, listing, fbaItem);
                  if (datePatch) {
                    return {
                      bulkOp: {
                        updateOne: {
                          filter: { sellerId: user._id, sku },
                          update: { $set: datePatch },
                        },
                      },
                    };
                  }
                  return { skipped: true };
                }
              } else if (
                SKIP_UNCHANGED &&
                !existing?.inventoryManualOverrideAt &&
                isUnchangedProduct(fbaItem, listingItem, existing, marketplaceId) &&
                existing?.images?.length
              ) {
                syncedSkus.add(sku);
                try {
                  await recheckProductFeesOnly({
                    user,
                    amazonAPI,
                    existing,
                    listing,
                    asin,
                    sku,
                  });
                } catch (feeErr) {
                  console.warn(`[InventorySync] Live fee check for ${sku}:`, feeErr.message);
                }

                const datePatch = buildListingDatePatch(existing, listing, fbaItem);
                const priceUpdate = listingPriceFieldsDiffer(existing, listing)
                  ? buildListingPriceUpdate(existing, listing)
                  : null;
                if (priceUpdate || datePatch) {
                  return {
                    bulkOp: {
                      updateOne: {
                        filter: { sellerId: user._id, sku },
                        update: {
                          $set: {
                            ...(priceUpdate || {}),
                            ...(datePatch || {}),
                            updatedAt: new Date(),
                          },
                        },
                      },
                    },
                  };
                }

                return { skipped: true };
              }

              const catalogItem = await getCatalogCached(asin);
              const pricing = competitiveByAsin.get(asin) || {};

              let fees = {
                totalFees: money(0),
                fbaFee: money(0),
                breakdown: [],
              };
              if (FETCH_PRICING && listing.price?.amount > 0) {
                const feesResponse = await amazonAPI.getMyFeesEstimateForSku(
                  sku,
                  listing.price.amount,
                  listing.price.currency,
                  listing.fulfillmentType !== 'FBM'
                );
                fees = parseFeesEstimate(feesResponse);
              }

              if (existing?._id && hasPriorProductFees(existing)) {
                const feeChanges = diffProductFees(existing, fees);
                if (feeChanges.length > 0) {
                  await notifyProductFeeChanges(
                    user._id,
                    {
                      _id: existing._id,
                      asin,
                      sku,
                      title: existing.title,
                      fees,
                    },
                    feeChanges
                  );
                }
              }

              const productData = await runInventoryCpuTask(
                'buildProductDocument',
                {
                  sellerId: user._id,
                  fbaItem,
                  catalogItem,
                  extras: {
                    marketplaceId,
                    listing,
                    listingItem,
                    pricing,
                    fees,
                    feesLastSynced: new Date(),
                    existing,
                  },
                },
                () => buildProductDocument(user._id, fbaItem, catalogItem, {
                  marketplaceId,
                  listing,
                  listingItem,
                  pricing,
                  fees,
                  feesLastSynced: new Date(),
                  existing,
                }),
              );

              syncedSkus.add(sku);
              return {
                bulkOp: {
                  updateOne: {
                    filter: { sellerId: user._id, sku },
                    update: { $set: productData },
                    upsert: true,
                  },
                },
              };
            } catch (err) {
              console.error(`[InventorySync] SKU ${sku}:`, err.message);
              return { failed: true };
            }
          },
          shouldAbort
        );
      };

      const applyPageResults = async (pageResults) => {
        for (const result of pageResults) {
          if (!result) continue;
          if (result.skipped) {
            totalSkipped += 1;
            totalProcessed += 1;
            continue;
          }
          if (result.failed) {
            totalFailed += 1;
            totalProcessed += 1;
            continue;
          }
          if (result.bulkOp) {
            bulkOps.push(result.bulkOp);
            totalSaved += 1;
            totalProcessed += 1;
          }
        }

        status.processed = totalProcessed;
        status.skipped = totalSkipped;
        status.failed = totalFailed;
        status.saved = totalSaved;
        status.totalListings = totalListings;

        if (bulkOps.length >= BULK_WRITE_SIZE) {
          await flushBulk();
          if (shouldAbort()) return;
        }
      };

      if (SYNC_SOURCE === 'fba') {
        this.updateStatus(userId, status, {
          phase: 'syncing',
          message:
            totalProcessed > 0
              ? `Resuming FBA inventory sync at ${totalProcessed} SKU(s)…`
              : 'Syncing FBA inventory from Amazon…',
        });
        await persist();

        do {
          if (await shouldAbortAsync()) break;

          const { items, nextToken: newToken } = await amazonAPI.getInventorySummariesPage(nextToken);

          const listingItems = items.map((fbaItem) => ({
            sku: fbaItem.sellerSku,
            summaries: [
              {
                marketplaceId,
                asin: fbaItem.asin,
                fnSku: fbaItem.fnSku,
                itemName: fbaItem.productName,
                conditionType: fbaItem.condition,
                lastUpdatedDate: fbaItem.lastUpdatedTime,
              },
            ],
          }));
          const fbaBySku = new Map(items.filter((i) => i.sellerSku).map((i) => [i.sellerSku, i]));
          const pageResults = await processListingBatch(listingItems, fbaBySku);
          await applyPageResults(pageResults);

          nextToken = newToken;
          status.message = buildProgressMessage();
          await persist({ phase: 'fba', nextToken });

          if (items.length > 0) {
            console.log(
              `[InventorySync] FBA page: ${items.length} items, ${totalSaved} saved (total ${totalProcessed})`
            );
          }
        } while (nextToken);
      } else if (SYNC_SOURCE === 'reports') {
        this.updateStatus(userId, status, {
          phase: 'loading_fba',
          message: 'Requesting FBA inventory report from Amazon…',
        });
        await persist();

        const fbaBySku = new Map();
        const fbaLoad = await amazonAPI.loadFbaInventoryBySkuMap({ shouldAbort });
        if (fbaLoad.source === 'report') {
          for (const row of fbaLoad.rows || []) {
            const item = parseFbaInventoryReportRow(row);
            if (item?.sellerSku) fbaBySku.set(item.sellerSku, item);
          }
          console.log(`[InventorySync] FBA inventory report: ${fbaBySku.size} SKU(s)`);

          // MYI report lags Seller Central Manage Inventory. Overlay live
          // FBA Inventory API quantities (and lastUpdatedTime) so Available /
          // Inbound / Reserved match what the seller sees in SC.
          this.updateStatus(userId, status, {
            phase: 'loading_fba',
            message: 'Refreshing FBA quantities from live inventory API…',
          });
          await persist();
          try {
            let nextToken = null;
            let enriched = 0;
            let added = 0;
            do {
              if (await shouldAbortAsync()) break;
              const page = await amazonAPI.getInventorySummariesPage(nextToken);
              for (const live of page.items || []) {
                if (!live?.sellerSku) continue;
                const existing = fbaBySku.get(live.sellerSku);
                if (existing) {
                  fbaBySku.set(
                    live.sellerSku,
                    mergeLiveInventoryOntoFbaItem(existing, live)
                  );
                  enriched += 1;
                } else {
                  fbaBySku.set(live.sellerSku, live);
                  added += 1;
                }
              }
              nextToken = page.nextToken;
            } while (nextToken);
            console.log(
              `[InventorySync] Live FBA overlay: updated ${enriched} SKU(s), added ${added} not in MYI report`,
            );
          } catch (enrichErr) {
            console.warn(
              '[InventorySync] Live FBA quantity overlay skipped (report quantities may lag Seller Central):',
              enrichErr.message,
            );
          }
        } else {
          for (const item of fbaLoad.items || []) {
            if (item?.sellerSku) fbaBySku.set(item.sellerSku, item);
          }
          status.message =
            `FBA report unavailable — using live inventory API (${fbaBySku.size} SKU(s)). ` +
            'Continuing with All Listings report…';
          console.warn(`[InventorySync] ${status.message}`);
          this.updateStatus(userId, status, { message: status.message });
          await persist();
        }

        this.updateStatus(userId, status, {
          phase: 'syncing',
          message: 'Requesting All Listings report from Seller Central…',
        });
        await persist();

        const listingRows = await amazonAPI.fetchAllListingsReport();
        const rows = listingRows.filter((row) => reportCell(row, 'seller-sku'));
        totalListings = rows.length;
        status.totalListings = totalListings;
        console.log(`[InventorySync] All Listings report: ${totalListings} listing(s)`);

        this.updateStatus(userId, status, {
          phase: 'syncing',
          message: 'Syncing listings + inventory from Seller Central reports (FBA + FBM)…',
        });

        for (let start = 0; start < rows.length; start += REPORT_PAGE_SIZE) {
          if (await shouldAbortAsync()) break;

          const pageRows = rows.slice(start, start + REPORT_PAGE_SIZE);
          const listingItems = pageRows
            .map((row) => buildReportListingItem(row, marketplaceId))
            .filter((item) => item.sku);

          const pageResults = await processListingBatch(listingItems, fbaBySku);
          await applyPageResults(pageResults);

          status.message = buildProgressMessage();
          await persist({
            phase: 'reports',
            index: start + REPORT_PAGE_SIZE,
          });

          if (totalProcessed > 0 && totalProcessed % PROGRESS_EVERY === 0) {
            this.updateStatus(userId, status, { message: status.message });
          }
        }

        if (!shouldAbort()) {
          await reconcileDeletedListingsWithAmazon(
            user,
            amazonAPI,
            syncedSkus,
            bulkOps,
            shouldAbort,
            { skipWhenIncomplete: listingsPartialCap },
          );
        }
      } else {
        this.updateStatus(userId, status, {
          phase: 'syncing',
          message:
            totalProcessed > 0
              ? `Resuming listings sync at ${totalProcessed} SKU(s)…`
              : 'Syncing all listings from Seller Central (FBA + FBM)…',
        });
        await persist();

        const fbaBySku = new LazyFbaInventoryMap(amazonAPI);

        do {
          if (await shouldAbortAsync()) break;

          const { items, nextToken: newToken, numberOfResults } =
            await amazonAPI.searchListingsItemsPage(nextToken);

          if (totalListings == null && numberOfResults > 0) {
            totalListings = numberOfResults;
            status.totalListings = totalListings;
            if (totalListings > LISTINGS_SEARCH_API_CAP) {
              listingsPartialCap = true;
              status.partial = true;
              status.error =
                `Seller has ${totalListings} listings but searchListingsItems returns at most ` +
                `${LISTINGS_SEARCH_API_CAP} per sync. Set INVENTORY_SYNC_SOURCE=reports for full catalog.`;
              console.warn(`[InventorySync] ${status.error}`);
            }
          }

          const pageResults = await processListingBatch(items, fbaBySku);
          await applyPageResults(pageResults);

          nextToken = newToken;
          status.message = buildProgressMessage();
          await persist({ phase: 'listings', nextToken });

          if (items.length > 0) {
            console.log(
              `[InventorySync] Listings page: ${items.length} items, ${totalSaved} saved (total ${totalProcessed}/${totalListings || '?'})`
            );
          }

          if (totalProcessed > 0 && totalProcessed % PROGRESS_EVERY === 0) {
            this.updateStatus(userId, status, { message: status.message });
          }
        } while (nextToken);

        if (!shouldAbort()) {
          await reconcileDeletedListingsWithAmazon(
            user,
            amazonAPI,
            syncedSkus,
            bulkOps,
            shouldAbort,
            { skipWhenIncomplete: listingsPartialCap },
          );
        }
      }

      await flushBulk();

      // If another worker stole the lock mid-sync, do not claim success with
      // inflated in-memory counters (queued ops that never flushed).
      if (shouldAbort()) {
        status.phase = 'stopped';
        status.stoppedByUser = true;
        status.message = `Inventory sync stopped. ${totalProcessed} SKU(s) processed.`;
        await this.finalizeJob(jobId, status, 'STOPPED');
        emitToUser(userId, 'inventorySyncComplete', {
          event: 'INVENTORY_SYNC_STOPPED',
          ...status,
        });
        return { stopped: true, processed: totalProcessed };
      }

      // Sanity-check: never mark COMPLETED if nothing landed in Mongo for an empty catalog.
      if (totalSaved > 0) {
        const written = await Product.countDocuments({ sellerId: user._id });
        if (written === 0) {
          throw new Error(
            `Inventory sync reported ${totalSaved} saved but MongoDB has 0 products for this seller. ` +
              'Likely a lock race or bulkWrite failure — retry Sync inventory.',
          );
        }
      }

      if (listingsPartialCap && !shouldAbort()) {
        status.partial = true;
        status.message =
          `Partial sync: processed ${totalProcessed} of ${totalListings} listing(s) ` +
          `(SP-API cap ${LISTINGS_SEARCH_API_CAP}). ` +
          'Use INVENTORY_SYNC_SOURCE=reports for a full catalog sync.';
        if (!status.error) status.error = status.message;
      }

      status.phase = 'complete';
      status.message = listingsPartialCap && !shouldAbort()
        ? status.message
        : `Synced ${totalSaved} SKU(s) — ${totalProcessed} processed.`;
      await this.finalizeJob(jobId, status, 'COMPLETED');
      readResponseCache.invalidateSeller('products:list', userId);
      emitToUser(userId, 'inventorySyncComplete', {
        event: 'INVENTORY_SYNC_COMPLETE',
        ...status,
      });

      try {
        const appNotificationService = require('./appNotificationService');
        await appNotificationService.createNotification(userId, {
          source: 'aurora',
          type: 'inventory_sync',
          title: 'Aurora: Inventory synced',
          message: status.message,
          link: '/products',
          metadata: { processed: totalProcessed, saved: totalSaved },
        });
      } catch (notifyErr) {
        console.warn('[InventorySync] Inbox notification failed:', notifyErr.message);
      }

      if (ENRICH_BOUND_PRICES_AT_SYNC_END) {
        try {
          status.phase = 'enriching_prices';
          status.message = 'Backfilling min/max/business prices from Amazon…';
          await persist();
          emitToUser(userId, 'inventorySyncProgress', {
            event: 'INVENTORY_SYNC_PROGRESS',
            ...status,
          });

          const priceResult = await backfillListingBoundPrices({
            sellerId: user._id,
            amazonAPI,
            marketplaceId,
            shouldAbort,
            onProgress: ({ idx, total }) => {
              if (idx > 0 && idx % 100 === 0) {
                console.log(`[InventorySync] Bound price backfill ${idx}/${total}`);
              }
            },
          });
          console.log('[InventorySync] Bound price backfill:', priceResult);
          if (priceResult.updated > 0) {
            status.message = `Synced ${totalSaved} SKU(s) — ${totalProcessed} processed. Updated listing prices for ${priceResult.updated} SKU(s).`;
            emitToUser(userId, 'inventorySyncComplete', {
              event: 'INVENTORY_SYNC_COMPLETE',
              ...status,
            });
          }
        } catch (priceErr) {
          console.warn('[InventorySync] Bound price backfill failed:', priceErr.message);
        }
      }

      if (ENRICH_LISTING_DATES_AT_SYNC_END && !shouldAbort()) {
        try {
          status.phase = 'enriching_listing_dates';
          status.message = 'Refreshing listing created / last update dates from Amazon…';
          await persist();
          emitToUser(userId, 'inventorySyncProgress', {
            event: 'INVENTORY_SYNC_PROGRESS',
            ...status,
          });
          const datesResult = await syncListingDatesFromListingsApi({
            user,
            amazonAPI,
            shouldAbort,
            mode: 'search_and_get_missing',
            useLedger: true,
          });
          console.log('[InventorySync] Listing dates refresh:', datesResult);
        } catch (datesErr) {
          console.warn('[InventorySync] Listing dates refresh failed:', datesErr.message);
        }
      }

      if (process.env.CLOSED_STATUS_BACKFILL_ENABLED !== 'false') {
        try {
          status.phase = 'enriching_closed_status';
          status.message = 'Detecting Closed listings from Amazon offer windows…';
          await persist();
          emitToUser(userId, 'inventorySyncProgress', {
            event: 'INVENTORY_SYNC_PROGRESS',
            ...status,
          });

          const closedResult = await backfillClosedListingStatuses({
            sellerId: user._id,
            amazonAPI,
            marketplaceId,
            shouldAbort,
            onProgress: ({ idx, total }) => {
              if (idx > 0 && idx % 100 === 0) {
                console.log(`[InventorySync] Closed status backfill ${idx}/${total}`);
              }
            },
          });
          console.log('[InventorySync] Closed status backfill:', closedResult);
          if (closedResult.updated > 0) {
            status.message = `${status.message} Marked ${closedResult.updated} listing(s) Closed.`;
            readResponseCache.invalidateSeller('products:list', userId);
            emitToUser(userId, 'inventorySyncComplete', {
              event: 'INVENTORY_SYNC_COMPLETE',
              ...status,
            });
          }
        } catch (closedErr) {
          console.warn('[InventorySync] Closed status backfill failed:', closedErr.message);
        }
      }

      if (process.env.SALES_TRAFFIC_SYNC_ENABLED !== 'false') {
        try {
          const { enrichSalesAndTraffic } = require('./salesTrafficSyncService');
          status.phase = 'enriching_sales_traffic';
          status.message = 'Updating Units Sold and Page Views from Sales & Traffic…';
          await persist();
          emitToUser(userId, 'inventorySyncProgress', {
            event: 'INVENTORY_SYNC_PROGRESS',
            ...status,
          });

          const stResult = await enrichSalesAndTraffic(user, {});
          console.log('[InventorySync] Sales & traffic enrichment:', stResult);
          if (stResult?.success && stResult.updated > 0) {
            status.message = `${status.message} Updated sales & traffic for ${stResult.asins || stResult.updated} ASIN(s).`;
            emitToUser(userId, 'inventorySyncComplete', {
              event: 'INVENTORY_SYNC_COMPLETE',
              ...status,
            });
          } else if (stResult?.success && stResult.asins === 0) {
            console.warn(
              `[InventorySync] Sales & traffic report returned 0 ASINs for ${user.email || userId}`,
            );
          }
        } catch (stErr) {
          console.warn('[InventorySync] Sales & traffic enrichment failed:', stErr.message);
        }
      }

      if (process.env.FBA_AGED_INVENTORY_SYNC_ENABLED !== 'false') {
        try {
          const { syncFbaAgedInventoryFees } = require('./fbaAgedInventorySyncService');
          const result = await syncFbaAgedInventoryFees(user, {});
          console.log('[InventorySync] FBA aged inventory fees:', result);
        } catch (agedErr) {
          console.warn('[InventorySync] FBA aged inventory fee sync failed:', agedErr.message);
        }
      }

      if (process.env.FBA_INBOUND_PLACEMENT_SYNC_ENABLED !== 'false') {
        // Finances listTransactions can take several minutes on busy sellers.
        // Don't block inventory sync — refresh placement fees in the background.
        const { syncFbaInboundPlacementFees } = require('./fbaInboundPlacementSyncService');
        const forcePlacement = process.env.FBA_INBOUND_PLACEMENT_FORCE === 'true';
        Promise.resolve()
          .then(() => syncFbaInboundPlacementFees(user, { force: forcePlacement }))
          .then((result) => {
            console.log('[InventorySync] FBA inbound placement fees:', result);
          })
          .catch((placementErr) => {
            console.warn(
              '[InventorySync] FBA inbound placement fee sync failed:',
              placementErr.message,
            );
          });
      }

      return { success: true, processed: totalProcessed, saved: totalSaved };
    } catch (error) {
      status.phase = 'error';
      status.error = error.message;
      status.message = `Inventory sync failed: ${error.message}`;
      await this.finalizeJob(jobId, status, 'FAILED');
      emitToUser(userId, 'inventorySyncError', {
        event: 'INVENTORY_SYNC_ERROR',
        ...status,
      });
      console.error(`[InventorySync] Failed for ${userId}:`, error.message);
      return { success: false, error: error.message };
    } finally {
      stopHeartbeat();
    }
  }
}

const inventorySyncManager = new InventorySyncManager();

async function resumeInterruptedInventorySyncJobs() {
  const staleStopping = await InventorySyncJob.updateMany(
    { status: 'STOPPING' },
    {
      status: 'STOPPED',
      message: 'Inventory sync stopped.',
      lockedBy: null,
      lockExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }
  );
  if (staleStopping.modifiedCount > 0) {
    console.log(
      `[InventorySync] Marked ${staleStopping.modifiedCount} stale stopping job(s) as stopped`
    );
  }

  const jobs = await InventorySyncJob.find({
    status: 'RUNNING',
    stopRequested: { $ne: true },
  }).sort({ startedAt: 1 });

  for (const job of jobs) {
    try {
      await inventorySyncManager.resumeJob(job);
    } catch (err) {
      console.error(`[InventorySync] Failed to resume job ${job._id}:`, err.message);
      await releaseJobLock(InventorySyncJob, job._id).catch(() => {});
      await InventorySyncJob.findByIdAndUpdate(job._id, {
        status: 'FAILED',
        error: err.message,
        message: `Resume failed: ${err.message}`,
        lockedBy: null,
        lockExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

module.exports = {
  inventorySyncManager,
  resumeInterruptedInventorySyncJobs,
  FETCH_CATALOG,
};
