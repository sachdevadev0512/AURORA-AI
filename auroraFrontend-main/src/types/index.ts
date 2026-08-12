export interface ApiResponse<T> {
  success: boolean;
  data: T;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface User {
  _id: string;
  name: string;
  email: string;
  role: string;
  amazonSellerId?: string;
  marketplace?: 'NA' | 'EU' | 'FE';
  hasAmazonSpConnected?: boolean;
  hasAmazonAdsConnected?: boolean;
  adsLiveSyncEligible?: boolean;
  amazonAdsProfileMatch?: boolean | null;
}

export interface Profile extends User {
  token: string;
}

export interface MoneyValue {
  amount: number;
  currency: string;
}

export interface Product {
  _id: string;
  asin: string;
  sku: string;
  fnSku?: string;
  ean?: string;
  title: string;
  price: MoneyValue;
  shippingCost?: MoneyValue;
  minimumPrice?: MoneyValue;
  maximumPrice?: MoneyValue;
  businessPrice?: MoneyValue;
  lowestPrice?: MoneyValue;
  featuredOffer?: {
    isBuyBox: boolean;
    price: MoneyValue;
  };
  fees?: {
    totalFees: MoneyValue;
    referralFee?: MoneyValue;
    fbaFee: MoneyValue;
    breakdown?: Array<{
      feeType: string;
      amount: number;
      currency?: string;
    }>;
  };
  feesLastSynced?: string;
  inventory: {
    quantity: number;
    totalQuantity?: number;
    fulfillableQuantity?: number;
    reservedQuantity?: number;
    inboundQuantity?: number;
    unfulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedPendingCustomerOrder?: number;
    reservedPendingTransshipment?: number;
    reservedFcProcessing?: number;
    unfulfillableCustomerDamaged?: number;
    unfulfillableWarehouseDamaged?: number;
    unfulfillableDistributorDamaged?: number;
    unfulfillableCarrierDamaged?: number;
    unfulfillableDefective?: number;
    unfulfillableExpired?: number;
    fulfillmentChannel: string;
  };
  fulfillmentType?: 'FBA' | 'FBM' | 'UNKNOWN';
  images?: { url: string; height?: number; width?: number }[];
  category?: string;
  brand?: string;
  condition?: string;
  listingStatus?: string;
  isListedOnAmazon?: boolean;
  status: string;
  salesRank?: {
    rank: number;
    title?: string;
    classificationId?: string;
  };
  unitsSold?: number | null;
  pageViews?: number | null;
  listingCreatedDate?: string;
  lastSynced?: string;
  lastUpdatedTime?: string;
  repricer?: ProductRepricerConfig;
}

export interface OrderItem {
  asin: string;
  sellerSku: string;
  title: string;
  itemStatus?: string;
  quantityOrdered: number;
  quantityShipped?: number;
  itemPrice: {
    amount: number;
    currencyCode: string;
  };
  itemTax?: {
    amount: number;
    currencyCode: string;
  };
  shippingPrice?: {
    amount: number;
    currencyCode: string;
  };
  shippingTax?: {
    amount: number;
    currencyCode: string;
  };
  promotionDiscount?: {
    amount: number;
    currencyCode: string;
  };
  promotionIds?: string[];
  codFee?: {
    amount: number;
    currencyCode: string;
  };
  codFeeDiscount?: {
    amount: number;
    currencyCode: string;
  };
  isGift?: boolean;
  conditionId?: string;
  conditionSubtypeId?: string;
  fnsku?: string;
  productImage?: string;
  referralFee?: {
    amount: number;
    currencyCode: string;
  };
  fulfillmentFee?: {
    amount: number;
    currencyCode: string;
  };
  costOfGoodsSold?: {
    amount: number;
    currencyCode: string;
  };
  itemSubtotal?: {
    amount: number;
    currencyCode: string;
  };
}

export interface CustomerReturn {
  returnDate?: string;
  sku?: string;
  asin?: string;
  fnsku?: string;
  productName?: string;
  quantity?: number;
  fulfillmentCenterId?: string;
  disposition?: string;
  reason?: string;
  status?: string;
}

export interface OrderRefund {
  refundDate?: string;
  sku?: string;
  asin?: string;
  productName?: string;
  quantity?: number;
  amount?: number;
  currency?: string;
  marketplaceName?: string;
  source?: string;
  transactionStatus?: string;
  refundId?: string;
}

export interface Order {
  _id: string;
  sellerId: string;
  amazonOrderId: string;
  sellerOrderId?: string;
  purchaseDate: string;
  displayTimeZone?: string;
  lastUpdateDate?: string;
  orderStatus: 'Pending' | 'Unshipped' | 'PartiallyShipped' | 'Shipped' | 'InvoiceUnconfirmed' | 'Canceled' | 'Unfulfillable';
  fulfillmentChannel?: 'AFN' | 'MFN';
  salesChannel?: string;
  orderChannel?: string;
  shipServiceLevel?: string;
  shipmentServiceLevelCategory?: string;
  orderTotal: {
    amount: number;
    currencyCode: string;
  };
  numberOfItemsShipped?: number;
  numberOfItemsUnshipped?: number;
  paymentExecutionDetail?: Array<{
    payment: {
      amount: number;
      currencyCode: string;
    };
    paymentMethod: string;
  }>;
  paymentMethod?: string;
  paymentMethodDetails?: {
    paymentMethodDetail: string;
    paymentMethod: string;
  };
  marketplaceId?: string;
  marketplaceName?: string;
  buyerEmail?: string;
  buyerName?: string;
  buyerCounty?: string;
  buyerTaxInfo?: {
    companyLegalName?: string;
    taxingRegion?: string;
    taxClassifications?: Array<{
      name: string;
      value: string;
    }>;
  };
  shippingAddress?: {
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    county?: string;
    district?: string;
    stateOrRegion?: string;
    municipality?: string;
    postalCode?: string;
    countryCode?: string;
    phone?: string;
    addressType?: string;
  };
  orderItems: OrderItem[];
  hasCustomerReturn?: boolean;
  latestCustomerReturnDate?: string;
  customerReturns?: CustomerReturn[];
  hasRefund?: boolean;
  latestRefundDate?: string;
  latestReturnedActivityDate?: string;
  refunds?: OrderRefund[];
  isBusinessOrder?: boolean;
  isPrime?: boolean;
  isPremiumOrder?: boolean;
  isGlobalExpressEnabled?: boolean;
  isSoldByAB?: boolean;
  isIBA?: boolean;
  isReplacementOrder?: boolean;
  replacedOrderId?: string;
  promiseResponseDueDate?: string;
  isEstimatedShipDateSet?: boolean;
  isSoldBySeller?: boolean;
  defaultShipFromLocationAddress?: {
    name?: string;
    addressLine1?: string;
    city?: string;
    stateOrRegion?: string;
    postalCode?: string;
    countryCode?: string;
  };
  notes?: Array<{
    text: string;
    type: 'general' | 'shipping' | 'refund' | 'complaint' | 'internal';
    createdBy: string;
    createdAt: string;
  }>;
  lastSynced?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductRepricerConfig {
  enabled?: boolean;
  strategy?: 'MATCH_BUY_BOX' | 'MATCH_LOWEST' | 'BEAT_BUY_BOX' | 'BEAT_LOWEST';
  pricingMode?: 'PROFIT_FIRST' | 'BUY_BOX_FIRST' | 'SALES_GROWTH' | 'CLEARANCE';
  speedMode?: 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE';
  minPrice?: number | null;
  maxPrice?: number | null;
  currency?: string;
  beatByAmount?: number;
  cooldownMinutes?: number;
  maxChangePercent?: number;
  unitCost?: number | null;
  inboundShipping?: number | null;
  targetProfit?: number | null;
  minRoiPercent?: number | null;
  fbaOnly?: boolean;
  excludeAmazon?: boolean;
  minFeedbackPercent?: number | null;
  minFeedbackCount?: number | null;
  raiseWhenAlonePercent?: number | null;
  autoDisable?: boolean;
  dryRun?: boolean;
  lastRunAt?: string | null;
  lastChangeAt?: string | null;
  lastCompetitorPrice?: number | null;
  lastTargetPrice?: number | null;
  lastAction?: string | null;
  lastError?: string | null;
  hadBuyBox?: boolean | null;
}

export interface RepricerLog {
  _id: string;
  sku: string;
  asin?: string;
  strategy?: string;
  previousPrice?: number;
  competitorPrice?: number;
  targetPrice?: number;
  appliedPrice?: number;
  minPrice?: number;
  maxPrice?: number;
  action: string;
  reason?: string;
  dryRun?: boolean;
  source?: string;
  createdAt: string;
}

export interface ProductUpdatePayload {
  title?: string;
  price?: {
    amount: number;
    currency: string;
  };
  inventory?: {
    quantity: number;
    fulfillmentChannel: string;
  };
  status?: 'Active' | 'Inactive' | 'Incomplete' | 'Closed' | 'Out of Stock';
}

export interface AmazonCredentialsPayload {
  amazonSellerId: string;
  amazonRefreshToken: string;
  marketplace: 'NA' | 'EU' | 'FE';
}

export interface AmazonIntegrationCapability {
  key: string;
  title: string;
  description: string;
  enabled: boolean;
  route: string;
}

export interface AmazonConnectionStatus {
  success: boolean;
  isConnected: boolean;
  isAdsConnected: boolean;
  amazonAdsAccountId?: string | null;
  amazonAdsProfileIds?: string[];
  amazonAdsProfileMatch?: boolean | null;
  amazonSellerId: string | null;
  marketplace: string | null;
  amazonMarketplaceIds?: string[];
  isVerified: boolean;
  orderNotificationsEnabled?: boolean;
  orderNotificationsSubscribedAt?: string | null;
  capabilities: AmazonIntegrationCapability[];
}

export interface Ad {
  _id: string;
  sellerId: string;
  profileId?: string;
  campaignId: string;
  campaignName: string;
  status: 'Active' | 'Paused' | 'Archived';
  country?: string;
  campaignType: 'Sponsored Products' | 'Sponsored Brands' | 'Sponsored Display';
  portfolio?: string;
  startDate?: string;
  endDate?: string;
  budget?: {
    amount: number;
    currencyCode: string;
  };
  spend?: {
    amount: number;
    currencyCode: string;
  };
  cpc?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  detailPageViews?: number;
  clickShare?: number;
  orders?: number;
  sales?: {
    amount: number;
    currencyCode: string;
  };
  conversionRate?: number;
  unitsSold?: number;
  acos?: number;
  roas?: number;
  tacos?: number;
  profitMarginImpact?: number;
  brandedSearches?: number;
  newToBrandOrders?: number;
  searchTermCoverage?: string[];
  metricsStartDate?: string;
  metricsEndDate?: string;
  lastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

export type CampaignType = 'Sponsored Products' | 'Sponsored Brands' | 'Sponsored Display';

export interface AdsProfile {
  profileId: string;
  countryCode?: string;
  currencyCode?: string;
  timezone?: string;
  marketplaceStringId?: string | null;
  name?: string | null;
}

export interface AdsPortfolio {
  portfolioId: string;
  name: string;
  state?: string;
}

export interface CampaignKeywordInput {
  keywordText: string;
  matchType: 'EXACT' | 'PHRASE' | 'BROAD';
  bid?: number;
  state?: 'Active' | 'Paused' | 'Archived';
}

export interface CampaignNegativeKeywordInput {
  keywordText: string;
  matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE';
  state?: 'Active' | 'Paused' | 'Archived';
}

export interface CampaignProductAdInput {
  sku?: string;
  asin?: string;
  state?: 'Active' | 'Paused' | 'Archived';
}

export interface CampaignAdGroupInput {
  name: string;
  defaultBid: number;
  state?: 'Active' | 'Paused' | 'Archived';
  productAds: CampaignProductAdInput[];
  keywords: CampaignKeywordInput[];
  negativeKeywords: CampaignNegativeKeywordInput[];
  bidOptimization?: 'clicks' | 'conversions' | 'reach';
  tactic?: 'T00020' | 'T00030';
}

export interface CampaignSettingsInput {
  name: string;
  state: 'Active' | 'Paused' | 'Archived';
  startDate: string;
  endDate?: string;
  dailyBudget: number;
  portfolioId?: string;
  targetingType?: 'AUTO' | 'MANUAL';
  biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL';
  placementBidding?: { placement: string; percentage: number }[];
  brandEntityId?: string;
  costType?: 'cpc' | 'vcpm';
  tactic?: 'T00020' | 'T00030';
}

export interface SbCreativeInput {
  name?: string;
  brandName: string;
  headline: string;
  asins: string[];
  brandLogoAssetId?: string;
  state?: 'Active' | 'Paused' | 'Archived';
}

export interface CreateCampaignPayload {
  profileId: string;
  campaignType: CampaignType;
  campaign: CampaignSettingsInput;
  adGroups: CampaignAdGroupInput[];
  sbCreative?: SbCreativeInput;
}

export type ShipmentType = 'fba_fc' | 'awd_dc';

export interface ShipmentTrackingPackage {
  boxId?: string | null;
  trackingId?: string | null;
  carrierName?: string | null;
  packageStatus?: string | null;
}

export interface ShipmentLineItem {
  sku: string;
  fnsku?: string | null;
  unitsExpected: number;
  unitsReceived: number;
  variance: number;
}

export interface ShipmentDiscrepancy {
  type: string;
  label: string;
  message: string;
  expected?: number;
  actual?: number;
  variance?: number;
  sku?: string;
}

export interface ShipmentStatusEvent {
  status: string;
  displayStatus: string;
  at: string;
}

export interface Shipment {
  _id: string;
  shipmentType: ShipmentType;
  shipmentId: string;
  referenceId?: string | null;
  shipmentName?: string | null;
  orderId?: string | null;
  createdDate?: string | null;
  lastUpdatedDate?: string | null;
  shipDate?: string | null;
  skuCount?: number;
  unitsExpected?: number | null;
  unitsLocated?: number | null;
  boxesExpected?: number | null;
  boxesReceived?: number | null;
  status: string;
  displayStatus: string;
  trackingId?: string | null;
  carrierName?: string | null;
  inboundPlanId?: string | null;
  estimatedDeliveryDate?: string | null;
  destinationCenterId?: string | null;
  trackingPackages?: ShipmentTrackingPackage[];
  lineItems?: ShipmentLineItem[];
  hasDiscrepancy?: boolean;
  discrepancies?: ShipmentDiscrepancy[];
  statusTimeline?: ShipmentStatusEvent[];
  lastTrackedAt?: string | null;
  isLiveTracking?: boolean;
  isDelayed?: boolean;
  daysLate?: number;
  lastSynced?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DelayedShipmentSummaryItem {
  _id: string;
  shipmentId: string;
  shipmentType: ShipmentType;
  displayStatus: string;
  status: string;
  estimatedDeliveryDate?: string | null;
  referenceId?: string | null;
  trackingId?: string | null;
  daysLate: number;
}

export interface DelayedShipmentsSummary {
  count: number;
  shipments: DelayedShipmentSummaryItem[];
}
