import { apiFetch } from './index';

export type NotificationSource = 'amazon' | 'aurora';

export type UserNotificationType =
  | 'order_change'
  | 'amazon_order'
  | 'amazon_orders_batch'
  | 'amazon_live_enabled'
  | 'orders_sync'
  | 'ads_sync'
  | 'ads_sync_error'
  | 'product_fee_change'
  | 'inventory_sync'
  | 'shipment_delayed'
  | 'info';

export interface NotificationListParams {
  limit?: number;
  unreadOnly?: boolean;
  category?: string;
  productId?: string;
  orderId?: string;
}

export interface UserNotification {
  _id: string;
  source?: NotificationSource;
  type: UserNotificationType;
  title: string;
  message: string;
  link?: string | null;
  read: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationsResponse {
  success: boolean;
  notifications: UserNotification[];
  unreadCount: number;
  total: number;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function getUserNotifications(
  token: string,
  params: NotificationListParams = {},
): Promise<NotificationsResponse> {
  const limit = params.limit ?? 30;
  const searchParams = new URLSearchParams({
    limit: String(limit),
    _t: String(Date.now()),
  });
  if (params.unreadOnly) searchParams.set('unreadOnly', 'true');
  if (params.category) searchParams.set('category', params.category);
  if (params.productId) searchParams.set('productId', params.productId);
  if (params.orderId) searchParams.set('orderId', params.orderId);

  return apiFetch<NotificationsResponse>(`/user-notifications?${searchParams.toString()}`, {
    headers: authHeaders(token),
    cache: 'no-store',
  });
}

export async function markAllNotificationsRead(
  token: string,
  params: Pick<NotificationListParams, 'category' | 'productId' | 'orderId'> = {},
): Promise<{ success: boolean; unreadCount: number }> {
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set('category', params.category);
  if (params.productId) searchParams.set('productId', params.productId);
  if (params.orderId) searchParams.set('orderId', params.orderId);
  const query = searchParams.toString();

  return apiFetch(`/user-notifications/read-all${query ? `?${query}` : ''}`, {
    method: 'PATCH',
    headers: authHeaders(token),
  });
}

export async function markNotificationRead(token: string, id: string): Promise<{ success: boolean; unreadCount: number }> {
  return apiFetch(`/user-notifications/${id}/read`, {
    method: 'PATCH',
    headers: authHeaders(token),
  });
}
