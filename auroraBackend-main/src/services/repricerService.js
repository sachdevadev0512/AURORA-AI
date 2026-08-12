const Product = require('../models/Product');
const RepricerLog = require('../models/RepricerLog');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  computeRepriceDecision,
  extractCompetitiveTargets,
  extractTargetsFromOffers,
  isInCooldown,
  cooldownForSpeed,
  shouldAutoDisable,
  roundMoney,
} = require('../utils/repricerEngine');

function money(amount, currency = 'USD') {
  return { amount: roundMoney(amount), currency: currency || 'USD' };
}

function emitRepricerEvent(userId, payload) {
  if (!global.io) return;
  global.io.to(`user_${String(userId)}`).emit('repricerUpdate', {
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

async function notifyRepricer(userId, product, type, title, message) {
  try {
    const appNotificationService = require('./appNotificationService');
    await appNotificationService.createNotification(userId, {
      source: 'aurora',
      type,
      title,
      message,
      link: product?._id ? `/products/${product._id}` : '/products',
      metadata: {
        event: type,
        productId: product?._id ? String(product._id) : null,
        sku: product?.sku || null,
        asin: product?.asin || null,
      },
    });
  } catch (error) {
    console.warn('[Repricer] Notification failed:', error.message);
  }
}

async function writeLog(entry) {
  return RepricerLog.create(entry);
}

function buildCostInputs(product, repricer) {
  return {
    unitCost: repricer.unitCost ?? null,
    inboundShipping: repricer.inboundShipping ?? 0,
    feesTotal: product.fees?.totalFees?.amount ?? 0,
    feesFba: product.fees?.fbaFee?.amount ?? 0,
    currentPrice: product.price?.amount ?? 0,
  };
}

async function repriceProduct(user, product, options = {}) {
  const source = options.source || 'manual';
  const force = options.force === true;
  const repricer = product.repricer || {};

  if (!repricer.enabled && !force) {
    return { skipped: true, reason: 'repricer_disabled' };
  }

  // Auto-disable when listing is unhealthy
  if (repricer.autoDisable !== false) {
    const auto = shouldAutoDisable(product);
    if (auto.disable) {
      await Product.updateOne(
        { _id: product._id },
        {
          $set: {
            'repricer.enabled': false,
            'repricer.lastRunAt': new Date(),
            'repricer.lastAction': 'auto_disabled',
            'repricer.lastError': auto.reason,
          },
        },
      );
      await writeLog({
        sellerId: user._id,
        productId: product._id,
        sku: product.sku,
        asin: product.asin,
        strategy: repricer.strategy,
        previousPrice: product.price?.amount,
        action: 'skipped',
        reason: auto.reason,
        source,
      });
      await notifyRepricer(
        user._id,
        product,
        'repricer_auto_disabled',
        'Repricer auto-disabled',
        `${product.sku}: ${auto.reason.replace(/_/g, ' ')}`,
      );
      return { skipped: true, reason: auto.reason, autoDisabled: true };
    }
  }

  const minPrice = Number(repricer.minPrice);
  const maxPrice = Number(repricer.maxPrice);
  const hasManualBounds =
    Number.isFinite(minPrice) && Number.isFinite(maxPrice) && minPrice > 0 && maxPrice >= minPrice;
  const hasProfitGuard =
    (repricer.targetProfit != null && Number(repricer.targetProfit) > 0) ||
    (repricer.minRoiPercent != null && Number(repricer.minRoiPercent) > 0);

  if (!hasManualBounds && !hasProfitGuard) {
    const reason = 'invalid_min_max';
    await Product.updateOne(
      { _id: product._id },
      {
        $set: {
          'repricer.lastRunAt': new Date(),
          'repricer.lastError': reason,
          'repricer.lastAction': 'skipped',
        },
      },
    );
    return { skipped: true, reason };
  }

  const cooldownMinutes = cooldownForSpeed(
    repricer.speedMode,
    repricer.cooldownMinutes ?? 30,
  );
  if (!force && isInCooldown(repricer.lastChangeAt, cooldownMinutes)) {
    return { skipped: true, reason: 'cooldown' };
  }

  if (!product.asin || !product.sku) {
    return { skipped: true, reason: 'missing_asin_or_sku' };
  }

  const sellerAppCredentials = await getSellerAppCredentials(user);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const currency = repricer.currency || product.price?.currency || 'USD';
  const now = new Date();
  const costInputs = buildCostInputs(product, repricer);

  const useOfferFilters =
    repricer.fbaOnly ||
    repricer.excludeAmazon ||
    repricer.minFeedbackPercent != null ||
    repricer.minFeedbackCount != null ||
    (repricer.raiseWhenAlonePercent != null && Number(repricer.raiseWhenAlonePercent) > 0);

  let competitiveTargets;
  let offersPayload = null;
  if (useOfferFilters) {
    offersPayload = await amazonAPI.getItemOffers(product.asin);
    competitiveTargets = extractTargetsFromOffers(
      offersPayload,
      {
        fbaOnly: Boolean(repricer.fbaOnly),
        excludeAmazon: Boolean(repricer.excludeAmazon),
        minFeedbackPercent: repricer.minFeedbackPercent,
        minFeedbackCount: repricer.minFeedbackCount,
      },
      user.amazonSellerId,
    );
  } else {
    const competitivePayload = await amazonAPI.getCompetitivePricing([product.asin]);
    competitiveTargets = extractCompetitiveTargets(competitivePayload, product.asin);
    try {
      offersPayload = await amazonAPI.getItemOffers(product.asin);
      const offerScan = extractTargetsFromOffers(offersPayload, {}, user.amazonSellerId);
      competitiveTargets = {
        ...competitiveTargets,
        amazonRetailPresent: offerScan.amazonRetailPresent,
        aloneInMarket: competitiveTargets.aloneInMarket ?? offerScan.aloneInMarket,
      };
    } catch (_) {
      competitiveTargets = { ...competitiveTargets, amazonRetailPresent: false };
    }
  }

  const hadBuyBox = product.repricer?.hadBuyBox;
  const hasBuyBoxNow =
    competitiveTargets.buyBoxPrice != null &&
    product.price?.amount != null &&
    Math.abs(competitiveTargets.buyBoxPrice - product.price.amount) < 0.02;

  const decision = computeRepriceDecision({
    currentPrice: product.price?.amount,
    strategy: repricer.strategy || 'MATCH_LOWEST',
    pricingMode: repricer.pricingMode || 'PROFIT_FIRST',
    minPrice: Number.isFinite(minPrice) ? minPrice : null,
    maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
    beatByAmount: repricer.beatByAmount ?? 0.01,
    maxChangePercent: repricer.maxChangePercent ?? 15,
    competitiveTargets,
    costInputs,
    targetProfit: repricer.targetProfit,
    minRoiPercent: repricer.minRoiPercent,
    raiseWhenAlonePercent: repricer.raiseWhenAlonePercent ?? 0,
    unitsSold: product.unitsSold ?? 0,
  });

  // Smart alerts (pricing doc #18)
  if (hadBuyBox === true && !hasBuyBoxNow) {
    await notifyRepricer(
      user._id,
      product,
      'repricer_lost_buy_box',
      'Lost Buy Box',
      `${product.sku}: no longer Buy Box winner`,
    );
  }
  if (decision.reason === 'floored_at_min' || decision.reason === 'at_minimum_price') {
    await notifyRepricer(
      user._id,
      product,
      'repricer_min_reached',
      'Minimum price reached',
      `${product.sku}: holding at minimum ${decision.effectiveMin}`,
    );
  }

  const sawAmazonBefore = product.repricer?.lastSawAmazonRetail === true;
  if (competitiveTargets.amazonRetailPresent && !sawAmazonBefore) {
    await notifyRepricer(
      user._id,
      product,
      'repricer_amazon_competitor',
      'Amazon Became a Competitor',
      `${product.sku}: Amazon retail is now offering this ASIN`,
    );
  }

  const previousCompetitor = Number(product.repricer?.lastCompetitorPrice);
  const nextCompetitor = Number(decision.competitorPrice);
  if (
    Number.isFinite(previousCompetitor) &&
    previousCompetitor > 0 &&
    Number.isFinite(nextCompetitor) &&
    nextCompetitor > 0 &&
    nextCompetitor < previousCompetitor - 0.04
  ) {
    await notifyRepricer(
      user._id,
      product,
      'repricer_competitor_reduced',
      'Competitor Reduced Price',
      `${product.sku}: competitor ${previousCompetitor.toFixed(2)} → ${nextCompetitor.toFixed(2)}`,
    );
  }

  if (decision.action === 'skipped') {
    await Product.updateOne(
      { _id: product._id },
      {
        $set: {
          'repricer.lastRunAt': now,
          'repricer.lastCompetitorPrice': decision.competitorPrice,
          'repricer.lastTargetPrice': decision.targetPrice,
          'repricer.lastAction': 'skipped',
          'repricer.lastError': decision.reason,
          'repricer.hadBuyBox': hasBuyBoxNow,
          'repricer.lastSawAmazonRetail': Boolean(competitiveTargets.amazonRetailPresent),
          lowestPrice:
            decision.competitorPrice != null
              ? money(decision.competitorPrice, currency)
              : product.lowestPrice,
        },
      },
    );
    await writeLog({
      sellerId: user._id,
      productId: product._id,
      sku: product.sku,
      asin: product.asin,
      strategy: repricer.strategy,
      previousPrice: product.price?.amount,
      competitorPrice: decision.competitorPrice,
      targetPrice: decision.targetPrice,
      appliedPrice: decision.appliedPrice,
      minPrice: decision.effectiveMin ?? minPrice,
      maxPrice: decision.effectiveMax ?? maxPrice,
      action: 'skipped',
      reason: decision.reason,
      dryRun: Boolean(repricer.dryRun),
      source,
    });
    return { skipped: true, reason: decision.reason, decision };
  }

  // Explicit request dryRun overrides saved product config (so "Apply live" can force Amazon updates).
  const dryRun =
    options.dryRun !== undefined && options.dryRun !== null
      ? Boolean(options.dryRun)
      : Boolean(repricer.dryRun);
  let amazonResult = null;

  if (!dryRun) {
    try {
      const listing = await amazonAPI.getListingsItem(product.sku);
      const productType =
        listing?.summaries?.[0]?.productType ||
        listing?.summaries?.[0]?.productTypes?.[0] ||
        'PRODUCT';
      amazonResult = await amazonAPI.patchListingsItemPrice(
        product.sku,
        decision.appliedPrice,
        currency,
        productType,
      );
    } catch (error) {
      const message = error.message || 'amazon_price_update_failed';
      await Product.updateOne(
        { _id: product._id },
        {
          $set: {
            'repricer.lastRunAt': now,
            'repricer.lastError': message,
            'repricer.lastAction': 'error',
            'repricer.lastCompetitorPrice': decision.competitorPrice,
            'repricer.lastTargetPrice': decision.targetPrice,
            'repricer.hadBuyBox': hasBuyBoxNow,
            'repricer.lastSawAmazonRetail': Boolean(competitiveTargets.amazonRetailPresent),
          },
        },
      );
      await writeLog({
        sellerId: user._id,
        productId: product._id,
        sku: product.sku,
        asin: product.asin,
        strategy: repricer.strategy,
        previousPrice: product.price?.amount,
        competitorPrice: decision.competitorPrice,
        targetPrice: decision.targetPrice,
        appliedPrice: decision.appliedPrice,
        minPrice: decision.effectiveMin ?? minPrice,
        maxPrice: decision.effectiveMax ?? maxPrice,
        action: 'error',
        reason: message,
        dryRun: false,
        source,
      });
      emitRepricerEvent(user._id, {
        event: 'REPRICER_ERROR',
        productId: String(product._id),
        sku: product.sku,
        message,
      });
      await notifyRepricer(
        user._id,
        product,
        'repricer_error',
        'Repricer error',
        `${product.sku}: ${message}`,
      );
      return { error: true, reason: message, decision };
    }
  }

  const action = dryRun ? 'dry_run' : decision.action;
  const recoveredBuyBox = hadBuyBox === false && hasBuyBoxNow;
  const logReason = recoveredBuyBox
    ? `${decision.reason || 'updated'}|recovered_buy_box`
    : decision.reason;

  await Product.updateOne(
    { _id: product._id },
    {
      $set: {
        price: money(decision.appliedPrice, currency),
        lowestPrice:
          decision.competitorPrice != null
            ? money(decision.competitorPrice, currency)
            : product.lowestPrice,
        'repricer.lastRunAt': now,
        'repricer.lastChangeAt': dryRun ? repricer.lastChangeAt : now,
        'repricer.lastCompetitorPrice': decision.competitorPrice,
        'repricer.lastTargetPrice': decision.targetPrice,
        'repricer.lastAction': action,
        'repricer.lastError': null,
        'repricer.hadBuyBox': hasBuyBoxNow,
        'repricer.lastSawAmazonRetail': Boolean(competitiveTargets.amazonRetailPresent),
      },
    },
  );

  await writeLog({
    sellerId: user._id,
    productId: product._id,
    sku: product.sku,
    asin: product.asin,
    strategy: repricer.strategy,
    previousPrice: product.price?.amount,
    competitorPrice: decision.competitorPrice,
    targetPrice: decision.targetPrice,
    appliedPrice: decision.appliedPrice,
    minPrice: decision.effectiveMin ?? minPrice,
    maxPrice: decision.effectiveMax ?? maxPrice,
    action,
    reason: logReason,
    dryRun,
    source,
  });

  emitRepricerEvent(user._id, {
    event: dryRun ? 'REPRICER_DRY_RUN' : 'REPRICER_UPDATED',
    productId: String(product._id),
    sku: product.sku,
    previousPrice: product.price?.amount,
    appliedPrice: decision.appliedPrice,
    competitorPrice: decision.competitorPrice,
    reason: logReason,
  });

  return {
    updated: !dryRun,
    dryRun,
    decision,
    amazonResult,
  };
}

function pickConfigValue(config, key, fallback) {
  return config[key] != null ? config[key] : fallback;
}

async function upsertRepricerConfig(userId, productId, config = {}) {
  const product = await Product.findOne({ _id: productId, sellerId: userId });
  if (!product) {
    const error = new Error('Product not found');
    error.statusCode = 404;
    throw error;
  }

  const minPrice = config.minPrice != null ? Number(config.minPrice) : product.repricer?.minPrice;
  const maxPrice = config.maxPrice != null ? Number(config.maxPrice) : product.repricer?.maxPrice;

  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    const error = new Error('Minimum price cannot be greater than maximum price');
    error.statusCode = 400;
    throw error;
  }

  const allowedStrategies = ['MATCH_BUY_BOX', 'MATCH_LOWEST', 'BEAT_BUY_BOX', 'BEAT_LOWEST'];
  const allowedModes = ['PROFIT_FIRST', 'BUY_BOX_FIRST', 'SALES_GROWTH', 'CLEARANCE'];
  const allowedSpeeds = ['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE'];

  const strategy = config.strategy || product.repricer?.strategy || 'MATCH_LOWEST';
  const pricingMode = config.pricingMode || product.repricer?.pricingMode || 'PROFIT_FIRST';
  const speedMode = config.speedMode || product.repricer?.speedMode || 'CONSERVATIVE';

  if (!allowedStrategies.includes(strategy)) {
    const error = new Error('Invalid strategy');
    error.statusCode = 400;
    throw error;
  }
  if (!allowedModes.includes(pricingMode)) {
    const error = new Error('Invalid pricing mode');
    error.statusCode = 400;
    throw error;
  }
  if (!allowedSpeeds.includes(speedMode)) {
    const error = new Error('Invalid speed mode');
    error.statusCode = 400;
    throw error;
  }

  const prev = product.repricer?.toObject?.() || product.repricer || {};
  product.repricer = {
    ...prev,
    enabled: config.enabled != null ? Boolean(config.enabled) : Boolean(prev.enabled),
    strategy,
    pricingMode,
    speedMode,
    minPrice: minPrice ?? null,
    maxPrice: maxPrice ?? null,
    currency: config.currency || prev.currency || product.price?.currency || 'USD',
    beatByAmount: Number(pickConfigValue(config, 'beatByAmount', prev.beatByAmount ?? 0.01)),
    cooldownMinutes: Number(pickConfigValue(config, 'cooldownMinutes', prev.cooldownMinutes ?? 30)),
    maxChangePercent: Number(pickConfigValue(config, 'maxChangePercent', prev.maxChangePercent ?? 15)),
    unitCost:
      config.unitCost != null ? Number(config.unitCost) : prev.unitCost ?? null,
    inboundShipping:
      config.inboundShipping != null ? Number(config.inboundShipping) : prev.inboundShipping ?? null,
    targetProfit:
      config.targetProfit != null ? Number(config.targetProfit) : prev.targetProfit ?? null,
    minRoiPercent:
      config.minRoiPercent != null ? Number(config.minRoiPercent) : prev.minRoiPercent ?? null,
    fbaOnly: config.fbaOnly != null ? Boolean(config.fbaOnly) : Boolean(prev.fbaOnly),
    excludeAmazon:
      config.excludeAmazon != null ? Boolean(config.excludeAmazon) : Boolean(prev.excludeAmazon),
    minFeedbackPercent:
      config.minFeedbackPercent != null
        ? Number(config.minFeedbackPercent)
        : prev.minFeedbackPercent ?? null,
    minFeedbackCount:
      config.minFeedbackCount != null
        ? Number(config.minFeedbackCount)
        : prev.minFeedbackCount ?? null,
    raiseWhenAlonePercent:
      config.raiseWhenAlonePercent != null
        ? Number(config.raiseWhenAlonePercent)
        : prev.raiseWhenAlonePercent ?? 0,
    autoDisable: config.autoDisable != null ? Boolean(config.autoDisable) : prev.autoDisable !== false,
    dryRun: config.dryRun != null ? Boolean(config.dryRun) : Boolean(prev.dryRun),
  };

  if (minPrice != null) {
    product.minimumPrice = money(minPrice, product.repricer.currency);
  }
  if (maxPrice != null) {
    product.maximumPrice = money(maxPrice, product.repricer.currency);
  }

  await product.save();
  return product;
}

async function bulkConfigureRepricer(userId, { productIds = [], config = {} }) {
  const ids = [
    ...new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    const error = new Error('productIds are required');
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  for (const productId of ids) {
    try {
      const product = await upsertRepricerConfig(userId, productId, config);
      results.push({ productId, ok: true, enabled: product.repricer?.enabled });
    } catch (error) {
      results.push({ productId, ok: false, error: error.message });
    }
  }
  return { updated: results.filter((r) => r.ok).length, results };
}

async function getRepricerLogs(userId, { productId, limit = 50, page = 1 } = {}) {
  const query = { sellerId: userId };
  if (productId) query.productId = productId;

  const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
  const pageNum = Math.max(1, Number(page) || 1);
  const skip = (pageNum - 1) * pageSize;

  const [total, logs] = await Promise.all([
    RepricerLog.countDocuments(query),
    RepricerLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
  ]);

  return {
    logs,
    pagination: {
      total,
      page: pageNum,
      limit: pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

async function getRepricerDashboard(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [enabledCount, winningBuyBox, runsToday, activeProducts, recentLogs] = await Promise.all([
    Product.countDocuments({ sellerId: userId, 'repricer.enabled': true }),
    Product.countDocuments({
      sellerId: userId,
      'repricer.enabled': true,
      'repricer.hadBuyBox': true,
    }),
    RepricerLog.countDocuments({ sellerId: userId, createdAt: { $gte: since } }),
    Product.find({ sellerId: userId, 'repricer.enabled': true })
      .select('sku asin title price repricer')
      .sort({ 'repricer.lastChangeAt': -1 })
      .limit(20)
      .lean(),
    RepricerLog.find({ sellerId: userId }).sort({ createdAt: -1 }).limit(200).lean(),
  ]);

  const todayLogs = recentLogs.filter((log) => new Date(log.createdAt) >= since);
  const updatedToday = todayLogs.filter((log) =>
    ['updated', 'clamped', 'dry_run'].includes(log.action),
  );
  const errorsToday = todayLogs.filter((log) => log.action === 'error');
  const reasonOf = (log) => String(log.reason || '');
  const minimumHitsToday = todayLogs.filter(
    (log) => reasonOf(log) === 'floored_at_min' || reasonOf(log) === 'at_minimum_price',
  ).length;
  const profitProtectionHitsToday = todayLogs.filter((log) =>
    reasonOf(log).includes('profit_protection'),
  ).length;
  const roiProtectionHitsToday = todayLogs.filter((log) =>
    reasonOf(log).includes('roi_protection'),
  ).length;
  const buyBoxRecoveriesToday = todayLogs.filter((log) =>
    reasonOf(log).includes('recovered_buy_box'),
  ).length;

  return {
    activeRules: enabledCount,
    rulesTriggeredToday: runsToday,
    priceChangesToday: updatedToday.length,
    errorsToday: errorsToday.length,
    minimumHitsToday,
    profitProtectionHitsToday,
    roiProtectionHitsToday,
    currentlyWinningBuyBox: winningBuyBox,
    buyBoxRecoveriesToday,
    recentProducts: activeProducts,
    recentLogs: recentLogs.slice(0, 25),
  };
}

/**
 * Set the same listing price on many products (optional Amazon push).
 */
async function bulkSetListingPrices(user, { productIds = [], amount, currency, dryRun = false } = {}) {
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  const price = Number(amount);
  if (!ids.length) {
    const error = new Error('productIds are required');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error('A valid price greater than 0 is required');
    error.statusCode = 400;
    throw error;
  }

  const sellerAppCredentials = await getSellerAppCredentials(user);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const results = [];

  for (const productId of ids) {
    try {
      const product = await Product.findOne({ _id: productId, sellerId: user._id });
      if (!product) {
        results.push({ productId, ok: false, error: 'Product not found' });
        continue;
      }

      const useCurrency = currency || product.price?.currency || 'USD';
      const previousPrice = product.price?.amount ?? null;

      if (!dryRun) {
        const listing = await amazonAPI.getListingsItem(product.sku);
        const productType =
          listing?.summaries?.[0]?.productType ||
          listing?.summaries?.[0]?.productTypes?.[0] ||
          'PRODUCT';
        await amazonAPI.patchListingsItemPrice(product.sku, price, useCurrency, productType);
        await Product.updateOne(
          { _id: product._id },
          {
            $set: {
              price: money(price, useCurrency),
              'repricer.lastRunAt': new Date(),
              'repricer.lastAction': 'manual_price_set',
              'repricer.lastError': null,
              'repricer.lastTargetPrice': price,
            },
          },
        );
      }

      await writeLog({
        sellerId: user._id,
        productId: product._id,
        sku: product.sku,
        asin: product.asin,
        strategy: product.repricer?.strategy,
        previousPrice,
        targetPrice: price,
        appliedPrice: price,
        action: dryRun ? 'dry_run' : 'updated',
        reason: dryRun ? 'bulk_set_price_preview' : 'bulk_set_price',
        dryRun: Boolean(dryRun),
        source: 'manual',
      });

      emitRepricerEvent(user._id, {
        event: dryRun ? 'REPRICER_DRY_RUN' : 'REPRICER_UPDATED',
        productId: String(product._id),
        sku: product.sku,
        appliedPrice: price,
      });

      results.push({ productId, ok: true, sku: product.sku, previousPrice, appliedPrice: price, dryRun: Boolean(dryRun) });
    } catch (error) {
      results.push({ productId, ok: false, error: error.message || 'price_update_failed' });
    }
  }

  return {
    updated: results.filter((r) => r.ok && !r.dryRun).length,
    previewed: results.filter((r) => r.ok && r.dryRun).length,
    errors: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  repriceProduct,
  upsertRepricerConfig,
  bulkConfigureRepricer,
  bulkSetListingPrices,
  getRepricerLogs,
  getRepricerDashboard,
};
