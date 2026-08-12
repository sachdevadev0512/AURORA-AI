import { useEffect, useState, useCallback } from 'react';
import useOrderSocket, { OrderUpdate } from '../hooks/useOrderSocket';
import notificationAPI from '../api/notificationAPI';

/**
 * Example component showing how to use live order syncing
 * 
 * Features:
 * - Real-time order updates via Socket.IO
 * - Subscribe/unsubscribe from Amazon notifications
 * - Manual sync fallback
 * - Connection status indicator
 */
export const LiveOrderSync = ({ userId, onOrdersUpdate }: { userId: string; onOrdersUpdate?: (orders: any[]) => void }) => {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastOrderUpdate, setLastOrderUpdate] = useState<OrderUpdate | null>(null);
  const [syncedOrders, setSyncedOrders] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Real-time socket connection
  const { connected, lastUpdate } = useOrderSocket({
    userId,
    onOrderUpdate: (data) => {
      if (data.event !== 'ORDER_CHANGE' && data.event !== 'ORDER_SYNCED') return;
      if (!data.order) return;

      setLastOrderUpdate(data);

      // Update synced orders list
      setSyncedOrders((prev) => {
        const exists = prev.some((o) => o._id === data.order._id);
        if (exists) {
          return prev.map((o) => (o._id === data.order._id ? data.order : o));
        }
        return [data.order, ...prev];
      });

      // Notify parent component
      onOrdersUpdate?.([data.order, ...syncedOrders]);

      // Show notification to user
      showNotification(`Order ${data.order.amazonOrderId} - ${data.status || data.event}`);
    },
  });

  // Check subscription status on mount
  useEffect(() => {
    checkSubscriptionStatus();
  }, []);

  const checkSubscriptionStatus = async () => {
    try {
      const response = await notificationAPI.getStatus();
      setIsSubscribed(response.subscribed);
    } catch (err) {
      console.error('Error checking subscription status:', err);
    }
  };

  // Subscribe to notifications
  const handleSubscribe = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await notificationAPI.subscribe();
      setIsSubscribed(true);
      showNotification('✓ Subscribed to live order updates');
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to subscribe';
      setError(message);
      showNotification(`✗ ${message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Unsubscribe from notifications
  const handleUnsubscribe = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      await notificationAPI.unsubscribe();
      setIsSubscribed(false);
      showNotification('Unsubscribed from live updates');
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to unsubscribe';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Manual sync
  const handleManualSync = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await notificationAPI.syncOrders();
      setSyncedOrders(response.orders || []);
      onOrdersUpdate?.(response.orders || []);
      showNotification(`✓ Synced ${response.ordersSync} orders`);
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to sync orders';
      setError(message);
      showNotification(`✗ ${message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [onOrdersUpdate]);

  return (
    <div className="live-order-sync">
      {/* Connection Status */}
      <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
        <span className="status-indicator" />
        {connected ? 'Live' : 'Offline'}
      </div>

      {/* Subscription Controls */}
      <div className="subscription-controls">
        {!isSubscribed ? (
          <button
            onClick={handleSubscribe}
            disabled={isLoading}
            className="btn btn-primary"
          >
            {isLoading ? 'Subscribing...' : 'Enable Live Sync'}
          </button>
        ) : (
          <button
            onClick={handleUnsubscribe}
            disabled={isLoading}
            className="btn btn-secondary"
          >
            {isLoading ? 'Unsubscribing...' : 'Disable Live Sync'}
          </button>
        )}

        <button
          onClick={handleManualSync}
          disabled={isLoading}
          className="btn btn-outline"
        >
          {isLoading ? 'Syncing...' : 'Manual Sync'}
        </button>
      </div>

      {/* Status Display */}
      <div className="status-display">
        <p>Status: <strong>{isSubscribed ? '🟢 Active' : '🔴 Inactive'}</strong></p>
        {lastOrderUpdate?.order && (
          <p>
            Last Update: <strong>{lastOrderUpdate.order.amazonOrderId}</strong> ({lastOrderUpdate.status || lastOrderUpdate.event})
          </p>
        )}
        {syncedOrders.length > 0 && (
          <p>Recently Synced: <strong>{syncedOrders.length}</strong> orders</p>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      {/* Recently Synced Orders */}
      {syncedOrders.length > 0 && (
        <div className="synced-orders">
          <h3>Live Synced Orders</h3>
          <ul>
            {syncedOrders.slice(0, 5).map((order) => (
              <li key={order._id}>
                <span className="order-id">{order.amazonOrderId}</span>
                <span className="order-status">{order.orderStatus}</span>
                <span className="order-total">${order.orderTotal.amount}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <style>{`
        .live-order-sync {
          padding: 1rem;
          background: #f5f5f5;
          border-radius: 8px;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 1rem;
          padding: 0.5rem;
          background: white;
          border-radius: 4px;
          font-weight: 600;
        }

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }

        .connection-status.connected .status-indicator {
          background: #4caf50;
        }

        .connection-status.disconnected .status-indicator {
          background: #f44336;
          animation: none;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .subscription-controls {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1rem;
        }

        .btn {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.3s;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-primary {
          background: #2196f3;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #1976d2;
        }

        .btn-secondary {
          background: #ff9800;
          color: white;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #f57c00;
        }

        .btn-outline {
          background: white;
          border: 2px solid #2196f3;
          color: #2196f3;
        }

        .btn-outline:hover:not(:disabled) {
          background: #e3f2fd;
        }

        .status-display {
          padding: 1rem;
          background: white;
          border-radius: 4px;
          margin-bottom: 1rem;
        }

        .status-display p {
          margin: 0.5rem 0;
        }

        .error-message {
          padding: 1rem;
          background: #ffebee;
          border-left: 4px solid #f44336;
          color: #c62828;
          margin-bottom: 1rem;
          border-radius: 4px;
        }

        .synced-orders {
          background: white;
          border-radius: 4px;
          overflow: hidden;
        }

        .synced-orders h3 {
          margin: 0;
          padding: 1rem;
          background: #f5f5f5;
          border-bottom: 1px solid #e0e0e0;
        }

        .synced-orders ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .synced-orders li {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          border-bottom: 1px solid #f0f0f0;
        }

        .synced-orders li:last-child {
          border-bottom: none;
        }

        .order-id {
          font-weight: 600;
          color: #2196f3;
        }

        .order-status {
          background: #e3f2fd;
          color: #1976d2;
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          font-size: 0.875rem;
        }

        .order-total {
          font-weight: 600;
          color: #4caf50;
        }
      `}</style>
    </div>
  );
};

// Helper function to show notifications
function showNotification(_message: string, _type: 'success' | 'error' = 'success') {
  // Hook up toast UI when needed
}

export default LiveOrderSync;
