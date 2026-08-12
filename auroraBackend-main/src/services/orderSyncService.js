const Order = require('../models/Order');
const User = require('../models/User');
const OrderSyncJob = require('../models/OrderSyncJob');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');

const { parseFlatFileOrdersReport } = require('../utils/orderReportParser');
const { computeItemFees, loadSellerFeeMap } = require('../utils/orderItemFees');
const { normalizeOrderStatus, normalizeFulfillmentChannel } = require('../utils/normalizeOrderStatus');
const { syncCustomerReturns } = require('./customerReturnsService');
const { syncCustomerRefunds } = require('./customerRefundsService');
const {
  getWorkerId,
  tryAcquireJobLock,
  renewJobLock,
  releaseJobLock,
  findRemoteActiveJob,
  startLockHeartbeat,
} = require('../utils/syncJobLock');

const ORDER_SYNC_STRATEGY = (process.env.ORDER_SYNC_STRATEGY || 'report').toLowerCase();
const ORDER_CONCURRENCY = Math.max(
  3,
  parseInt(process.env.ORDER_SYNC_CONCURRENCY || '25', 10)
);
const ITEM_CONCURRENCY = Math.max(
  3,
  parseInt(process.env.ORDER_SYNC_ITEM_CONCURRENCY || '25', 10)
);
const FETCH_CATALOG = process.env.ORDER_SYNC_FETCH_CATALOG === 'true';
const BULK_WRITE_SIZE = Math.max(10, parseInt(process.env.ORDER_SYNC_BULK_SIZE || '50', 10));
const PROGRESS_EVERY = Math.max(25, parseInt(process.env.ORDER_SYNC_PROGRESS_EVERY || '100', 10));
const REPORT_CHUNK_DAYS = Math.max(
  7,
  parseInt(process.env.ORDER_SYNC_REPORT_CHUNK_DAYS || '30', 10)
);
const REPORT_CHUNK_DELAY_MS = Math.max(
  0,
  parseInt(process.env.ORDER_SYNC_REPORT_CHUNK_DELAY_MS || '3000', 10)
);

const { sleep, mapWithConcurrency } = require('../utils/async');
const { emitToUser } = require('../utils/socketEmit');
const {
  clearStopFlag,
  refreshStopFromDb,
  createAbortHelpers,
  abortSessionByJobId,
} = require('./sync/persistedJobControl');

function isAbortError(error) {
  return error?.code === 'SYNC_ABORTED' || error?.message === 'Sync aborted';
}

async function interruptibleSleep(ms, shouldAbort, stepMs = 400) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) {
      const error = new Error('Sync aborted');
      error.code = 'SYNC_ABORTED';
      throw error;
    }
    await sleep(Math.min(stepMs, Math.max(0, deadline - Date.now())));
  }
}

function normalizeMoney(money, fallbackCurrency = 'USD') {
  if (!money) {
    return { amount: 0, currencyCode: fallbackCurrency };
  }
  return {
    amount: Number(money.amount ?? money.Amount ?? 0),
    currencyCode: money.currencyCode ?? money.CurrencyCode ?? fallbackCurrency,
  };
}

function normalizeDate(value) {
  return value ? new Date(value) : null;
}

function normalizeAddress(address) {
  if (!address) return null;
  return {
    name: address.name ?? address.Name ?? '',
    addressLine1: address.addressLine1 ?? address.AddressLine1 ?? '',
    addressLine2: address.addressLine2 ?? address.AddressLine2 ?? '',
    addressLine3: address.addressLine3 ?? address.AddressLine3 ?? '',
    city: address.city ?? address.City ?? '',
    county: address.county ?? address.County ?? '',
    district: address.district ?? address.District ?? '',
    stateOrRegion: address.stateOrRegion ?? address.StateOrRegion ?? '',
    municipality: address.municipality ?? address.Municipality ?? '',
    postalCode: address.postalCode ?? address.PostalCode ?? '',
    countryCode: address.countryCode ?? address.CountryCode ?? '',
    phone: address.phone ?? address.Phone ?? '',
    addressType: address.addressType ?? address.AddressType ?? '',
  };
}

function normalizePromotionIds(promotionIds) {
  if (!promotionIds) return [];
  if (Array.isArray(promotionIds)) return promotionIds.filter(Boolean);
  return String(promotionIds)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function getMarketplaceName(marketplaceId) {
  const marketplaces = {
    ATVPDKIKX0DER: 'Amazon.com',
    A2EUQ1WTGCTBG2: 'Amazon.ca',
    A1AM78C64UM0Y8: 'Amazon.mx',
  };
  return marketplaces[marketplaceId] || 'Unknown Marketplace';
}

function buildOrderDocument(sellerId, amazonOrder, processedOrderItems) {
  const currency = amazonOrder.OrderTotal?.CurrencyCode || 'USD';

  return {
    sellerId,
    amazonOrderId: amazonOrder.AmazonOrderId,
    sellerOrderId: amazonOrder.SellerOrderId,
    purchaseDate: new Date(amazonOrder.PurchaseDate),
    lastUpdateDate: normalizeDate(amazonOrder.LastUpdateDate),
    orderStatus: normalizeOrderStatus(amazonOrder.OrderStatus),
    fulfillmentChannel: normalizeFulfillmentChannel(amazonOrder.FulfillmentChannel),
    salesChannel: amazonOrder.SalesChannel,
    orderChannel: amazonOrder.OrderChannel,
    shipServiceLevel: amazonOrder.ShipServiceLevel,
    shipmentServiceLevelCategory: amazonOrder.ShipmentServiceLevelCategory,
    orderTotal: normalizeMoney(amazonOrder.OrderTotal, currency),
    numberOfItemsShipped: amazonOrder.NumberOfItemsShipped,
    numberOfItemsUnshipped: amazonOrder.NumberOfItemsUnshipped,
    paymentExecutionDetail: (amazonOrder.PaymentExecutionDetail || []).map((detail) => ({
      payment: normalizeMoney(detail.Payment, currency),
      paymentMethod: detail.PaymentMethod,
    })),
    paymentMethod: amazonOrder.PaymentMethod,
    paymentMethodDetails: amazonOrder.PaymentMethodDetails,
    marketplaceId: amazonOrder.MarketplaceId,
    marketplaceName: getMarketplaceName(amazonOrder.MarketplaceId),
    buyerEmail: amazonOrder.BuyerInfo?.BuyerEmail,
    buyerName: amazonOrder.BuyerInfo?.BuyerName,
    buyerCounty: amazonOrder.ShippingAddress?.County || amazonOrder.BuyerInfo?.BuyerCounty || '',
    buyerTaxInfo: amazonOrder.BuyerTaxInfo,
    shippingAddress: normalizeAddress(amazonOrder.ShippingAddress),
    orderItems: processedOrderItems,
    isBusinessOrder: amazonOrder.IsBusinessOrder,
    isPrime: amazonOrder.IsPrime,
    isPremiumOrder: amazonOrder.IsPremiumOrder,
    isGlobalExpressEnabled: amazonOrder.IsGlobalExpressEnabled,
    isSoldByAB: amazonOrder.IsSoldByAB,
    isIBA: amazonOrder.IsIBA,
    isReplacementOrder: amazonOrder.IsReplacementOrder,
    replacedOrderId: amazonOrder.ReplacedOrderId,
    promiseResponseDueDate: normalizeDate(amazonOrder.PromiseResponseDueDate),
    isEstimatedShipDateSet: amazonOrder.IsEstimatedShipDateSet,
    isSoldBySeller: amazonOrder.IsSoldBySeller,
    defaultShipFromLocationAddress: normalizeAddress(amazonOrder.DefaultShipFromLocationAddress),
    lastSynced: new Date(),
  };
}

async function processOrderItem(item, amazonOrder, feeMap, getCatalogItemCached) {
  const currency = amazonOrder.OrderTotal?.CurrencyCode || 'USD';
  const itemPrice = normalizeMoney(item.ItemPrice, currency);
  const quantity = item.QuantityOrdered || 1;
  const channel = String(amazonOrder.FulfillmentChannel || '').toUpperCase();
  const isFba = channel.includes('AFN') || channel.includes('AMAZON');
  const itemFees = computeItemFees(
    {
      sku: item.SellerSKU,
      quantity,
      lineTotal: itemPrice.amount,
      currency: itemPrice.currencyCode,
      isFba,
    },
    feeMap,
  );
  const catalogItem = await getCatalogItemCached(item.ASIN);

  return {
    asin: item.ASIN,
    sellerSku: item.SellerSKU,
    title: item.Title,
    itemStatus: item.ItemStatus || amazonOrder.OrderStatus,
    quantityOrdered: item.QuantityOrdered,
    quantityShipped: item.QuantityShipped || 0,
    itemPrice,
    itemTax: normalizeMoney(item.ItemTax, itemPrice.currencyCode),
    shippingPrice: normalizeMoney(item.ShippingPrice, itemPrice.currencyCode),
    shippingTax: normalizeMoney(item.ShippingTax, itemPrice.currencyCode),
    promotionDiscount: normalizeMoney(item.PromotionDiscount, itemPrice.currencyCode),
    promotionIds: normalizePromotionIds(item.PromotionIds),
    codFee: normalizeMoney(item.CODFee, itemPrice.currencyCode),
    codFeeDiscount: normalizeMoney(item.CODFeeDiscount, itemPrice.currencyCode),
    isGift: item.IsGift,
    conditionId: item.ConditionId,
    conditionSubtypeId: item.ConditionSubtypeId,
    fnsku: item.FulfillmentNetworkSKU || item.FulfillmentNetworkSku || null,
    productImage: extractCatalogImage(catalogItem),
    referralFee: itemFees.referralFee,
    fulfillmentFee: itemFees.fulfillmentFee,
    costOfGoodsSold: itemFees.costOfGoodsSold,
    itemSubtotal: {
      amount: itemPrice.amount,
      currencyCode: itemPrice.currencyCode,
    },
  };
}

function extractCatalogImage(catalogItem) {
  const imageSets = catalogItem?.images || [];
  for (const imageSet of imageSets) {
    if (Array.isArray(imageSet?.images) && imageSet.images.length > 0) {
      const firstImage = imageSet.images[0];
      if (firstImage?.link) return firstImage.link;
    }
  }
  return null;
}

async function ensureOrderSyncMarketplaceContext(user, sellerAppCredentials) {
  if (Array.isArray(user.amazonMarketplaceIds) && user.amazonMarketplaceIds.length > 0) {
    return user;
  }

  const regions = [...new Set([user.marketplace, 'NA', 'EU', 'FE'].filter(Boolean))];

  for (const region of regions) {
    try {
      const amazonAPI = new AmazonAPI(
        { amazonRefreshToken: user.amazonRefreshToken, marketplace: region },
        sellerAppCredentials
      );

      const response = await amazonAPI.callSpApi({
        operation: 'getMarketplaceParticipations',
        endpoint: 'sellers',
      });

      const participations = response?.payload || response?.marketplaceParticipations || response || [];
      const marketplaceIds = Array.isArray(participations)
        ? participations
            .map(
              (p) => p?.marketplace?.id || p?.Marketplace?.Id || p?.marketplaceId
            )
            .filter(Boolean)
        : [];

      if (marketplaceIds.length > 0) {
        const { sortMarketplaceIds } = require('../utils/marketplacePriority');
        const sortedIds = sortMarketplaceIds(marketplaceIds, region);
        await User.findByIdAndUpdate(user._id, {
          marketplace: region,
          amazonMarketplaceIds: sortedIds,
        });
        return { ...user.toObject(), marketplace: region, amazonMarketplaceIds: sortedIds };
      }
    } catch (error) {
      console.warn('[OrderSync] Marketplace discovery failed:', region, error.message);
    }
  }

  return user;
}

function jobToStatus(job) {
  if (!job) {
    return { syncing: false, stopping: false, processed: 0, message: null, startedAt: null };
  }
  const stopping = job.status === 'STOPPING';
  const syncing = job.status === 'RUNNING' || stopping;
  return {
    syncing,
    stopping,
    processed: job.processed || 0,
    phase: job.phase,
    message: job.message,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    startDate: job.startDate ? job.startDate.toISOString() : null,
    endDate: job.endDate ? job.endDate.toISOString() : null,
    stoppedByUser: job.stoppedByUser || false,
    error: job.error || null,
  };
}

function resolveOrderSyncDateRange(options = {}) {
  const latestAllowedEndDate = new Date(Date.now() - 2 * 60 * 1000);
  const retentionDays = 730;
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - retentionDays);

  let startDate = options.startDate ? new Date(options.startDate) : defaultStartDate;
  if (startDate < defaultStartDate) startDate = defaultStartDate;

  const requestedEndDate = options.endDate ? new Date(options.endDate) : new Date();
  const endDate =
    requestedEndDate > latestAllowedEndDate ? latestAllowedEndDate : requestedEndDate;

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid startDate or endDate');
  }
  if (startDate > endDate) {
    throw new Error('Start date must be earlier than end date');
  }

  return { startDate, endDate };
}

class OrderSyncManager {
  constructor() {
    /** @type {Map<string, { abortController: AbortController, promise: Promise, status: object }>} */
    this.sessions = new Map();
    /** @type {Map<string, boolean>} */
    this.stopFlags = new Map();
  }

  clearStopFlag(userId) {
    clearStopFlag(this.stopFlags, userId);
  }

  async refreshStopFromDb(jobId, userId, abortController) {
    return refreshStopFromDb(OrderSyncJob, this.stopFlags, jobId, userId, abortController);
  }

  createAbortHelpers(userId, abortController, jobId) {
    return createAbortHelpers(
      this.stopFlags,
      userId,
      abortController,
      () => this.refreshStopFromDb(jobId, userId, abortController),
    );
  }

  getStatus(userId) {
    const id = String(userId);
    const session = this.sessions.get(id);
    if (session) return { ...session.status };

    return OrderSyncJob.findOne({
      sellerId: userId,
      status: { $in: ['RUNNING', 'STOPPING'] },
    })
      .sort({ startedAt: -1 })
      .lean()
      .then(jobToStatus);
  }

  async stop(userId) {
    const id = String(userId);
    this.stopFlags.set(id, true);

    const job = await OrderSyncJob.findOneAndUpdate(
      { sellerId: userId, status: { $in: ['RUNNING', 'STOPPING'] } },
      {
        stopRequested: true,
        stoppedByUser: true,
        status: 'STOPPING',
        message: 'Stopping order sync…',
        updatedAt: new Date(),
      },
      { new: true },
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
      message: 'Stopping order sync…',
    };

    if (session) {
      session.abortController.abort();
      Object.assign(session.status, stoppingStatus);
    }

    emitToUser(id, 'orderSyncStatus', {
      event: 'ORDER_SYNC_STOPPING',
      ...stoppingStatus,
    });

    return {
      stopped: true,
      processed: session?.status?.processed ?? job.processed ?? 0,
      stopping: true,
      syncing: true,
      message: 'Stopping order sync…',
    };
  }

  async start(userId, options = {}) {
    const id = String(userId);
    const existing = this.sessions.get(id);
    if (existing) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...existing.status,
        message: existing.status.message || 'Order sync already in progress',
      };
    }

    const user = await User.findById(id);
    if (!user?.amazonRefreshToken) {
      const error = new Error('Amazon SP-API credentials not configured');
      error.code = 'SP_NOT_CONNECTED';
      throw error;
    }

    const { startDate, endDate } = resolveOrderSyncDateRange(options);

    const remoteActive = await findRemoteActiveJob(OrderSyncJob, user._id);
    if (remoteActive) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...jobToStatus(remoteActive),
        message: 'Order sync already in progress on another server instance.',
      };
    }

    let job = await OrderSyncJob.findOne({
      sellerId: user._id,
      status: 'RUNNING',
      stopRequested: false,
    }).sort({ startedAt: -1 });

    if (!job) {
      try {
        job = await OrderSyncJob.create({
          sellerId: user._id,
          status: 'RUNNING',
          phase: 'starting',
          message: 'Starting order sync…',
          startDate,
          endDate,
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        job = await OrderSyncJob.findOne({
          sellerId: user._id,
          status: 'RUNNING',
          stopRequested: false,
        }).sort({ startedAt: -1 });
      }
    } else {
      console.log(`[OrderSync] Resuming existing job ${job._id} for user ${id}`);
    }

    if (!job) {
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        message: 'Order sync already in progress on another server instance.',
      };
    }

    const claimed = await tryAcquireJobLock(OrderSyncJob, job._id);
    if (!claimed) {
      const active = await findRemoteActiveJob(OrderSyncJob, user._id);
      return {
        success: true,
        syncing: true,
        alreadyRunning: true,
        ...(active ? jobToStatus(active) : {}),
        message: 'Order sync already in progress on another server instance.',
      };
    }

    return this._launchSession(user, claimed);
  }

  async resumeJob(job) {
    const user = await User.findById(job.sellerId);
    if (!user?.amazonRefreshToken) {
      await releaseJobLock(OrderSyncJob, job._id).catch(() => {});
      await OrderSyncJob.findByIdAndUpdate(job._id, {
        status: 'FAILED',
        error: 'Amazon SP-API credentials not configured',
        message: 'Order sync failed: credentials missing',
        lockedBy: null,
        lockExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      return;
    }

    const id = String(user._id);
    if (this.sessions.has(id)) return;

    const claimed = await tryAcquireJobLock(OrderSyncJob, job._id);
    if (!claimed) {
      console.log(
        `[OrderSync] Skipping resume for job ${job._id} — held by another instance (${job.lockedBy || 'unknown'})`
      );
      return;
    }

    console.log(
      `[OrderSync] Auto-resuming job ${claimed._id} for user ${id} on ${getWorkerId()} (processed: ${claimed.processed || 0})`
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
        console.error(`[OrderSync] Background job error for ${id}:`, err.message);
      })
      .finally(() => {
        this.sessions.delete(id);
        releaseJobLock(OrderSyncJob, job._id).catch((err) => {
          console.warn(`[OrderSync] Failed to release lock for job ${job._id}:`, err.message);
        });
      });

    this.sessions.set(id, {
      abortController,
      promise,
      status,
      jobId: String(job._id),
      lockGeneration: Number(job.lockGeneration) || 0,
    });

    emitToUser(id, 'orderSyncStatus', {
      event: (job.processed || 0) > 0 ? 'ORDER_SYNC_PROGRESS' : 'ORDER_SYNC_STARTED',
      ...status,
    });

    return {
      success: true,
      syncing: true,
      resumed: (job.processed || 0) > 0,
      message:
        (job.processed || 0) > 0
          ? `Resuming order sync from ${job.processed} order(s). Runs on the server — safe to close this tab.`
          : 'Order sync started on the server. You can close this tab — progress is saved and resumes after server restart.',
      ...status,
    };
  }

  updateStatus(userId, status, patch) {
    if (this.stopFlags.get(String(userId))) {
      return;
    }
    Object.assign(status, patch);
    emitToUser(String(userId), 'orderSyncStatus', {
      event: 'ORDER_SYNC_PROGRESS',
      ...status,
    });
  }

  abortSessionByJobId(jobId) {
    abortSessionByJobId(this.sessions, jobId);
  }

  async persistJob(jobId, status, checkpoint = null) {
    let userIdForStop = null;
    let abortController = null;
    let lockGeneration = null;

    for (const [userId, session] of this.sessions.entries()) {
      if (session.jobId === String(jobId)) {
        userIdForStop = userId;
        abortController = session.abortController;
        lockGeneration = session.lockGeneration ?? null;
        break;
      }
    }

    if (userIdForStop && abortController) {
      const stopped = await this.refreshStopFromDb(jobId, userIdForStop, abortController);
      if (stopped || abortController.signal.aborted) {
        this.abortSessionByJobId(jobId);
        return false;
      }
    } else {
      const job = await OrderSyncJob.findById(jobId).select('stopRequested status').lean();
      if (job?.stopRequested || job?.status === 'STOPPING') {
        this.abortSessionByJobId(jobId);
        return false;
      }
    }

    const renewed = await renewJobLock(
      OrderSyncJob,
      jobId,
      getWorkerId(),
      lockGeneration,
    );
    if (!renewed) {
      console.warn(`[OrderSync] Lost lock on job ${jobId}; aborting local session`);
      this.abortSessionByJobId(jobId);
      return false;
    }

    const patch = {
      processed: status.processed || 0,
      phase: status.phase,
      message: status.message,
      error: status.error || null,
      stoppedByUser: status.stoppedByUser || false,
      updatedAt: new Date(),
    };
    if (checkpoint) patch.checkpoint = checkpoint;
    await OrderSyncJob.findByIdAndUpdate(jobId, patch);
    return true;
  }

  async finalizeJob(jobId, status, finalStatus) {
    status.syncing = false;
    await OrderSyncJob.findByIdAndUpdate(jobId, {
      status: finalStatus,
      processed: status.processed || 0,
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

  async flushBulkOps(bulkOps) {
    if (bulkOps.length === 0) return;
    try {
      await Order.bulkWrite(bulkOps, { ordered: false });
    } catch (err) {
      const writeErrors = err.writeErrors || err.result?.writeErrors;
      if (writeErrors?.length) {
        console.warn(`[OrderSync] Bulk write partial errors: ${writeErrors.length}`);
      } else {
        throw err;
      }
    }
    bulkOps.length = 0;
  }

  async runSync(user, abortController, status, job) {
    if (ORDER_SYNC_STRATEGY === 'api') {
      return this.runApiSync(user, abortController, status, job);
    }
    return this.runReportSync(user, abortController, status, job);
  }

  async completeSyncSuccess(userId, jobId, status, totalProcessed) {
    status.syncing = false;
    status.stopping = false;
    status.phase = 'complete';
    status.message = `Synced ${totalProcessed} order(s) successfully.`;
    this.clearStopFlag(userId);
    await this.finalizeJob(jobId, status, 'COMPLETED');
    emitToUser(userId, 'orderSyncComplete', {
      event: 'ORDER_SYNC_COMPLETE',
      ...status,
    });

    try {
      const appNotificationService = require('./appNotificationService');
      await appNotificationService.createNotification(userId, {
        source: 'aurora',
        type: 'orders_sync',
        title: 'Aurora: Orders synced',
        message: status.message,
        link: '/orders',
        metadata: { processed: totalProcessed },
      });
    } catch (notifyErr) {
      console.warn('[OrderSync] Inbox notification failed:', notifyErr.message);
    }

    return { success: true, processed: totalProcessed };
  }

  async completeSyncStopped(userId, jobId, status, totalProcessed) {
    status.syncing = false;
    status.stopping = false;
    status.phase = 'stopped';
    status.stoppedByUser = true;
    status.message = `Sync stopped. ${totalProcessed} order(s) synced before stop.`;
    this.clearStopFlag(userId);
    await this.finalizeJob(jobId, status, 'STOPPED');
    emitToUser(userId, 'orderSyncComplete', {
      event: 'ORDER_SYNC_STOPPED',
      ...status,
    });
    return { stopped: true, processed: totalProcessed };
  }

  async completeSyncError(userId, jobId, status, error) {
    status.syncing = false;
    status.phase = 'error';
    status.error = error.message;
    status.message = `Order sync failed: ${error.message}`;
    await this.finalizeJob(jobId, status, 'FAILED');
    emitToUser(userId, 'orderSyncError', {
      event: 'ORDER_SYNC_ERROR',
      ...status,
    });
    console.error(`[OrderSync] Failed for ${userId}:`, error.message);
    throw error;
  }

  async runReportSync(user, abortController, status, job) {
    const userId = String(user._id);
    const jobId = String(job._id);
    const lockGeneration = Number(job.lockGeneration) || 0;
    const stopHeartbeat = startLockHeartbeat(
      OrderSyncJob,
      jobId,
      getWorkerId(),
      lockGeneration,
      () => abortController.abort(),
    );
    const { shouldAbort, shouldAbortAsync } = this.createAbortHelpers(userId, abortController, jobId);

    try {
      const sellerAppCredentials = await getSellerAppCredentials(user._id);
      const userForAmazon = await ensureOrderSyncMarketplaceContext(user, sellerAppCredentials);
      const amazonAPI = new AmazonAPI(userForAmazon, sellerAppCredentials);
      amazonAPI.setSpApiOptions({ shouldAbort, label: `seller:${userId}:orders-report` });

      const startDate = new Date(job.startDate);
      const endDate = new Date(job.endDate);
      let totalProcessed = job.processed || 0;
      status.processed = totalProcessed;

      let currentStart = job.checkpoint?.currentChunkStart
        ? new Date(job.checkpoint.currentChunkStart)
        : new Date(startDate);

      const bulkOps = [];
      const feeMap = await loadSellerFeeMap(user._id);

      this.updateStatus(userId, status, {
        phase: 'syncing',
        message: `Fast report sync from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}…`,
      });
      await this.persistJob(jobId, status);

      while (currentStart < endDate) {
        if (await shouldAbortAsync()) break;

        const currentEnd = new Date(currentStart);
        currentEnd.setDate(currentEnd.getDate() + REPORT_CHUNK_DAYS);
        if (currentEnd > endDate) currentEnd.setTime(endDate.getTime());

        this.updateStatus(userId, status, {
          phase: 'report',
          message: `Downloading order report ${currentStart.toISOString().slice(0, 10)} → ${currentEnd.toISOString().slice(0, 10)}…`,
        });

        const rows = await amazonAPI.fetchFlatFileOrdersByOrderDateReport(
          currentStart.toISOString(),
          currentEnd.toISOString(),
          { shouldAbort: shouldAbortAsync },
        );

        const orders = parseFlatFileOrdersReport(rows, user._id, feeMap);
        for (const orderData of orders) {
          if (shouldAbort()) break;

          bulkOps.push({
            updateOne: {
              filter: {
                amazonOrderId: orderData.amazonOrderId,
                sellerId: user._id,
              },
              update: { $set: orderData },
              upsert: true,
            },
          });

          totalProcessed += 1;
          status.processed = totalProcessed;

          if (bulkOps.length >= BULK_WRITE_SIZE) {
            await this.flushBulkOps(bulkOps);
          }

          if (totalProcessed % PROGRESS_EVERY === 0) {
            this.updateStatus(userId, status, {
              message: `Synced ${totalProcessed} order(s) via report…`,
            });
            await this.persistJob(jobId, status, {
              currentChunkStart: currentStart,
              currentChunkEnd: currentEnd,
              nextToken: null,
            });
          }
        }

        await this.flushBulkOps(bulkOps);

        currentStart = new Date(currentEnd);
        currentStart.setSeconds(currentStart.getSeconds() + 1);

        await this.persistJob(jobId, status, {
          currentChunkStart: currentStart,
          currentChunkEnd: null,
          nextToken: null,
        });

        if (REPORT_CHUNK_DELAY_MS > 0 && currentStart < endDate) {
          await interruptibleSleep(REPORT_CHUNK_DELAY_MS, shouldAbort);
        }
      }

      await this.flushBulkOps(bulkOps);

      if (shouldAbort()) {
        return this.completeSyncStopped(userId, jobId, status, totalProcessed);
      }

      try {
        this.updateStatus(userId, status, {
          phase: 'returns',
          message: 'Syncing FBA customer returns…',
        });
        // Returns are keyed by return-date, not purchase-date — always pull a
        // full lookback so older purchases that returned recently are marked.
        const returnsEnd = endDate || new Date();
        const returnsStart = new Date(returnsEnd);
        returnsStart.setUTCDate(returnsStart.getUTCDate() - 365);
        await syncCustomerReturns(user, amazonAPI, returnsStart, returnsEnd);
      } catch (returnsError) {
        console.warn(`[OrderSync] FBA returns sync skipped for ${userId}:`, returnsError.message);
      }

      // Refunds via listTransactions (includes DEFERRED "Refund applied" that
      // Finances v0 omits). Run in background so order sync isn't blocked.
      Promise.resolve()
        .then(() => syncCustomerRefunds(user, amazonAPI))
        .then((stats) => {
          console.log(
            `[OrderSync] Refund sync for ${userId}: events=${stats?.refundEventCount || 0} updated=${stats?.updatedOrders || 0}`,
          );
        })
        .catch((refundsError) => {
          console.warn(`[OrderSync] Refund sync skipped for ${userId}:`, refundsError.message);
        });

      return this.completeSyncSuccess(userId, jobId, status, totalProcessed);
    } catch (error) {
      if (isAbortError(error) || shouldAbort()) {
        return this.completeSyncStopped(userId, jobId, status, status.processed || 0);
      }
      return this.completeSyncError(userId, jobId, status, error);
    } finally {
      stopHeartbeat();
    }
  }

  async runApiSync(user, abortController, status, job) {
    const userId = String(user._id);
    const jobId = String(job._id);
    const lockGeneration = Number(job.lockGeneration) || 0;
    const stopHeartbeat = startLockHeartbeat(
      OrderSyncJob,
      jobId,
      getWorkerId(),
      lockGeneration,
      () => abortController.abort(),
    );
    const { shouldAbort, shouldAbortAsync } = this.createAbortHelpers(userId, abortController, jobId);

    try {
      const sellerAppCredentials = await getSellerAppCredentials(user._id);
      const userForAmazon = await ensureOrderSyncMarketplaceContext(user, sellerAppCredentials);
      const amazonAPI = new AmazonAPI(userForAmazon, sellerAppCredentials);
      amazonAPI.setSpApiOptions({ shouldAbort, label: `seller:${userId}:orders-api` });

      const startDate = new Date(job.startDate);
      const endDate = new Date(job.endDate);

      const MAX_RANGE_DAYS = 180;
      const catalogCache = new Map();
      const catalogMissCache = new Set();

      const getCatalogItemCached = async (asin) => {
        if (!FETCH_CATALOG || !asin) return null;
        if (catalogMissCache.has(asin)) return null;
        if (!catalogCache.has(asin)) {
          catalogCache.set(
            asin,
            amazonAPI.getCatalogItem(asin).catch(() => {
              catalogMissCache.add(asin);
              return null;
            })
          );
        }
        return catalogCache.get(asin);
      };

      let totalProcessed = job.processed || 0;
      status.processed = totalProcessed;

      let currentStart = job.checkpoint?.currentChunkStart
        ? new Date(job.checkpoint.currentChunkStart)
        : new Date(startDate);
      let resumeNextToken = job.checkpoint?.nextToken || null;
      let resumeChunkEnd = job.checkpoint?.currentChunkEnd
        ? new Date(job.checkpoint.currentChunkEnd)
        : null;

      const bulkOps = [];
      const feeMap = await loadSellerFeeMap(user._id);

      this.updateStatus(userId, status, {
        phase: 'syncing',
        message: `Syncing orders from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}…`,
      });
      await this.persistJob(jobId, status);

      while (currentStart < endDate) {
        if (await shouldAbortAsync()) break;

        let currentEnd = resumeChunkEnd;
        if (!currentEnd) {
          currentEnd = new Date(currentStart);
          currentEnd.setDate(currentEnd.getDate() + MAX_RANGE_DAYS);
          if (currentEnd > endDate) currentEnd = endDate;
        }

        let nextToken = resumeNextToken;
        resumeNextToken = null;
        resumeChunkEnd = null;

        let safetyCounter = 0;
        const MAX_PAGES_PER_CHUNK = 10000;

        do {
          if (shouldAbort()) break;

          let response;
          response = await amazonAPI.getOrders(
            currentStart.toISOString(),
            currentEnd.toISOString(),
            nextToken
          );

          const orders = response?.orders || response?.Orders || [];
          nextToken = response?.nextToken || response?.NextToken || null;

          await mapWithConcurrency(
            orders,
            ORDER_CONCURRENCY,
            async (amazonOrder) => {
              if (shouldAbort()) return null;

              try {
                const orderItems = await amazonAPI.getOrderItems(amazonOrder.AmazonOrderId);
                if (!orderItems?.length) {
                  console.warn(
                    `[OrderSync] No items returned for ${amazonOrder.AmazonOrderId} — skipping to avoid wiping existing data`
                  );
                  return null;
                }

                const processedOrderItems = (
                  await Promise.all(
                    orderItems.map(async (item) => {
                      try {
                        return await processOrderItem(
                          item,
                          amazonOrder,
                          feeMap,
                          getCatalogItemCached
                        );
                      } catch {
                        return null;
                      }
                    })
                  )
                ).filter(Boolean);

                if (processedOrderItems.length === 0) {
                  console.warn(
                    `[OrderSync] Failed to process items for ${amazonOrder.AmazonOrderId} — skipping`
                  );
                  return null;
                }

                const orderData = buildOrderDocument(user._id, amazonOrder, processedOrderItems);

                bulkOps.push({
                  updateOne: {
                    filter: {
                      amazonOrderId: amazonOrder.AmazonOrderId,
                      sellerId: user._id,
                    },
                    update: { $set: orderData },
                    upsert: true,
                  },
                });

                totalProcessed += 1;
                status.processed = totalProcessed;

                if (bulkOps.length >= BULK_WRITE_SIZE) {
                  await this.flushBulkOps(bulkOps);
                }

                if (totalProcessed % PROGRESS_EVERY === 0) {
                  this.updateStatus(userId, status, {
                    message: `Synced ${totalProcessed} order(s)…`,
                  });
                  await this.persistJob(jobId, status, {
                    currentChunkStart: currentStart,
                    currentChunkEnd: currentEnd,
                    nextToken,
                  });
                }

                return orderData;
              } catch (err) {
                console.error(`[OrderSync] Order ${amazonOrder.AmazonOrderId}:`, err.message);
                return null;
              }
            },
            shouldAbort
          );

          await this.flushBulkOps(bulkOps);

          await this.persistJob(jobId, status, {
            currentChunkStart: currentStart,
            currentChunkEnd: currentEnd,
            nextToken,
          });

          safetyCounter += 1;
          if (safetyCounter > MAX_PAGES_PER_CHUNK) break;
        } while (nextToken);

        currentStart = new Date(currentEnd);
        currentStart.setSeconds(currentStart.getSeconds() + 1);

        await this.persistJob(jobId, status, {
          currentChunkStart: currentStart,
          currentChunkEnd: null,
          nextToken: null,
        });
      }

      await this.flushBulkOps(bulkOps);

      if (shouldAbort()) {
        return this.completeSyncStopped(userId, jobId, status, totalProcessed);
      }

      try {
        this.updateStatus(userId, status, {
          phase: 'returns',
          message: 'Syncing FBA customer returns…',
        });
        const returnsEnd = new Date();
        const returnsStart = new Date(returnsEnd);
        returnsStart.setUTCDate(returnsStart.getUTCDate() - 365);
        await syncCustomerReturns(user, amazonAPI, returnsStart, returnsEnd);
      } catch (returnsError) {
        console.warn(`[OrderSync] FBA returns sync skipped for ${userId}:`, returnsError.message);
      }

      // Refunds via listTransactions (includes DEFERRED "Refund applied" that
      // Finances v0 omits). Run in background so order sync isn't blocked.
      Promise.resolve()
        .then(() => syncCustomerRefunds(user, amazonAPI))
        .then((stats) => {
          console.log(
            `[OrderSync] Refund sync for ${userId}: events=${stats?.refundEventCount || 0} updated=${stats?.updatedOrders || 0}`,
          );
        })
        .catch((refundsError) => {
          console.warn(`[OrderSync] Refund sync skipped for ${userId}:`, refundsError.message);
        });

      return this.completeSyncSuccess(userId, jobId, status, totalProcessed);
    } catch (error) {
      if (isAbortError(error) || shouldAbort()) {
        return this.completeSyncStopped(userId, jobId, status, status.processed || 0);
      }
      return this.completeSyncError(userId, jobId, status, error);
    } finally {
      stopHeartbeat();
    }
  }
}

const orderSyncManager = new OrderSyncManager();

async function resumeInterruptedOrderSyncJobs() {
  const staleStopping = await OrderSyncJob.updateMany(
    { status: 'STOPPING' },
    {
      status: 'STOPPED',
      message: 'Order sync stopped.',
      lockedBy: null,
      lockExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }
  );
  if (staleStopping.modifiedCount > 0) {
    console.log(
      `[OrderSync] Marked ${staleStopping.modifiedCount} stale stopping job(s) as stopped`
    );
  }

  const jobs = await OrderSyncJob.find({
    status: 'RUNNING',
    stopRequested: { $ne: true },
  }).sort({ startedAt: 1 });

  for (const job of jobs) {
    try {
      await orderSyncManager.resumeJob(job);
    } catch (err) {
      console.error(`[OrderSync] Failed to resume job ${job._id}:`, err.message);
      await releaseJobLock(OrderSyncJob, job._id).catch(() => {});
      await OrderSyncJob.findByIdAndUpdate(job._id, {
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
  orderSyncManager,
  resumeInterruptedOrderSyncJobs,
  ORDER_CONCURRENCY,
  ORDER_SYNC_STRATEGY,
  FETCH_CATALOG,
};
