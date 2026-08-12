import { useEffect, useRef, useCallback } from 'react';
import { auroraSocket } from '../lib/auroraSocket';

export interface InventoryUpdate {
  event:
    | 'INVENTORY_SYNC_STARTED'
    | 'INVENTORY_SYNC_PROGRESS'
    | 'INVENTORY_SYNC_COMPLETE'
    | 'INVENTORY_SYNC_STOPPED'
    | 'INVENTORY_SYNC_STOPPING'
    | 'INVENTORY_SYNC_ERROR';
  message?: string;
  processed?: number;
  saved?: number;
  skipped?: number;
  failed?: number;
  syncing?: boolean;
  timestamp: string;
}

interface UseInventorySocketOptions {
  userId?: string;
  onSyncStatus?: (data: InventoryUpdate) => void;
  onSyncComplete?: (data: InventoryUpdate) => void;
  onProductFeeChange?: () => void;
  enabled?: boolean;
}

export const useInventorySocket = ({
  userId,
  onSyncStatus,
  onSyncComplete,
  onProductFeeChange,
  enabled = true,
}: UseInventorySocketOptions) => {
  const onSyncStatusRef = useRef(onSyncStatus);
  const onSyncCompleteRef = useRef(onSyncComplete);
  const onProductFeeChangeRef = useRef(onProductFeeChange);

  useEffect(() => {
    onSyncStatusRef.current = onSyncStatus;
    onSyncCompleteRef.current = onSyncComplete;
    onProductFeeChangeRef.current = onProductFeeChange;
  }, [onSyncStatus, onSyncComplete, onProductFeeChange]);

  useEffect(() => {
    if (!enabled || !userId) return;

    auroraSocket.connect(userId);

    const unsubs = [
      auroraSocket.on('inventorySyncStatus', (data) => {
        onSyncStatusRef.current?.(data as InventoryUpdate);
      }),
      auroraSocket.on('inventorySyncComplete', (data) => {
        onSyncCompleteRef.current?.(data as InventoryUpdate);
      }),
      auroraSocket.on('inventorySyncError', (data) => {
        onSyncCompleteRef.current?.(data as InventoryUpdate);
      }),
      auroraSocket.on('productFeeChange', () => {
        onProductFeeChangeRef.current?.();
      }),
      auroraSocket.on('productFeesUpdated', () => {
        onProductFeeChangeRef.current?.();
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [userId, enabled]);

  const reconnect = useCallback(() => {
    if (userId) auroraSocket.connect(userId);
  }, [userId]);

  return {
    connected: auroraSocket.connected,
    reconnect,
  };
};

export default useInventorySocket;
