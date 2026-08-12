import { useEffect, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import { getSocketClientOptions } from '../utils/socketAuth';

export interface OrderUpdate {
  event: 'ORDER_CHANGE' | 'ORDER_SYNCED' | 'ORDER_SYNC_STARTED' | 'ORDER_SYNC_PROGRESS' | 'ORDER_SYNC_COMPLETE' | 'ORDER_SYNC_STOPPED' | 'ORDER_SYNC_STOPPING' | 'ORDER_SYNC_ERROR';
  order?: any;
  status?: string;
  message?: string;
  processed?: number;
  syncing?: boolean;
  stopping?: boolean;
  timestamp: string;
}

interface UseOrderSocketOptions {
  userId?: string;
  onOrderUpdate?: (data: OrderUpdate) => void;
  onSyncStatus?: (data: OrderUpdate) => void;
  onSyncComplete?: (data: OrderUpdate) => void;
  enabled?: boolean;
}

/**
 * Custom hook for real-time order updates via Socket.IO
 * 
 * Usage:
 * ```tsx
 * const { connected, lastUpdate } = useOrderSocket({
 *   userId: user._id,
 *   onOrderUpdate: (data) => {
 *     console.log('New order:', data.order);
 *     // Refresh orders list, show notification, etc.
 *   }
 * });
 * ```
 */
export const useOrderSocket = ({
  userId,
  onOrderUpdate,
  onSyncStatus,
  onSyncComplete,
  enabled = true,
}: UseOrderSocketOptions) => {
  const socketRef = useRef<Socket | null>(null);
  const lastUpdateRef = useRef<OrderUpdate | null>(null);

  // Initialize Socket.IO connection
  useEffect(() => {
    if (!enabled || !userId) return;

    const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

    socketRef.current = io(socketUrl, getSocketClientOptions());

    // Connection established
    socketRef.current.on('connect', () => {
      socketRef.current?.emit('joinUser', userId);
    });

    socketRef.current.on('orderUpdate', (data: OrderUpdate) => {
      lastUpdateRef.current = data;
      if (onOrderUpdate) onOrderUpdate(data);
    });

    socketRef.current.on('orderSyncStatus', (data: OrderUpdate) => {
      lastUpdateRef.current = data;
      if (onSyncStatus) onSyncStatus(data);
    });

    socketRef.current.on('orderSyncComplete', (data: OrderUpdate) => {
      lastUpdateRef.current = data;
      if (onSyncComplete) onSyncComplete(data);
    });

    socketRef.current.on('orderSyncError', (data: OrderUpdate) => {
      lastUpdateRef.current = data;
      if (onSyncComplete) onSyncComplete(data);
    });

    // Error handling
    socketRef.current.on('error', (error) => {
      console.error('Socket error:', error);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.emit('leaveUser', userId);
        socketRef.current.disconnect();
      }
    };
  }, [userId, enabled, onOrderUpdate, onSyncStatus, onSyncComplete]);

  // Get current connection state
  const connected = socketRef.current?.connected ?? false;
  
  // Get last update
  const lastUpdate = lastUpdateRef.current;

  // Manual reconnect function
  const reconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.connect();
    }
  }, []);

  return {
    socket: socketRef.current,
    connected,
    lastUpdate,
    reconnect,
  };
};

export default useOrderSocket;
