import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Bell, CheckCheck, Package, Megaphone, AlertCircle, Info, ShoppingBag, DollarSign } from 'lucide-react';
import type { NotificationSource } from '../api/userNotificationsAPI';
import { useNotifications } from '../context/NotificationContext';
import type { UserNotification } from '../api/userNotificationsAPI';
import {
  filterNotificationsByScope,
  resolveNotificationScope,
  scopeEmptyMessage,
  scopeFooterLink,
  scopePanelTitle,
} from '../utils/notificationScope';

function formatTime(iso: string) {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  } catch {
    return '';
  }
}

function resolveSource(n: UserNotification): NotificationSource {
  if (n.source === 'amazon' || n.source === 'aurora') return n.source;
  if (n.metadata?.source === 'amazon') return 'amazon';
  if (
    n.type === 'amazon_order' ||
    n.type === 'amazon_orders_batch' ||
    n.type === 'amazon_live_enabled' ||
    n.type === 'order_change' ||
    n.type === 'product_fee_change'
  ) {
    return 'amazon';
  }
  return 'aurora';
}

function NotificationIcon({ type }: { type: UserNotification['type'] }) {
  const size = 16;
  switch (type) {
    case 'order_change':
    case 'amazon_order':
    case 'amazon_orders_batch':
    case 'amazon_live_enabled':
    case 'orders_sync':
      return <Package size={size} />;
    case 'product_fee_change':
    case 'inventory_sync':
      return <DollarSign size={size} />;
    case 'ads_sync':
      return <Megaphone size={size} />;
    case 'ads_sync_error':
      return <AlertCircle size={size} />;
    default:
      return <Info size={size} />;
  }
}

export default function NotificationBell() {
  const { notifications, loading, markRead, markAllRead } = useNotifications();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const scope = useMemo(
    () => resolveNotificationScope(location.pathname, id),
    [location.pathname, id],
  );

  const visibleNotifications = useMemo(
    () => filterNotificationsByScope(notifications, scope),
    [notifications, scope],
  );

  const visibleUnreadCount = useMemo(
    () => visibleNotifications.filter((notification) => !notification.read).length,
    [visibleNotifications],
  );

  const panelTitle = scopePanelTitle(scope);
  const emptyMessage = scopeEmptyMessage(scope);
  const footerLink = scopeFooterLink(scope);
  const isScoped = scope.category !== 'all';

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const handleClickNotification = async (n: UserNotification) => {
    if (!n.read) await markRead(n._id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="notification-bell-wrap" ref={panelRef}>
      <button
        type="button"
        className="notification-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${panelTitle}${visibleUnreadCount > 0 ? `, ${visibleUnreadCount} unread` : ''}`}
        title={panelTitle}
      >
        <Bell size={20} />
        {visibleUnreadCount > 0 && (
          <span className="notification-bell-badge">
            {visibleUnreadCount > 99 ? '99+' : visibleUnreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-panel">
          <div className="notification-panel-header">
            <div>
              <strong>{panelTitle}</strong>
              {isScoped && (
                <div className="notification-scope-hint">Filtered for this section</div>
              )}
            </div>
            {visibleUnreadCount > 0 && (
              <button
                type="button"
                className="notification-mark-all"
                onClick={() => void markAllRead(scope)}
              >
                <CheckCheck size={14} />
                Mark all read
              </button>
            )}
          </div>

          <div className="notification-panel-list">
            {loading && visibleNotifications.length === 0 ? (
              <p className="notification-empty">Loading…</p>
            ) : visibleNotifications.length === 0 ? (
              <p className="notification-empty">{emptyMessage}</p>
            ) : (
              visibleNotifications.map((n) => {
                const source = resolveSource(n);
                return (
                  <button
                    key={n._id}
                    type="button"
                    className={`notification-item ${n.read ? 'read' : 'unread'}`}
                    onClick={() => void handleClickNotification(n)}
                  >
                    <span className={`notification-item-icon type-${n.type} source-${source}`}>
                      {source === 'amazon' ? <ShoppingBag size={16} /> : <NotificationIcon type={n.type} />}
                    </span>
                    <span className="notification-item-body">
                      <span className="notification-item-title">
                        {n.title}
                        <span className={`notification-source-badge source-${source}`}>
                          {source === 'amazon' ? 'Amazon' : 'Aurora'}
                        </span>
                      </span>
                      <span className="notification-item-message">{n.message}</span>
                      <span className="notification-item-time">{formatTime(n.createdAt)}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="notification-panel-footer">
            <Link to={footerLink.to} onClick={() => setOpen(false)}>
              {footerLink.label}
            </Link>
            {!isScoped && (
              <Link to="/integration" onClick={() => setOpen(false)}>
                Integration
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
