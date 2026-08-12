import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { auroraSocket } from '../lib/auroraSocket';
import { useAuth } from './AuthContext';
import {
  getUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  UserNotification,
} from '../api/userNotificationsAPI';
import {
  NotificationScope,
  isSuppressedInboxNotification,
  notificationMatchesScope,
  scopeQueryParams,
} from '../utils/notificationScope';

interface NotificationContextValue {
  notifications: UserNotification[];
  unreadCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: (scope?: NotificationScope) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

function normalizeNotification(payload: Partial<UserNotification>): UserNotification | null {
  if (!payload?._id || !payload.title) return null;

  const source =
    payload.source === 'amazon' || payload.source === 'aurora'
      ? payload.source
      : payload.metadata?.source === 'amazon'
        ? 'amazon'
        : 'aurora';

  return {
    _id: String(payload._id),
    source,
    type: (payload.type as UserNotification['type']) || 'info',
    title: payload.title,
    message: payload.message || '',
    link: payload.link ?? null,
    read: payload.read ?? false,
    metadata: payload.metadata,
    createdAt: payload.createdAt || new Date().toISOString(),
  };
}

function filterVisibleNotifications(items: UserNotification[]): UserNotification[] {
  return items.filter((item) => !isSuppressedInboxNotification(item));
}

function prependUnique(
  prev: UserNotification[],
  incoming: UserNotification
): UserNotification[] {
  const exists = prev.some((n) => n._id === incoming._id);
  if (exists) return prev;
  return [incoming, ...prev].slice(0, 50);
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef(token);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const activeToken = tokenRef.current;
    if (!activeToken) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    try {
      if (!options?.silent) setLoading(true);
      const data = await getUserNotifications(activeToken, { limit: 50 });
      setNotifications((prev) => {
        const apiIds = new Set(data.notifications.map((n) => n._id));
        const optimistic = prev.filter((n) => !apiIds.has(n._id));
        return filterVisibleNotifications([...optimistic, ...data.notifications]).slice(0, 50);
      });
      setUnreadCount(data.unreadCount);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  const scheduleSilentRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      void refresh({ silent: true });
    }, 400);
  }, [refresh]);

  const prependNotification = useCallback((payload: Partial<UserNotification>) => {
    const normalized = normalizeNotification(payload);
    if (!normalized || isSuppressedInboxNotification(normalized)) return;

    setNotifications((prev) => prependUnique(prev, normalized));
    if (!normalized.read) {
      setUnreadCount((c) => c + 1);
    }
  }, []);

  const markRead = useCallback(async (id: string) => {
    const activeToken = tokenRef.current;
    if (!activeToken) return;

    await markNotificationRead(activeToken, id);
    setNotifications((prev) => prev.map((n) => (n._id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
  }, []);

  const markAllRead = useCallback(async (scope?: NotificationScope) => {
    const activeToken = tokenRef.current;
    if (!activeToken) return;

    const scopeParams = scope ? scopeQueryParams(scope) : {};
    await markAllNotificationsRead(activeToken, scopeParams);

    if (scope && scope.category !== 'all') {
      setNotifications((prev) =>
        prev.map((n) => (notificationMatchesScope(n, scope) ? { ...n, read: true } : n)),
      );
    } else {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    }

    void refresh({ silent: true });
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, token]);

  useEffect(() => {
    if (!token || !user?._id) {
      auroraSocket.disconnect();
      return;
    }

    auroraSocket.connect(user._id);

    const unsubs = [
      auroraSocket.on('appNotification', (payload) => {
        prependNotification(payload as Partial<UserNotification>);
      }),
      auroraSocket.on('productFeeChange', (payload) => {
        const data = payload as {
          notification?: Partial<UserNotification>;
        };
        if (data?.notification) {
          prependNotification(data.notification);
        } else {
          scheduleSilentRefresh();
        }
      }),
      auroraSocket.on('productFeesUpdated', () => {
        scheduleSilentRefresh();
      }),
      auroraSocket.on('orderUpdate', () => {
        scheduleSilentRefresh();
      }),
      auroraSocket.on('adsSyncComplete', () => {
        scheduleSilentRefresh();
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [token, user?._id, prependNotification, scheduleSilentRefresh]);

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      loading,
      refresh: () => refresh(),
      markRead,
      markAllRead,
    }),
    [notifications, unreadCount, loading, refresh, markRead, markAllRead]
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return ctx;
}
