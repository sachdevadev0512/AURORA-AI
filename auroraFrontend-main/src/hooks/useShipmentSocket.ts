import { useEffect, useRef } from 'react';
import { auroraSocket } from '../lib/auroraSocket';
import type { Shipment } from '../types';

export interface ShipmentSyncUpdate {
  event:
    | 'SHIPMENT_SYNC_STARTED'
    | 'SHIPMENT_SYNC_PROGRESS'
    | 'SHIPMENT_SYNC_COMPLETE'
    | 'SHIPMENT_SYNC_STOPPED'
    | 'SHIPMENT_SYNC_STOPPING'
    | 'SHIPMENT_SYNC_ERROR';
  message?: string;
  processed?: number;
  saved?: number;
  failed?: number;
  phase?: string;
  timestamp: string;
}

export interface ShipmentTrackingUpdate {
  changeType?: 'status_change' | 'tracking_update' | 'updated';
  shipmentId: string;
  shipmentDbId: string;
  shipmentType: Shipment['shipmentType'];
  status: string;
  displayStatus: string;
  trackingId?: string | null;
  trackingUrl?: string | null;
  carrierName?: string | null;
  estimatedDeliveryDate?: string | null;
  trackingPackages?: Shipment['trackingPackages'];
  statusTimeline?: Shipment['statusTimeline'];
  timestamp: string;
}

export interface ShipmentDelayedUpdate {
  count: number;
  shipment?: {
    _id: string;
    shipmentId: string;
    displayStatus: string;
    estimatedDeliveryDate?: string | null;
    daysLate: number;
  };
  shipments?: Array<{
    _id: string;
    shipmentId: string;
    displayStatus: string;
    estimatedDeliveryDate?: string | null;
    daysLate: number;
  }>;
  timestamp: string;
}

interface UseShipmentSocketOptions {
  userId?: string;
  onSyncStatus?: (data: ShipmentSyncUpdate) => void;
  onSyncComplete?: (data: ShipmentSyncUpdate) => void;
  onTrackingUpdate?: (data: ShipmentTrackingUpdate) => void;
  onDelayed?: (data: ShipmentDelayedUpdate) => void;
  enabled?: boolean;
}

export const useShipmentSocket = ({
  userId,
  onSyncStatus,
  onSyncComplete,
  onTrackingUpdate,
  onDelayed,
  enabled = true,
}: UseShipmentSocketOptions) => {
  const onSyncStatusRef = useRef(onSyncStatus);
  const onSyncCompleteRef = useRef(onSyncComplete);
  const onTrackingUpdateRef = useRef(onTrackingUpdate);
  const onDelayedRef = useRef(onDelayed);

  useEffect(() => {
    onSyncStatusRef.current = onSyncStatus;
    onSyncCompleteRef.current = onSyncComplete;
    onTrackingUpdateRef.current = onTrackingUpdate;
    onDelayedRef.current = onDelayed;
  }, [onSyncStatus, onSyncComplete, onTrackingUpdate, onDelayed]);

  useEffect(() => {
    if (!enabled || !userId) return;

    auroraSocket.connect(userId);

    const unsubs = [
      auroraSocket.on('shipmentSyncStatus', (data) => {
        onSyncStatusRef.current?.(data as ShipmentSyncUpdate);
      }),
      auroraSocket.on('shipmentSyncComplete', (data) => {
        onSyncCompleteRef.current?.(data as ShipmentSyncUpdate);
      }),
      auroraSocket.on('shipmentSyncStopped', (data) => {
        onSyncCompleteRef.current?.(data as ShipmentSyncUpdate);
      }),
      auroraSocket.on('shipmentSyncError', (data) => {
        onSyncCompleteRef.current?.(data as ShipmentSyncUpdate);
      }),
      auroraSocket.on('shipmentTrackingUpdate', (data) => {
        onTrackingUpdateRef.current?.(data as ShipmentTrackingUpdate);
      }),
      auroraSocket.on('shipmentDelayed', (data) => {
        onDelayedRef.current?.(data as ShipmentDelayedUpdate);
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [userId, enabled]);

  return { connected: auroraSocket.connected };
};

export default useShipmentSocket;
