import { ApiResponse, Order, Product, Profile, ProductUpdatePayload, AmazonCredentialsPayload, AmazonConnectionStatus, Ad, ProductRepricerConfig, RepricerLog } from '../types';

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL ||
  (import.meta as any).env?.VITE_API_URL ||
  'http://localhost:5000/api';

export async function apiFetch<T>(path: string, options: RequestInit = {}) {
  const { headers: optionHeaders, ...rest } = options;
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(optionHeaders || {}),
    },
  });

  if (response.status === 204) {
    return {} as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText || 'API request failed';
    throw new Error(message);
  }

  if (payload == null && response.ok) {
    throw new Error('Empty response from server (try a hard refresh)');
  }

  return payload as T;
}

function tokenHeaders(token: string | null) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(email: string, password: string) {
  return await apiFetch<Profile>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function register(name: string, email: string, password: string) {
  return await apiFetch<Profile>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
}

export async function getMe(token: string) {
  return await apiFetch<ApiResponse<Profile>>('/auth/me', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function updateAmazonCredentials(token: string, payload: AmazonCredentialsPayload) {
  return await apiFetch<ApiResponse<Profile>>('/auth/amazon-credentials', {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(payload),
  });
}

export async function getProducts(
  token: string,
  page = 1,
  limit = 25,
  search?: string,
  status?: string,
  stock?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  listing?: string,
  fulfillment?: string,
) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  if (stock) query.set('stock', stock);
  if (sortBy) query.set('sortBy', sortBy);
  if (sortOrder) query.set('sortOrder', sortOrder);
  if (listing) query.set('listing', listing);
  if (fulfillment) query.set('fulfillment', fulfillment);
  query.set('_t', String(Date.now()));

  return await apiFetch<ApiResponse<Product[]>>(
    `/products?${query.toString()}`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
}

export async function getProduct(token: string, id: string) {
  return await apiFetch<ApiResponse<Product>>(`/products/${id}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function syncProducts(token: string) {
  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    message: string;
    processed?: number;
    alreadyRunning?: boolean;
    resumed?: boolean;
  }>('/products/sync', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function reconcileProductListings(token: string) {
  return await apiFetch<{
    success: boolean;
    message: string;
    data?: { liveSkusOnAmazon: number; verified: number; removed: number };
  }>('/products/reconcile-listings', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getInventorySyncStatus(token: string) {
  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    processed: number;
    saved?: number;
    skipped?: number;
    failed?: number;
    phase?: string;
    message?: string | null;
    startedAt?: string | null;
    stoppedByUser?: boolean;
    error?: string | null;
  }>(`/products/sync/status?_t=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function stopInventorySync(token: string) {
  return await apiFetch<{ success: boolean; stopped: boolean; processed?: number; reason?: string }>(
    '/products/sync/stop',
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
}

export async function exportProductsCsv(
  token: string,
  search?: string,
  status?: string,
  stock?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  listing?: string,
  fulfillment?: string,
  report?: string,
) {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  if (stock) query.set('stock', stock);
  if (sortBy) query.set('sortBy', sortBy);
  if (sortOrder) query.set('sortOrder', sortOrder);
  if (listing) query.set('listing', listing);
  if (fulfillment) query.set('fulfillment', fulfillment);
  if (report) query.set('report', report);

  const response = await fetch(`${API_BASE}/products/export?${query.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(error.error || 'Export failed');
  }

  return await response.blob();
}

export async function updateProduct(token: string, id: string, payload: ProductUpdatePayload) {
  return await apiFetch<ApiResponse<Product>>(`/products/${id}`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(payload),
  });
}

export async function configureProductRepricer(
  token: string,
  id: string,
  payload: ProductRepricerConfig,
) {
  return await apiFetch<ApiResponse<Product>>(`/products/${id}/repricer`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(payload),
  });
}

export async function runProductRepricer(
  token: string,
  id: string,
  options: { dryRun?: boolean } = {},
) {
  return await apiFetch<ApiResponse<{ product: Product; result: Record<string, unknown> }>>(
    `/products/${id}/repricer/run`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(options),
    },
  );
}

export async function runAllRepricers(token: string) {
  return await apiFetch<ApiResponse<Record<string, unknown>>>('/products/repricer/run-all', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getProductRepricerLogs(token: string, id: string, limit = 20, page = 1) {
  return await apiFetch<ApiResponse<RepricerLog[]> & { pagination?: { total: number; page: number; limit: number; pages: number } }>(
    `/products/${id}/repricer/logs?limit=${limit}&page=${page}`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );
}

export async function getAllRepricerLogs(token: string, limit = 25, page = 1) {
  return await apiFetch<
    ApiResponse<RepricerLog[]> & {
      pagination?: { total: number; page: number; limit: number; pages: number };
    }
  >(`/products/repricer/logs?limit=${limit}&page=${page}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function bulkConfigureRepricer(
  token: string,
  productIds: string[],
  config: ProductRepricerConfig,
) {
  return await apiFetch<ApiResponse<{ updated: number; results: Array<Record<string, unknown>> }>>(
    '/products/repricer/bulk',
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ productIds, config }),
    },
  );
}

export async function bulkSetListingPrices(
  token: string,
  productIds: string[],
  amount: number,
  options: { currency?: string; dryRun?: boolean } = {},
) {
  return await apiFetch<
    ApiResponse<{
      updated: number;
      previewed: number;
      errors: number;
      results: Array<Record<string, unknown>>;
    }>
  >('/products/repricer/bulk-price', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({
      productIds,
      amount,
      currency: options.currency,
      dryRun: options.dryRun === true,
    }),
  });
}

export async function getRepricerDashboard(token: string) {
  return await apiFetch<
    ApiResponse<{
      activeRules: number;
      rulesTriggeredToday: number;
      priceChangesToday: number;
      errorsToday: number;
      minimumHitsToday: number;
      profitProtectionHitsToday: number;
      roiProtectionHitsToday: number;
      currentlyWinningBuyBox: number;
      buyBoxRecoveriesToday: number;
      recentProducts: Product[];
      recentLogs: RepricerLog[];
    }>
  >('/products/repricer/dashboard', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function deleteProduct(token: string, id: string) {
  return await apiFetch<ApiResponse<{}>>(`/products/${id}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getOrders(
  token: string,
  page = 1,
  limit = 25,
  status?: string,
  fulfillmentChannel?: string,
  startDate?: string,
  endDate?: string,
  search?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  days?: number,
  salesChannel?: string,
  orderType?: string,
  timeZone?: string,
) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) query.set('status', status);
  if (fulfillmentChannel) query.set('fulfillmentChannel', fulfillmentChannel);
  if (startDate) query.set('startDate', startDate);
  if (endDate) query.set('endDate', endDate);
  if (days != null && Number.isFinite(days)) query.set('days', String(days));
  if (search) query.set('search', search);
  if (sortBy) query.set('sortBy', sortBy);
  if (sortOrder) query.set('sortOrder', sortOrder);
  if (salesChannel) query.set('salesChannel', salesChannel);
  if (orderType) query.set('orderType', orderType);
  if (timeZone) query.set('timeZone', timeZone);
  query.set('_t', String(Date.now()));
  return await apiFetch<ApiResponse<Order[]>>(
    `/orders?${query.toString()}`,
    {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
}

export async function getOrder(token: string, id: string) {
  const query = new URLSearchParams({ _t: String(Date.now()) });
  return await apiFetch<ApiResponse<Order>>(`/orders/${id}?${query.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function syncOrders(token: string, startDate?: string, endDate?: string) {
  const query = new URLSearchParams();
  if (startDate) query.set('startDate', startDate);
  if (endDate) query.set('endDate', endDate);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    message: string;
    processed?: number;
    alreadyRunning?: boolean;
  }>(`/orders/sync${suffix}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getOrderSyncStatus(token: string) {
  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    stopping?: boolean;
    processed: number;
    phase?: string;
    message?: string | null;
    startedAt?: string | null;
    stoppedByUser?: boolean;
    error?: string | null;
  }>('/orders/sync/status', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function stopOrderSync(token: string) {
  return await apiFetch<{
    success: boolean;
    stopped: boolean;
    processed?: number;
    stopping?: boolean;
    syncing?: boolean;
    message?: string;
    reason?: string;
  }>(
    '/orders/sync/stop',
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
}

export async function getOrderStats(token: string) {
  return await apiFetch<ApiResponse<{ totalOrders: number; totalRevenue: number; averageOrderValue: number; ordersByStatus: Record<string, number> }>>('/orders/stats/summary', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export interface OrderAnalytics {
  period: {
    startDate: string;
    endDate: string;
    days: number;
    preset?: string;
    chartGranularity?: 'day' | 'month';
  };
  summary: {
    totalOrders: number;
    totalRevenue: number;
    totalItems: number;
    averageOrderValue: number;
  };
  allTimeSummary: {
    totalOrders: number;
    totalRevenue: number;
    totalItems: number;
    averageOrderValue: number;
  };
  previousSummary: {
    totalOrders: number;
    totalRevenue: number;
    averageOrderValue: number;
  };
  productCounts: {
    active: number;
    listed: number;
  };
  statusBuckets: Array<{ _id: string; count: number }>;
  statusBreakdown: Array<{ _id: string; count: number; revenue: number }>;
  dailySales: Array<{ _id: string; revenue: number; orders: number; items?: number }>;
  chartSales: Array<{ _id: string; revenue: number; orders: number }>;
  monthlySales: Array<{ _id: string; revenue: number; orders: number }>;
}

export type DashboardDatePreset = 7 | 15 | 30 | 90 | 'custom';

export interface OrderAnalyticsQuery {
  days?: number;
  startDate?: string;
  endDate?: string;
}

export async function getOrderAnalytics(token: string, query: OrderAnalyticsQuery = { days: 30 }) {
  const params = new URLSearchParams();
  if (query.startDate && query.endDate) {
    params.set('startDate', query.startDate);
    params.set('endDate', query.endDate);
  } else {
    params.set('days', String(query.days ?? 30));
  }

  return await apiFetch<ApiResponse<OrderAnalytics>>(`/orders/analytics?${params.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function bulkUpdateOrderStatus(token: string, orderIds: string[], status: string) {
  return await apiFetch<ApiResponse<{ modifiedCount: number; matchedCount: number }>>('/orders/bulk/status', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ orderIds, status }),
  });
}

export async function downloadOrdersCsvExport(
  token: string,
  options: {
    orderIds?: string[];
    status?: string;
    fulfillmentChannel?: string;
    salesChannel?: string;
    orderType?: string;
    startDate?: string;
    endDate?: string;
    days?: number;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    timeZone?: string;
  } = {},
) {
  const params = new URLSearchParams();
  if (options.orderIds?.length) {
    params.set('orderIds', options.orderIds.join(','));
  }
  if (options.status) params.set('status', options.status);
  if (options.fulfillmentChannel) params.set('fulfillmentChannel', options.fulfillmentChannel);
  if (options.salesChannel) params.set('salesChannel', options.salesChannel);
  if (options.orderType) params.set('orderType', options.orderType);
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.days != null && Number.isFinite(options.days)) {
    params.set('days', String(options.days));
  }
  if (options.search) params.set('search', options.search);
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortOrder) params.set('sortOrder', options.sortOrder);
  if (options.timeZone) params.set('timeZone', options.timeZone);

  const response = await fetch(`${API_BASE}/orders/export/csv?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(error.error || 'Export failed');
  }

  return await response.blob();
}

export async function bulkExportOrders(
  token: string,
  options: {
    orderIds?: string[];
    format?: 'csv' | 'json';
    status?: string;
    fulfillmentChannel?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {},
) {
  const {
    orderIds,
    format = 'csv',
    status,
    fulfillmentChannel,
    startDate,
    endDate,
    search,
    sortBy,
    sortOrder,
  } = options;

  const body = {
    ...(orderIds && orderIds.length > 0 ? { orderIds } : {}),
    format,
    ...(status ? { status } : {}),
    ...(fulfillmentChannel ? { fulfillmentChannel } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(search ? { search } : {}),
    ...(sortBy ? { sortBy } : {}),
    ...(sortOrder ? { sortOrder } : {}),
  };

  if (format === 'csv') {
    const response = await fetch(`${API_BASE}/orders/bulk/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(error.error || 'Export failed');
    }

    return await response.blob();
  }

  return await apiFetch<ApiResponse<Order[]>>('/orders/bulk/export', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

export async function updateOrderStatus(token: string, orderId: string, status: string) {
  return await apiFetch<ApiResponse<Order>>(`/orders/${orderId}/status`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ status }),
  });
}

export async function addOrderNote(token: string, orderId: string, note: string, noteType: string = 'general') {
  return await apiFetch<ApiResponse<{ text: string; type: string; createdBy: string; createdAt: string }>>(`/orders/${orderId}/notes`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ note, noteType }),
  });
}

// Amazon OAuth API functions
export async function initiateAmazonOAuth(token: string) {
  return await apiFetch<{ success: boolean; authorizationURL: string; state: string }>('/auth/amazon/authorize', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function initiateAmazonAdsOAuth(token: string) {
  return await apiFetch<{ success: boolean; authorizationURL: string; state: string }>('/auth/amazon/ads-authorize', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function handleAmazonCallback(code: string, state: string) {
  // This is handled server-side, but we can provide a client-side helper
  const query = new URLSearchParams({ code, state });
  return await apiFetch<{ success: boolean; message: string }>('/auth/amazon/callback', {
    method: 'GET',
  });
}

export async function disconnectAmazon(token: string) {
  return await apiFetch<{ success: boolean; message: string }>('/auth/amazon/disconnect', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getConnectionStatus(token: string) {
  return await apiFetch<AmazonConnectionStatus>('/auth/amazon/connection-status', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export interface GetAdsResponse {
  ads: Ad[];
  pagination?: { page: number; limit: number; total: number; pages: number };
  totalPages: number;
  currentPage: number;
  totalAds: number;
  adsAccessBlocked?: boolean;
  adsSellerMismatch?: {
    aligned: boolean;
    reason: string;
    spSeller?: string;
    adsAccount?: string | null;
  } | null;
  metricsPeriod?: {
    startDate?: string;
    endDate?: string;
    timeZone: string;
    isCustomRange: boolean;
    isLifetime?: boolean;
    isPartialLifetime?: boolean;
    label?: string;
    dataAvailableFrom?: string | null;
    dataAvailableTo?: string | null;
    lifetimeTargetFrom?: string | null;
    lifetimeTargetTo?: string | null;
    retentionNote?: string;
    lifetimeSource?: 'api' | 'seller_central';
    attributionWindow: string;
  };
  metricsSyncing?: boolean;
  reportErrors?: Array<{
    profileId: string;
    campaignType: string;
    startDate?: string;
    endDate?: string;
    error: string;
  }>;
}

export async function getAds(
  token: string,
  page = 1,
  limit = 10,
  status?: string,
  campaignType?: string,
  startDate?: string,
  endDate?: string,
  search?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc'
): Promise<GetAdsResponse> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
  });
  if (status) params.append('status', status);
  if (campaignType) params.append('campaignType', campaignType);
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);
  if (search) params.append('search', search);
  if (sortBy) params.append('sortBy', sortBy);
  if (sortOrder) params.append('sortOrder', sortOrder);

  const response = await fetch(`${API_BASE}/ads?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Failed to fetch ads');
  return response.json();
}

export async function getAd(token: string, id: string): Promise<Ad> {
  const response = await fetch(`${API_BASE}/ads/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Failed to fetch ad');
  return response.json();
}

export async function createAd(token: string, ad: Omit<Ad, '_id' | 'sellerId' | 'createdAt' | 'updatedAt'>): Promise<Ad> {
  const response = await fetch(`${API_BASE}/ads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(ad),
  });
  if (!response.ok) throw new Error('Failed to create ad');
  return response.json();
}

export async function updateAd(token: string, id: string, ad: Partial<Ad>): Promise<Ad> {
  const response = await fetch(`${API_BASE}/ads/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(ad),
  });
  if (!response.ok) throw new Error('Failed to update ad');
  return response.json();
}

export async function deleteAd(token: string, id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/ads/${id}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Failed to delete ad');
}

export async function syncAds(token: string): Promise<{
  message: string;
  count: number;
  details?: string | string[];
  lastSyncAt?: string;
  metricsSyncing?: boolean;
  metrics?: {
    campaignsUpdated?: number;
    reportsRequested?: number;
    reportErrors?: number;
    metricsStartDate?: string;
    metricsEndDate?: string;
    skipped?: boolean;
    message?: string;
    error?: string;
  };
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15 * 60 * 1000);

  const response = await fetch(`${API_BASE}/ads/sync`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || 'Failed to sync ads');
  return payload;
}

export async function getAdStats(
  token: string,
  startDate?: string,
  endDate?: string
): Promise<{
  totalAds: number;
  activeAds: number;
  totalSpend: number;
  totalSales: number;
  totalImpressions: number;
  totalClicks: number;
  totalOrders: number;
  avgAcos: number;
  avgRoas: number;
  metricsPeriod?: {
    startDate?: string;
    endDate?: string;
    timeZone: string;
    isCustomRange: boolean;
    isLifetime?: boolean;
    isPartialLifetime?: boolean;
    label?: string;
    dataAvailableFrom?: string | null;
    dataAvailableTo?: string | null;
    lifetimeTargetFrom?: string | null;
    lifetimeTargetTo?: string | null;
    retentionNote?: string;
    lifetimeSource?: 'api' | 'seller_central';
    attributionWindow: string;
  };
  metricsSyncing?: boolean;
  reportErrors?: Array<{
    profileId: string;
    campaignType: string;
    startDate?: string;
    endDate?: string;
    error: string;
  }>;
  adsAccessBlocked?: boolean;
}> {
  const params = new URLSearchParams();
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);

  const response = await fetch(`${API_BASE}/ads/stats?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Failed to fetch ad stats');
  return response.json();
}

export async function downloadAdsReport(
  token: string,
  options: {
    startDate?: string;
    endDate?: string;
    status?: string;
    campaignType?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  if (options.status) params.append('status', options.status);
  if (options.campaignType) params.append('campaignType', options.campaignType);
  if (options.search) params.append('search', options.search);
  if (options.sortBy) params.append('sortBy', options.sortBy);
  if (options.sortOrder) params.append('sortOrder', options.sortOrder);

  const response = await fetch(`${API_BASE}/ads/export?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || 'Failed to download ads report');
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] || `aurora-ads-report-${new Date().toISOString().slice(0, 10)}.csv`;

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export async function getAdsProfiles(token: string): Promise<{ profiles: import('../types').AdsProfile[] }> {
  const response = await fetch(`${API_BASE}/ads/profiles`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || 'Failed to fetch advertising profiles');
  return payload;
}

export async function getAdsPortfolios(
  token: string,
  profileId: string,
): Promise<{ portfolios: import('../types').AdsPortfolio[] }> {
  const params = new URLSearchParams({ profileId });
  const response = await fetch(`${API_BASE}/ads/portfolios?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || 'Failed to fetch portfolios');
  return payload;
}

export async function createAmazonCampaign(
  token: string,
  payload: import('../types').CreateCampaignPayload,
): Promise<{
  message: string;
  campaignId: string;
  ad: Ad;
  details?: Record<string, unknown>;
}> {
  const response = await fetch(`${API_BASE}/ads/campaigns/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detailText = Array.isArray(body?.details)
      ? body.details
          .map((entry: { messages?: string[] }) => entry.messages?.join('; '))
          .filter(Boolean)
          .join(' | ')
      : '';
    throw new Error([body?.message, detailText].filter(Boolean).join(' — '));
  }
  return body;
}

export async function getShipments(
  token: string,
  page = 1,
  limit = 25,
  type?: 'fba_fc' | 'awd_dc' | '',
  status?: string,
  lastUpdated?: string,
  startDate?: string,
  endDate?: string,
  search?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  delayed?: boolean,
) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  if (lastUpdated) query.set('lastUpdated', lastUpdated);
  if (startDate) query.set('startDate', startDate);
  if (endDate) query.set('endDate', endDate);
  if (search) query.set('search', search);
  if (sortBy) query.set('sortBy', sortBy);
  if (sortOrder) query.set('sortOrder', sortOrder);
  if (delayed) query.set('delayed', 'true');
  query.set('_t', String(Date.now()));

  return await apiFetch<
    ApiResponse<import('../types').Shipment[]> & {
      filters?: { statusOptions?: string[] };
      delayedSummary?: import('../types').DelayedShipmentsSummary;
    }
  >(`/shipments?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getDelayedShipmentsSummary(token: string, limit = 10) {
  return await apiFetch<ApiResponse<import('../types').DelayedShipmentsSummary>>(
    `/shipments/delayed/summary?limit=${limit}&_t=${Date.now()}`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );
}

export async function getShipment(token: string, id: string) {
  return await apiFetch<ApiResponse<import('../types').Shipment>>(`/shipments/${id}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function refreshShipmentTracking(token: string, id: string) {
  return await apiFetch<ApiResponse<import('../types').Shipment>>(`/shipments/${id}/track`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function syncShipments(token: string) {
  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    message: string;
    jobId?: string;
  }>('/shipments/sync', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getShipmentSyncStatus(token: string) {
  return await apiFetch<{
    success: boolean;
    syncing: boolean;
    stopping?: boolean;
    stopRequested?: boolean;
    processed: number;
    saved?: number;
    failed?: number;
    phase?: string;
    message?: string | null;
  }>(`/shipments/sync/status?_t=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function stopShipmentSync(token: string) {
  return await apiFetch<{ success: boolean; message: string; syncing?: boolean }>(
    '/shipments/sync/stop',
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
}

export async function exportShipmentsCsv(
  token: string,
  type?: 'fba_fc' | 'awd_dc' | '',
  status?: string,
  lastUpdated?: string,
  startDate?: string,
  endDate?: string,
  search?: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
) {
  const query = new URLSearchParams();
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  if (lastUpdated) query.set('lastUpdated', lastUpdated);
  if (startDate) query.set('startDate', startDate);
  if (endDate) query.set('endDate', endDate);
  if (search) query.set('search', search);
  if (sortBy) query.set('sortBy', sortBy);
  if (sortOrder) query.set('sortOrder', sortOrder);

  const response = await fetch(`${API_BASE}/shipments/export?${query.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(error.error || 'Export failed');
  }

  return await response.blob();
}
