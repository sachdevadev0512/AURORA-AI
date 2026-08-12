import { useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import { getSocketClientOptions } from '../utils/socketAuth';

interface AdsSyncCompletePayload {
  event:
    | 'ADS_SYNC_COMPLETE'
    | 'ADS_METRICS_SYNC_COMPLETE'
    | 'ADS_METRICS_SYNC_PARTIAL'
    | 'ADS_METRICS_SYNC_QUEUED';
  source?: string;
  message?: string;
  count?: number;
  campaignsUpdated?: number;
  metricsStartDate?: string;
  metricsEndDate?: string;
  reportErrors?: number;
  reportErrorDetails?: Array<{
    profileId: string;
    campaignType: string;
    startDate?: string;
    endDate?: string;
    error: string;
  }>;
  lastSyncAt?: string;
  timestamp?: string;
}

interface AdsSyncErrorPayload {
  event: 'ADS_SYNC_ERROR' | 'ADS_METRICS_SYNC_ERROR';
  source?: string;
  message?: string;
  code?: string;
  timestamp?: string;
}

interface UseAdsSyncSocketOptions {
  userId?: string;
  enabled?: boolean;
  onSyncComplete?: (payload: AdsSyncCompletePayload) => void;
  onSyncError?: (payload: AdsSyncErrorPayload) => void;
}

export default function useAdsSyncSocket({
  userId,
  enabled = true,
  onSyncComplete,
  onSyncError,
}: UseAdsSyncSocketOptions) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled || !userId) return;

    const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';
    const socket = io(socketUrl, getSocketClientOptions());

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('joinUser', userId);
    });

    socket.on('adsSyncComplete', (payload: AdsSyncCompletePayload) => {
      onSyncComplete?.(payload);
    });

    socket.on('adsSyncError', (payload: AdsSyncErrorPayload) => {
      onSyncError?.(payload);
    });

    socket.on('disconnect', () => {
      // No-op: socket.io reconnect handles retry.
    });

    return () => {
      socket.emit('leaveUser', userId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [enabled, userId, onSyncComplete, onSyncError]);
}
