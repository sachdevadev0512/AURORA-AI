import { useEffect, useState } from 'react';
import useOrderSocket from '../hooks/useOrderSocket';
import notificationAPI from '../api/notificationAPI';

interface DebugLog {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning';
  message: string;
  details?: any;
}

/**
 * Debug Component for Live Order Sync Monitoring
 * 
 * Add this to your dashboard temporarily to see what's happening:
 * 
 * ```tsx
 * import SyncDebugger from './components/SyncDebugger';
 * 
 * <SyncDebugger userId={user._id} />
 * ```
 */
export const SyncDebugger = ({ userId }: { userId: string }) => {
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [stats, setStats] = useState({
    ordersReceived: 0,
    lastOrderTime: null as string | null,
    connectionTime: null as string | null,
  });

  // Add log entry
  const addLog = (level: DebugLog['level'], message: string, details?: any) => {
    const log: DebugLog = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      details,
    };

    setLogs((prev) => [log, ...prev.slice(0, 49)]); // Keep last 50 logs
    console.log(`[${level.toUpperCase()}] ${message}`, details);
  };

  // Socket.IO Hook
  const { connected, lastUpdate } = useOrderSocket({
    userId,
    onOrderUpdate: (data) => {
      addLog('success', `Order Update Received`, {
        event: data.event,
        orderId: data.order.amazonOrderId,
        status: data.status,
      });

      setStats((prev) => ({
        ...prev,
        ordersReceived: prev.ordersReceived + 1,
        lastOrderTime: new Date().toLocaleTimeString(),
      }));
    },
  });

  // Monitor connection status
  useEffect(() => {
    if (connected) {
      addLog('success', 'Socket.IO Connected', { socketId: 'active' });
      setStats((prev) => ({
        ...prev,
        connectionTime: new Date().toLocaleTimeString(),
      }));
    } else {
      addLog('warning', 'Socket.IO Disconnected');
    }
  }, [connected]);

  // Check subscription status on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        addLog('info', 'Checking subscription status...');
        const response = await notificationAPI.getStatus();

        if (response.subscribed) {
          addLog('success', 'Subscribed to notifications', response.subscription);
        } else {
          addLog('warning', 'Not subscribed to notifications');
        }
      } catch (error) {
        addLog('error', 'Failed to check subscription', error);
      }
    };

    checkStatus();
  }, []);

  // Floating Debug Panel Styles
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 9999,
    fontFamily: 'monospace',
    fontSize: '12px',
    width: isOpen ? '500px' : 'auto',
    maxHeight: isOpen ? '600px' : 'auto',
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    borderRadius: '8px',
    border: '2px solid #007acc',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    padding: '12px',
    backgroundColor: '#007acc',
    color: 'white',
    fontWeight: 'bold',
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    userSelect: 'none',
  };

  const contentStyle: React.CSSProperties = {
    overflow: 'auto',
    padding: '12px',
    backgroundColor: '#1e1e1e',
  };

  const logStyle = (level: DebugLog['level']): React.CSSProperties => {
    const colors = {
      info: '#4fc3f7',
      success: '#66bb6a',
      warning: '#ffa726',
      error: '#ef5350',
    };

    return {
      color: colors[level],
      padding: '6px 0',
      borderBottom: '1px solid #333',
      display: 'flex',
      gap: '8px',
    };
  };

  const statsStyle: React.CSSProperties = {
    padding: '12px',
    backgroundColor: '#2d2d2d',
    borderBottom: '1px solid #333',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  };

  const statItemStyle: React.CSSProperties = {
    fontSize: '11px',
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setIsOpen(!isOpen)}>
        <span>
          🔍 Live Sync Monitor
          {connected ? (
            <span style={{ marginLeft: '8px', color: '#66bb6a' }}>● Live</span>
          ) : (
            <span style={{ marginLeft: '8px', color: '#ffa726' }}>● Offline</span>
          )}
        </span>
        <span>{isOpen ? '▼' : '▶'}</span>
      </div>

      {/* Content */}
      {isOpen && (
        <>
          {/* Stats */}
          <div style={statsStyle}>
            <div style={statItemStyle}>
              <strong>Orders Received:</strong>
              <br />
              {stats.ordersReceived}
            </div>
            <div style={statItemStyle}>
              <strong>Last Update:</strong>
              <br />
              {stats.lastOrderTime || 'None'}
            </div>
            <div style={statItemStyle}>
              <strong>Connection:</strong>
              <br />
              {connected ? '🟢 Connected' : '🔴 Disconnected'}
            </div>
            <div style={statItemStyle}>
              <strong>Connected At:</strong>
              <br />
              {stats.connectionTime || 'Not yet'}
            </div>
          </div>

          {/* Action Buttons */}
          <div
            style={{
              padding: '12px',
              display: 'flex',
              gap: '6px',
              borderBottom: '1px solid #333',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={async () => {
                try {
                  addLog('info', 'Subscribing to notifications...');
                  const result = await notificationAPI.subscribe();
                  addLog('success', 'Subscribed successfully', result);
                } catch (error) {
                  addLog('error', 'Subscribe failed', error);
                }
              }}
              style={{
                flex: 1,
                padding: '6px',
                fontSize: '11px',
                backgroundColor: '#2d8659',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Subscribe
            </button>

            <button
              onClick={async () => {
                try {
                  addLog('info', 'Triggering manual sync...');
                  const result = await notificationAPI.syncOrders();
                  addLog('success', `Synced ${result.ordersSync} orders`, result.orders);
                } catch (error) {
                  addLog('error', 'Sync failed', error);
                }
              }}
              style={{
                flex: 1,
                padding: '6px',
                fontSize: '11px',
                backgroundColor: '#286d99',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Sync Orders
            </button>

            <button
              onClick={() => setLogs([])}
              style={{
                flex: 1,
                padding: '6px',
                fontSize: '11px',
                backgroundColor: '#6d2d2d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Clear Logs
            </button>
          </div>

          {/* Logs */}
          <div style={contentStyle}>
            {logs.length === 0 ? (
              <div style={{ color: '#999' }}>No activity yet...</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} style={logStyle(log.level)}>
                  <span style={{ minWidth: '70px', color: '#999' }}>[{log.timestamp}]</span>
                  <span style={{ flex: 1 }}>{log.message}</span>
                  {log.details && (
                    <details
                      style={{
                        cursor: 'pointer',
                        color: '#999',
                      }}
                    >
                      <summary>📄</summary>
                      <pre
                        style={{
                          margin: '6px 0',
                          fontSize: '10px',
                          padding: '6px',
                          backgroundColor: '#0d0d0d',
                          borderRadius: '4px',
                          overflow: 'auto',
                          maxHeight: '200px',
                        }}
                      >
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SyncDebugger;
