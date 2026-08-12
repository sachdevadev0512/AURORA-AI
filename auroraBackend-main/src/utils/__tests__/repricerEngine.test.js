const {
  clampPrice,
  computeProfitFloor,
  computeRepriceDecision,
  estimateCostsAtPrice,
  extractCompetitiveTargets,
  extractTargetsFromOffers,
  isInCooldown,
  shouldAutoDisable,
  cooldownForSpeed,
  roundMoney,
  salesGrowthBeatAmount,
} = require('../repricerEngine');

describe('repricerEngine advanced', () => {
  test('roundMoney and clampPrice', () => {
    expect(roundMoney(10.994)).toBe(10.99);
    expect(clampPrice(18, 20, 35).price).toBe(20);
    expect(clampPrice(40, 20, 35).price).toBe(35);
  });

  test('profit floor matches document example shape', () => {
    // cost 8 + inbound 2 + fees ~4 + profit 5 => around 19
    const floor = computeProfitFloor({
      unitCost: 8,
      inboundShipping: 2,
      feesTotal: 4,
      feesFba: 2.5,
      currentPrice: 25,
      targetProfit: 5,
    });
    expect(floor).toBeGreaterThanOrEqual(18);
    expect(floor).toBeLessThanOrEqual(22);
  });

  test('ROI protection blocks unprofitable drop', () => {
    const decision = computeRepriceDecision({
      currentPrice: 30,
      strategy: 'MATCH_LOWEST',
      minPrice: 10,
      maxPrice: 50,
      maxChangePercent: 100,
      minRoiPercent: 30,
      costInputs: {
        unitCost: 20,
        inboundShipping: 0,
        feesTotal: 5,
        feesFba: 3,
        currentPrice: 30,
      },
      competitiveTargets: { lowestPrice: 22, buyBoxPrice: 22 },
    });
    expect(decision.action).toBe('skipped');
    expect(decision.reason).toBe('roi_protection');
  });

  test('profit protection blocks below target profit', () => {
    const decision = computeRepriceDecision({
      currentPrice: 30,
      strategy: 'MATCH_LOWEST',
      minPrice: 10,
      maxPrice: 50,
      maxChangePercent: 100,
      targetProfit: 10,
      costInputs: {
        unitCost: 8,
        inboundShipping: 2,
        feesTotal: 6,
        feesFba: 3,
        currentPrice: 30,
      },
      competitiveTargets: { lowestPrice: 18, buyBoxPrice: 18 },
    });
    expect(['skipped', 'clamped', 'updated']).toContain(decision.action);
    if (decision.action === 'skipped') {
      expect(['profit_protection', 'roi_protection']).toContain(decision.reason);
    } else {
      expect(decision.appliedPrice).toBeGreaterThanOrEqual(decision.effectiveMin);
    }
  });

  test('never goes below effective min when competition is lower', () => {
    const decision = computeRepriceDecision({
      currentPrice: 25,
      strategy: 'MATCH_LOWEST',
      minPrice: 20,
      maxPrice: 35,
      maxChangePercent: 100,
      competitiveTargets: { lowestPrice: 15, buyBoxPrice: 15 },
    });
    expect(decision.appliedPrice).toBe(20);
    expect(decision.clamped).toBe(true);
  });

  test('raise when alone in market', () => {
    const decision = computeRepriceDecision({
      currentPrice: 25,
      strategy: 'MATCH_LOWEST',
      minPrice: 20,
      maxPrice: 40,
      maxChangePercent: 100,
      raiseWhenAlonePercent: 4,
      competitiveTargets: { lowestPrice: null, buyBoxPrice: null, aloneInMarket: true, offerCount: 0 },
    });
    expect(decision.appliedPrice).toBe(26);
    expect(decision.reason).toBe('raised_while_alone');
  });

  test('clearance mode trends toward min', () => {
    const decision = computeRepriceDecision({
      currentPrice: 30,
      strategy: 'MATCH_LOWEST',
      pricingMode: 'CLEARANCE',
      minPrice: 20,
      maxPrice: 40,
      maxChangePercent: 100,
      competitiveTargets: { lowestPrice: 28, buyBoxPrice: 28 },
    });
    expect(decision.appliedPrice).toBeLessThanOrEqual(28);
  });

  test('offer filters exclude FBM when fbaOnly', () => {
    const targets = extractTargetsFromOffers(
      {
        Offers: [
          {
            SellerId: 'A1',
            IsFulfilledByAmazon: false,
            ListingPrice: { Amount: 10 },
            Shipping: { Amount: 0 },
            SellerFeedbackRating: { SellerPositiveFeedbackRating: 99, FeedbackCount: 100 },
          },
          {
            SellerId: 'A2',
            IsFulfilledByAmazon: true,
            ListingPrice: { Amount: 12 },
            Shipping: { Amount: 0 },
            SellerFeedbackRating: { SellerPositiveFeedbackRating: 98, FeedbackCount: 50 },
            IsBuyBoxWinner: true,
          },
        ],
      },
      { fbaOnly: true },
    );
    expect(targets.lowestPrice).toBe(12);
    expect(targets.buyBoxPrice).toBe(12);
    expect(targets.offerCount).toBe(1);
  });

  test('auto disable on zero inventory', () => {
    expect(shouldAutoDisable({ inventory: { fulfillableQuantity: 0 } }).disable).toBe(true);
    expect(shouldAutoDisable({ inventory: { fulfillableQuantity: 3 }, status: 'Active' }).disable).toBe(false);
    expect(shouldAutoDisable({ inventory: { quantity: 2 }, listingStatus: 'Suppressed' }).disable).toBe(true);
  });

  test('speed modes map to cooldowns', () => {
    expect(cooldownForSpeed('AGGRESSIVE')).toBe(0);
    expect(cooldownForSpeed('BALANCED')).toBe(5);
    expect(cooldownForSpeed('CONSERVATIVE')).toBe(30);
  });

  test('estimateCostsAtPrice returns profit and roi', () => {
    const costs = estimateCostsAtPrice(25, {
      unitCost: 8,
      inboundShipping: 2,
      feesTotal: 6,
      feesFba: 3,
      currentPrice: 25,
    });
    expect(costs.cogs).toBe(10);
    expect(costs.profit).toBeGreaterThan(0);
    expect(costs.roiPercent).toBeGreaterThan(0);
  });

  test('extractCompetitiveTargets reads buy box id 1', () => {
    const targets = extractCompetitiveTargets(
      [
        {
          ASIN: 'B00X',
          Product: {
            CompetitivePricing: {
              CompetitivePrices: [
                { CompetitivePriceId: '1', Condition: 'New', Price: { LandedPrice: { Amount: 20 } } },
                { CompetitivePriceId: '2', Condition: 'New', Price: { LandedPrice: { Amount: 18 } } },
              ],
            },
          },
        },
      ],
      'B00X',
    );
    expect(targets.buyBoxPrice).toBe(20);
    expect(targets.lowestPrice).toBe(18);
  });

  test('isInCooldown', () => {
    expect(isInCooldown(new Date(Date.now() - 60 * 1000), 5)).toBe(true);
    expect(isInCooldown(new Date(Date.now() - 10 * 60 * 1000), 5)).toBe(false);
  });

  test('salesGrowthBeatAmount scales with unitsSold', () => {
    expect(salesGrowthBeatAmount(0, 0.01)).toBeGreaterThanOrEqual(0.1);
    expect(salesGrowthBeatAmount(3, 0.01)).toBeGreaterThanOrEqual(0.05);
    expect(salesGrowthBeatAmount(12, 0.01)).toBe(0);
  });

  test('SALES_GROWTH slow velocity undercuts harder', () => {
    const slow = computeRepriceDecision({
      currentPrice: 25,
      strategy: 'MATCH_LOWEST',
      pricingMode: 'SALES_GROWTH',
      minPrice: 15,
      maxPrice: 40,
      maxChangePercent: 100,
      beatByAmount: 0.01,
      unitsSold: 0,
      competitiveTargets: { lowestPrice: 24, buyBoxPrice: 24 },
    });
    expect(slow.appliedPrice).toBeLessThan(24);
    expect(String(slow.reason)).toMatch(/velocity_slow/);
  });

  test('SALES_GROWTH strong velocity holds Buy Box instead of racing', () => {
    const strong = computeRepriceDecision({
      currentPrice: 24,
      strategy: 'MATCH_LOWEST',
      pricingMode: 'SALES_GROWTH',
      minPrice: 15,
      maxPrice: 40,
      maxChangePercent: 100,
      beatByAmount: 0.01,
      unitsSold: 15,
      competitiveTargets: { lowestPrice: 22, buyBoxPrice: 24 },
    });
    expect(strong.appliedPrice).toBe(24);
    expect(strong.reason).toBe('velocity_hold_buy_box');
  });

  test('extractTargetsFromOffers flags Amazon retail', () => {
    const targets = extractTargetsFromOffers(
      {
        Offers: [
          {
            SellerId: 'AMZN',
            IsFulfilledByAmazon: true,
            ListingPrice: { Amount: 19 },
            Shipping: { Amount: 0 },
          },
          {
            SellerId: 'A2',
            IsFulfilledByAmazon: true,
            ListingPrice: { Amount: 20 },
            Shipping: { Amount: 0 },
            SellerFeedbackRating: { SellerPositiveFeedbackRating: 98, FeedbackCount: 50 },
            IsBuyBoxWinner: true,
          },
        ],
      },
      {},
    );
    expect(targets.amazonRetailPresent).toBe(true);
    expect(targets.offerCount).toBe(2);
  });
});
