/**
 * Pure competitive repricer math — no I/O. Safe to unit test.
 */

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clampPrice(target, minPrice, maxPrice) {
  let price = roundMoney(target);
  let clamped = false;
  let reason = null;

  if (minPrice != null && Number.isFinite(minPrice) && price < minPrice) {
    price = roundMoney(minPrice);
    clamped = true;
    reason = 'floored_at_min';
  }
  if (maxPrice != null && Number.isFinite(maxPrice) && price > maxPrice) {
    price = roundMoney(maxPrice);
    clamped = true;
    reason = 'capped_at_max';
  }

  return { price, clamped, reason };
}

/**
 * Profit Protection floor:
 * minPrice = COGS + inbound + Amazon fees(at price) + targetProfit
 * Fees: FBA fixed + referral scales with price.
 */
function computeProfitFloor({
  unitCost = 0,
  inboundShipping = 0,
  feesTotal = 0,
  feesFba = 0,
  currentPrice = 0,
  targetProfit = 0,
}) {
  const cogs = Math.max(0, Number(unitCost) || 0) + Math.max(0, Number(inboundShipping) || 0);
  const profit = Math.max(0, Number(targetProfit) || 0);
  const fba = Math.max(0, Number(feesFba) || 0);
  const totalFees = Math.max(0, Number(feesTotal) || 0);
  const current = Math.max(0, Number(currentPrice) || 0);

  let referralRate = 0.15;
  if (current > 0 && totalFees > 0) {
    const referralLike = Math.max(0, totalFees - fba);
    referralRate = Math.min(0.5, Math.max(0, referralLike / current));
  }

  const denominator = 1 - referralRate;
  if (denominator <= 0.01) {
    return roundMoney(cogs + fba + profit + totalFees);
  }

  return roundMoney((profit + fba + cogs) / denominator);
}

function estimateCostsAtPrice(price, costInputs = {}) {
  const {
    unitCost = 0,
    inboundShipping = 0,
    feesTotal = 0,
    feesFba = 0,
    currentPrice = 0,
  } = costInputs;
  const cogs = Math.max(0, Number(unitCost) || 0) + Math.max(0, Number(inboundShipping) || 0);
  const fba = Math.max(0, Number(feesFba) || 0);
  const totalFees = Math.max(0, Number(feesTotal) || 0);
  const current = Math.max(0, Number(currentPrice) || 0);

  let amazonFees = totalFees;
  if (current > 0 && totalFees > 0) {
    const referralLike = Math.max(0, totalFees - fba);
    const referralRate = referralLike / current;
    amazonFees = fba + Number(price) * referralRate;
  }

  const totalCost = cogs + amazonFees;
  const profit = Number(price) - totalCost;
  const roiPercent = cogs > 0 ? (profit / cogs) * 100 : null;

  return {
    cogs: roundMoney(cogs),
    amazonFees: roundMoney(amazonFees),
    totalCost: roundMoney(totalCost),
    profit: roundMoney(profit),
    roiPercent: roiPercent == null ? null : roundMoney(roiPercent),
  };
}

function resolveEffectiveMinMax({
  minPrice,
  maxPrice,
  unitCost,
  inboundShipping,
  feesTotal,
  feesFba,
  currentPrice,
  targetProfit,
  minRoiPercent,
  pricingMode,
}) {
  let effectiveMin = minPrice != null && Number.isFinite(Number(minPrice)) ? Number(minPrice) : null;
  let effectiveMax = maxPrice != null && Number.isFinite(Number(maxPrice)) ? Number(maxPrice) : null;

  if (targetProfit != null && Number(targetProfit) > 0) {
    const profitFloor = computeProfitFloor({
      unitCost,
      inboundShipping,
      feesTotal,
      feesFba,
      currentPrice,
      targetProfit,
    });
    effectiveMin =
      effectiveMin == null ? profitFloor : Math.max(effectiveMin, profitFloor);
  }

  if (minRoiPercent != null && Number(minRoiPercent) > 0) {
    const cogs = Math.max(0, Number(unitCost) || 0) + Math.max(0, Number(inboundShipping) || 0);
    const fba = Math.max(0, Number(feesFba) || 0);
    const totalFees = Math.max(0, Number(feesTotal) || 0);
    const current = Math.max(0, Number(currentPrice) || 0);
    let referralRate = 0.15;
    if (current > 0 && totalFees > 0) {
      referralRate = Math.min(0.5, Math.max(0, (totalFees - fba) / current));
    }
    // price - fba - price*r - cogs >= cogs * (roi/100)
    // price*(1-r) >= fba + cogs * (1 + roi/100)
    const denom = 1 - referralRate;
    if (denom > 0.01 && cogs > 0) {
      const roiFloor = roundMoney((fba + cogs * (1 + Number(minRoiPercent) / 100)) / denom);
      effectiveMin = effectiveMin == null ? roiFloor : Math.max(effectiveMin, roiFloor);
    }
  }

  if (pricingMode === 'CLEARANCE' && effectiveMin != null && effectiveMax != null) {
    // Clearance: allow down to min, ignore competing upward pressure beyond a soft band.
    effectiveMax = Math.max(effectiveMin, Math.min(effectiveMax, effectiveMin * 1.25));
  }

  if (effectiveMin != null && effectiveMax != null && effectiveMin > effectiveMax) {
    effectiveMax = effectiveMin;
  }

  return {
    effectiveMin: effectiveMin == null ? null : roundMoney(effectiveMin),
    effectiveMax: effectiveMax == null ? null : roundMoney(effectiveMax),
  };
}

function extractCompetitiveTargets(competitivePayload, asin) {
  const entry = (competitivePayload || []).find(
    (row) => row.ASIN === asin || row.asin === asin,
  );
  const product = entry?.Product || entry?.product;
  const competitive = product?.CompetitivePricing || product?.competitivePricing;
  const prices = competitive?.CompetitivePrices || competitive?.competitivePrices || [];

  let lowestPrice = null;
  let buyBoxPrice = null;

  for (const row of prices) {
    const landed =
      row.Price?.LandedPrice?.Amount ??
      row.price?.landedPrice?.amount ??
      row.Price?.ListingPrice?.Amount ??
      row.price?.listingPrice?.amount;
    const amount = Number(landed);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    if (lowestPrice == null || amount < lowestPrice) lowestPrice = amount;

    const priceId = String(row.CompetitivePriceId ?? row.competitivePriceId ?? '');
    const condition = String(row.condition || row.Condition || 'New');
    if (priceId === '1' && /^new$/i.test(condition)) {
      buyBoxPrice = amount;
    }
  }

  return {
    lowestPrice: lowestPrice == null ? null : roundMoney(lowestPrice),
    buyBoxPrice: buyBoxPrice == null ? null : roundMoney(buyBoxPrice),
    offerCount: prices.length,
  };
}

/**
 * Filter item offers and derive lowest / buy box among allowed competitors.
 */
function extractTargetsFromOffers(offersPayload, filters = {}, ourSellerId = null) {
  const offers = offersPayload?.Offers || offersPayload?.offers || [];
  const summary = offersPayload?.Summary || offersPayload?.summary || {};

  let amazonRetailPresent = false;
  const filtered = [];
  for (const offer of offers) {
    const sellerId = offer.SellerId || offer.sellerId;
    if (ourSellerId && sellerId && String(sellerId) === String(ourSellerId)) continue;

    const isFba = Boolean(offer.IsFulfilledByAmazon ?? offer.isFulfilledByAmazon);
    const feedback = offer.SellerFeedbackRating || offer.sellerFeedbackRating || {};
    const rating = feedback.SellerPositiveFeedbackRating ?? feedback.sellerPositiveFeedbackRating;
    const feedbackCount = feedback.FeedbackCount ?? feedback.feedbackCount ?? 0;

    // Amazon retail offers typically have no seller feedback block.
    const looksLikeAmazonRetail = !feedback || (rating == null && !feedbackCount);
    if (looksLikeAmazonRetail) {
      amazonRetailPresent = true;
    }

    if (filters.fbaOnly && !isFba) continue;
    if (filters.excludeAmazon) {
      if (looksLikeAmazonRetail) continue;
    }
    if (
      filters.minFeedbackPercent != null &&
      (rating == null || Number(rating) < Number(filters.minFeedbackPercent))
    ) {
      continue;
    }
    if (
      filters.minFeedbackCount != null &&
      Number(feedbackCount) < Number(filters.minFeedbackCount)
    ) {
      continue;
    }

    const landed =
      offer.ListingPrice?.Amount ??
      offer.listingPrice?.amount ??
      offer.BuyingPrice?.LandedPrice?.Amount ??
      offer.buyingPrice?.landedPrice?.amount;
    const shipping = offer.Shipping?.Amount ?? offer.shipping?.amount ?? 0;
    const amount = Number(landed) + Number(shipping || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    filtered.push({
      amount: roundMoney(amount),
      isBuyBox: Boolean(offer.IsBuyBoxWinner ?? offer.isBuyBoxWinner),
      isFba,
      sellerId,
      amazonRetail: looksLikeAmazonRetail,
    });
  }

  let lowestPrice = null;
  let buyBoxPrice = null;
  for (const offer of filtered) {
    if (lowestPrice == null || offer.amount < lowestPrice) lowestPrice = offer.amount;
    if (offer.isBuyBox) buyBoxPrice = offer.amount;
  }

  // Fallback to summary if filters removed everyone but summary exists
  if (lowestPrice == null) {
    const summaryLowest =
      summary.LowestPrices?.[0]?.LandedPrice?.Amount ??
      summary.lowestPrices?.[0]?.landedPrice?.amount;
    if (summaryLowest) lowestPrice = roundMoney(summaryLowest);
  }
  if (buyBoxPrice == null) {
    const summaryBuyBox =
      summary.BuyBoxPrices?.[0]?.LandedPrice?.Amount ??
      summary.buyBoxPrices?.[0]?.landedPrice?.amount;
    if (summaryBuyBox) buyBoxPrice = roundMoney(summaryBuyBox);
  }

  return {
    lowestPrice,
    buyBoxPrice,
    offerCount: filtered.length,
    aloneInMarket: filtered.length === 0,
    amazonRetailPresent,
  };
}

function pickReferencePrice(strategy, targets) {
  const { lowestPrice, buyBoxPrice } = targets || {};
  switch (strategy) {
    case 'MATCH_BUY_BOX':
    case 'BEAT_BUY_BOX':
      return buyBoxPrice ?? lowestPrice ?? null;
    case 'MATCH_LOWEST':
    case 'BEAT_LOWEST':
    default:
      return lowestPrice ?? buyBoxPrice ?? null;
  }
}

function applyBeat(strategy, referencePrice, beatByAmount = 0.01) {
  const beat = Math.max(0, Number(beatByAmount) || 0);
  if (strategy === 'BEAT_BUY_BOX' || strategy === 'BEAT_LOWEST') {
    return roundMoney(referencePrice - beat);
  }
  return roundMoney(referencePrice);
}

function resolveStrategyForMode(pricingMode, strategy, unitsSold = null) {
  switch (pricingMode) {
    case 'BUY_BOX_FIRST':
      return strategy?.includes('BEAT') ? 'BEAT_BUY_BOX' : 'MATCH_BUY_BOX';
    case 'SALES_GROWTH': {
      // Doc: Sales Velocity Logic — slow sellers push harder; strong sellers hold Buy Box.
      const units = Number(unitsSold);
      if (Number.isFinite(units) && units >= 10) {
        return 'MATCH_BUY_BOX';
      }
      return 'BEAT_LOWEST';
    }
    case 'CLEARANCE':
      return 'MATCH_LOWEST';
    case 'PROFIT_FIRST':
    default:
      return strategy || 'MATCH_LOWEST';
  }
}

/**
 * Sales Growth beat sizing from velocity (unitsSold).
 * Slow / no sales → larger undercut; healthy sales → tiny or no undercut.
 */
function salesGrowthBeatAmount(unitsSold, beatByAmount = 0.01) {
  const base = Math.max(0, Number(beatByAmount) || 0.01);
  const units = Number(unitsSold);
  if (!Number.isFinite(units) || units <= 0) {
    return Math.max(base, 0.1);
  }
  if (units < 5) {
    return Math.max(base, 0.05);
  }
  if (units < 10) {
    return base;
  }
  return 0;
}

function cooldownForSpeed(speedMode, fallbackMinutes = 30) {
  switch (speedMode) {
    case 'AGGRESSIVE':
      return 0;
    case 'BALANCED':
      return 5;
    case 'CONSERVATIVE':
      return 30;
    default:
      return fallbackMinutes;
  }
}

/**
 * Compute the price we should list at.
 */
function computeRepriceDecision({
  currentPrice,
  strategy = 'MATCH_LOWEST',
  pricingMode = 'PROFIT_FIRST',
  minPrice,
  maxPrice,
  beatByAmount = 0.01,
  maxChangePercent = 15,
  competitiveTargets,
  costInputs = {},
  targetProfit = null,
  minRoiPercent = null,
  raiseWhenAlonePercent = 0,
  unitsSold = null,
}) {
  const effectiveStrategy = resolveStrategyForMode(pricingMode, strategy, unitsSold);
  const { effectiveMin, effectiveMax } = resolveEffectiveMinMax({
    minPrice,
    maxPrice,
    targetProfit,
    minRoiPercent,
    pricingMode,
    ...costInputs,
    currentPrice,
  });

  const alone =
    competitiveTargets?.aloneInMarket === true ||
    (competitiveTargets?.offerCount === 0 &&
      competitiveTargets?.lowestPrice == null &&
      competitiveTargets?.buyBoxPrice == null);

  let referencePrice = pickReferencePrice(effectiveStrategy, competitiveTargets);
  let rawTarget = null;
  let modeReason = null;

  if (alone && raiseWhenAlonePercent > 0 && currentPrice > 0) {
    rawTarget = roundMoney(currentPrice * (1 + Number(raiseWhenAlonePercent) / 100));
    modeReason = 'raised_while_alone';
    referencePrice = currentPrice;
  } else if (pricingMode === 'CLEARANCE' && effectiveMin != null) {
    // Push toward floor to move units, still respect competition if lower than current.
    const competitive = referencePrice != null ? applyBeat('MATCH_LOWEST', referencePrice, 0) : null;
    rawTarget =
      competitive != null ? Math.min(competitive, effectiveMin * 1.05) : effectiveMin;
    modeReason = 'clearance_toward_min';
  } else if (referencePrice == null) {
    return {
      action: 'skipped',
      reason: 'no_competitor_price',
      targetPrice: null,
      appliedPrice: null,
      competitorPrice: null,
      effectiveMin,
      effectiveMax,
      clamped: false,
      costs: null,
    };
  } else if (
    pricingMode === 'SALES_GROWTH' &&
    Number.isFinite(Number(unitsSold)) &&
    Number(unitsSold) >= 10 &&
    competitiveTargets?.buyBoxPrice != null &&
    currentPrice > 0 &&
    Math.abs(Number(competitiveTargets.buyBoxPrice) - Number(currentPrice)) < 0.02
  ) {
    // Strong velocity + already Buy Box → hold (don't race lower).
    return {
      action: 'skipped',
      reason: 'velocity_hold_buy_box',
      targetPrice: roundMoney(currentPrice),
      appliedPrice: roundMoney(currentPrice),
      competitorPrice: referencePrice,
      effectiveMin,
      effectiveMax,
      clamped: false,
      costs: estimateCostsAtPrice(currentPrice, { ...costInputs, currentPrice }),
    };
  } else {
    const beat =
      pricingMode === 'SALES_GROWTH'
        ? salesGrowthBeatAmount(unitsSold, beatByAmount)
        : beatByAmount;
    rawTarget = applyBeat(effectiveStrategy, referencePrice, beat);
    if (pricingMode === 'SALES_GROWTH') {
      const units = Number(unitsSold);
      if (!Number.isFinite(units) || units <= 0) modeReason = 'velocity_slow_undercut';
      else if (units < 10) modeReason = 'velocity_moderate_undercut';
      else modeReason = 'velocity_strong_match_buy_box';
    }
  }

  const { price: clampedPrice, clamped, reason: clampReason } = clampPrice(
    rawTarget,
    effectiveMin,
    effectiveMax,
  );

  // ROI / profit gate after clamp
  const costs = estimateCostsAtPrice(clampedPrice, { ...costInputs, currentPrice });
  if (minRoiPercent != null && costs.roiPercent != null && costs.roiPercent < Number(minRoiPercent)) {
    return {
      action: 'skipped',
      reason: 'roi_protection',
      targetPrice: clampedPrice,
      appliedPrice: roundMoney(currentPrice),
      competitorPrice: referencePrice,
      effectiveMin,
      effectiveMax,
      clamped,
      costs,
    };
  }
  if (
    targetProfit != null &&
    Number(targetProfit) > 0 &&
    costs.profit < Number(targetProfit) - 0.009
  ) {
    return {
      action: 'skipped',
      reason: 'profit_protection',
      targetPrice: clampedPrice,
      appliedPrice: roundMoney(currentPrice),
      competitorPrice: referencePrice,
      effectiveMin,
      effectiveMax,
      clamped,
      costs,
    };
  }

  const current = roundMoney(currentPrice);
  if (current > 0 && Math.abs(clampedPrice - current) < 0.005) {
    return {
      action: 'skipped',
      reason: clampReason === 'floored_at_min' ? 'at_minimum_price' : 'already_at_target',
      targetPrice: clampedPrice,
      appliedPrice: current,
      competitorPrice: referencePrice,
      effectiveMin,
      effectiveMax,
      clamped,
      costs,
    };
  }

  let appliedPrice = clampedPrice;
  let reason = modeReason || clampReason || 'follow_competition';
  let action = clamped ? 'clamped' : 'updated';

  if (
    current > 0 &&
    maxChangePercent != null &&
    Number.isFinite(maxChangePercent) &&
    maxChangePercent > 0
  ) {
    const changePct = (Math.abs(clampedPrice - current) / current) * 100;
    if (changePct > maxChangePercent) {
      const direction = clampedPrice > current ? 1 : -1;
      const limited = roundMoney(current * (1 + (direction * maxChangePercent) / 100));
      const limitedClamp = clampPrice(limited, effectiveMin, effectiveMax);
      appliedPrice = limitedClamp.price;
      action = limitedClamp.clamped ? 'clamped' : 'updated';
      reason = `limited_to_${maxChangePercent}_percent${limitedClamp.reason ? `_${limitedClamp.reason}` : ''}`;
    }
  }

  // Final ROI check on applied price
  const appliedCosts = estimateCostsAtPrice(appliedPrice, { ...costInputs, currentPrice });
  if (
    minRoiPercent != null &&
    appliedCosts.roiPercent != null &&
    appliedCosts.roiPercent < Number(minRoiPercent)
  ) {
    return {
      action: 'skipped',
      reason: 'roi_protection',
      targetPrice: clampedPrice,
      appliedPrice: current,
      competitorPrice: referencePrice,
      effectiveMin,
      effectiveMax,
      clamped,
      costs: appliedCosts,
    };
  }

  return {
    action,
    reason,
    targetPrice: clampedPrice,
    appliedPrice,
    competitorPrice: referencePrice,
    effectiveMin,
    effectiveMax,
    clamped: action === 'clamped' || clamped,
    costs: appliedCosts,
  };
}

function isInCooldown(lastChangeAt, cooldownMinutes = 30) {
  if (!lastChangeAt) return false;
  const mins = Math.max(0, Number(cooldownMinutes) || 0);
  if (mins <= 0) return false;
  const elapsedMs = Date.now() - new Date(lastChangeAt).getTime();
  return elapsedMs < mins * 60 * 1000;
}

function shouldAutoDisable(product = {}) {
  const qty =
    product.inventory?.fulfillableQuantity ??
    product.inventory?.quantity ??
    0;
  if (Number(qty) <= 0) {
    return { disable: true, reason: 'inventory_zero' };
  }

  const listingStatus = String(product.listingStatus || '').toLowerCase();
  const status = String(product.status || '').toLowerCase();
  if (
    status === 'inactive' ||
    status === 'closed' ||
    listingStatus.includes('inactive') ||
    listingStatus.includes('suppressed') ||
    listingStatus.includes('detail page removed')
  ) {
    return { disable: true, reason: 'listing_inactive_or_suppressed' };
  }

  if (product.isListedOnAmazon === false) {
    return { disable: true, reason: 'not_listed_on_amazon' };
  }

  return { disable: false, reason: null };
}

module.exports = {
  roundMoney,
  clampPrice,
  computeProfitFloor,
  estimateCostsAtPrice,
  resolveEffectiveMinMax,
  extractCompetitiveTargets,
  extractTargetsFromOffers,
  pickReferencePrice,
  applyBeat,
  resolveStrategyForMode,
  salesGrowthBeatAmount,
  cooldownForSpeed,
  computeRepriceDecision,
  isInCooldown,
  shouldAutoDisable,
};
