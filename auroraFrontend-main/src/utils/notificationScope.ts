import type { UserNotification, UserNotificationType } from '../api/userNotificationsAPI';

export type NotificationCategory = 'all' | 'orders' | 'products' | 'ads' | 'shipments';

export interface NotificationScope {
  category: NotificationCategory;
  entityId?: string;
}

const ORDER_TYPES = new Set<UserNotificationType>([
  'order_change',
  'amazon_order',
  'amazon_orders_batch',
  'orders_sync',
]);

const PRODUCT_TYPES = new Set<UserNotificationType>([
  'product_fee_change',
  'inventory_sync',
]);

const ADS_TYPES = new Set<UserNotificationType>(['ads_sync_error']);

const SHIPMENT_TYPES = new Set<UserNotificationType>(['shipment_delayed']);

/** Never show in the bell — sync confirmations and setup toasts. */
export const SUPPRESSED_INBOX_TYPES = new Set<UserNotificationType>([
  'ads_sync',
  'amazon_live_enabled',
]);

export function isSuppressedInboxNotification(
  notification: Pick<UserNotification, 'type'>,
): boolean {
  return SUPPRESSED_INBOX_TYPES.has(notification.type);
}

export function resolveNotificationScope(pathname: string, entityId?: string): NotificationScope {
  if (pathname.startsWith('/products/') && entityId) {
    return { category: 'products', entityId };
  }
  if (pathname.startsWith('/products')) {
    return { category: 'products' };
  }
  if (pathname.startsWith('/orders/') && entityId) {
    return { category: 'orders', entityId };
  }
  if (pathname.startsWith('/orders')) {
    return { category: 'orders' };
  }
  if (pathname.startsWith('/ads')) {
    return { category: 'ads' };
  }
  if (pathname.startsWith('/shipments')) {
    return { category: 'shipments' };
  }
  return { category: 'all' };
}

export function notificationMatchesScope(
  notification: UserNotification,
  scope: NotificationScope,
): boolean {
  if (scope.category === 'all') return true;

  if (scope.category === 'orders') {
    if (!ORDER_TYPES.has(notification.type)) return false;
    if (!scope.entityId) return true;
    return (
      notification.metadata?.orderId === scope.entityId ||
      notification.link === `/orders/${scope.entityId}`
    );
  }

  if (scope.category === 'products') {
    if (!PRODUCT_TYPES.has(notification.type)) return false;
    if (!scope.entityId) return true;
    return (
      notification.metadata?.productId === scope.entityId ||
      notification.link === `/products/${scope.entityId}`
    );
  }

  if (scope.category === 'ads') {
    return ADS_TYPES.has(notification.type);
  }

  if (scope.category === 'shipments') {
    return SHIPMENT_TYPES.has(notification.type);
  }

  return true;
}

export function filterNotificationsByScope(
  notifications: UserNotification[],
  scope: NotificationScope,
): UserNotification[] {
  return notifications.filter((notification) => notificationMatchesScope(notification, scope));
}

export function scopeQueryParams(scope: NotificationScope): Record<string, string> {
  if (scope.category === 'all') return {};

  const params: Record<string, string> = { category: scope.category };
  if (scope.category === 'products' && scope.entityId) {
    params.productId = scope.entityId;
  }
  if (scope.category === 'orders' && scope.entityId) {
    params.orderId = scope.entityId;
  }
  return params;
}

export function scopePanelTitle(scope: NotificationScope): string {
  if (scope.entityId && scope.category === 'products') return 'Product notifications';
  if (scope.entityId && scope.category === 'orders') return 'Order notifications';
  if (scope.category === 'products') return 'Product notifications';
  if (scope.category === 'orders') return 'Order notifications';
  if (scope.category === 'ads') return 'Ads notifications';
  if (scope.category === 'shipments') return 'Shipment notifications';
  return 'Notifications';
}

export function scopeEmptyMessage(scope: NotificationScope): string {
  if (scope.entityId && scope.category === 'products') {
    return 'No notifications for this product yet.';
  }
  if (scope.entityId && scope.category === 'orders') {
    return 'No notifications for this order yet.';
  }
  if (scope.category === 'products') {
    return 'No product notifications yet. Fee changes and inventory sync updates will appear here.';
  }
  if (scope.category === 'orders') {
    return 'No order notifications yet. Amazon order updates and sync results will appear here.';
  }
  if (scope.category === 'ads') {
    return 'No ads notifications yet. Campaign sync updates will appear here.';
  }
  if (scope.category === 'shipments') {
    return 'No shipment notifications yet. Delay alerts for overdue inbound shipments will appear here.';
  }
  return 'No notifications yet. Amazon order updates and Aurora sync activity will appear here.';
}

export function scopeFooterLink(scope: NotificationScope): { to: string; label: string } {
  if (scope.category === 'products') {
    return { to: scope.entityId ? `/products/${scope.entityId}` : '/products', label: 'View products' };
  }
  if (scope.category === 'orders') {
    return { to: scope.entityId ? `/orders/${scope.entityId}` : '/orders', label: 'View orders' };
  }
  if (scope.category === 'ads') {
    return { to: '/ads', label: 'View ads' };
  }
  if (scope.category === 'shipments') {
    return { to: '/shipments', label: 'View shipments' };
  }
  return { to: '/orders', label: 'View orders' };
}
