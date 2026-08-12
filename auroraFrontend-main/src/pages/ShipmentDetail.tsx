import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, RefreshCw, Truck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getShipment, refreshShipmentTracking } from '../api';
import { Shipment } from '../types';
import useShipmentSocket, { ShipmentTrackingUpdate } from '../hooks/useShipmentSocket';

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    // Seller Central uses the seller's local timezone for Created / Last Updated.
    return new Date(value).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function formatDeliveryWindow(start?: string | null, end?: string | null) {
  const fmtDay = (value: string) => {
    try {
      return new Date(value).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return null;
    }
  };
  const startLabel = start ? fmtDay(start) : null;
  const endLabel = end ? fmtDay(end) : null;
  if (startLabel && endLabel) {
    return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
  }
  return startLabel || endLabel || '—';
}

function displayShipmentName(shipment: Shipment) {
  const name = String(shipment.shipmentName || '').trim();
  const ref = String(shipment.referenceId || '').trim();
  if (!name) return null;
  if (ref && name === ref) return null;
  if (/^[A-Z0-9]{6,14}$/i.test(name) && !/^FBA/i.test(name)) return null;
  return name;
}

function isClosedShipment(shipment: Shipment) {
  return String(shipment.status || '').toUpperCase() === 'CLOSED';
}

function DetailRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={`detail-row${highlight ? ' detail-row-discrepancy' : ''}`}>
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

export default function ShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');

  const loadShipment = useCallback(async () => {
    if (!token || !id) return;
    try {
      setLoading(true);
      const response = await getShipment(token, id);
      setShipment(response.data);
      setMessage('');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => {
    void loadShipment();
  }, [loadShipment]);

  const handleTrackingUpdate = useCallback(
    (update: ShipmentTrackingUpdate) => {
      if (!id || update.shipmentDbId !== id) return;
      setShipment((prev) =>
        prev
          ? {
              ...prev,
              status: update.status,
              displayStatus: update.displayStatus,
              trackingId: update.trackingId ?? prev.trackingId,
              carrierName: update.carrierName ?? prev.carrierName,
              estimatedDeliveryDate:
                update.estimatedDeliveryDate ?? prev.estimatedDeliveryDate,
              trackingPackages: update.trackingPackages ?? prev.trackingPackages,
              statusTimeline: update.statusTimeline ?? prev.statusTimeline,
            }
          : prev,
      );
      if (update.changeType === 'status_change') {
        setMessage(`Live update: status is now ${update.displayStatus}`);
      }
    },
    [id],
  );

  useShipmentSocket({
    userId: user?._id,
    enabled: Boolean(token && user?._id),
    onTrackingUpdate: handleTrackingUpdate,
  });

  const handleRefreshTracking = async () => {
    if (!token || !id) return;
    try {
      setRefreshing(true);
      const response = await refreshShipmentTracking(token, id);
      setShipment(response.data);
      setMessage('Tracking data refreshed from Amazon.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const isFba = shipment?.shipmentType === 'fba_fc';
  const packages = shipment?.trackingPackages || [];
  const timeline = shipment?.statusTimeline || [];
  const lineItems = shipment?.lineItems || [];
  const isClosed = shipment ? isClosedShipment(shipment) : false;
  const discrepancies = isClosed ? shipment?.discrepancies || [] : [];

  const unitsMismatch =
    isClosed &&
    isFba &&
    (shipment?.unitsExpected ?? 0) > 0 &&
    (shipment?.unitsLocated ?? 0) !== (shipment?.unitsExpected ?? 0);
  const boxesMismatch =
    isClosed &&
    !isFba &&
    (shipment?.boxesExpected ?? 0) > 0 &&
    (shipment?.boxesReceived ?? 0) !== (shipment?.boxesExpected ?? 0);

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <Link to="/shipments" className="back-link">
            <ArrowLeft size={16} />
            Back to Shipments
          </Link>
          <h1>
            <Truck size={24} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Shipment Tracking
          </h1>
          {shipment?.isLiveTracking && (
            <p className="page-subtitle">Live tracking active — updates every few minutes</p>
          )}
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={() => void handleRefreshTracking()}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh Tracking'}
          </button>
        </div>
      </div>

      {message && <p className="status-message">{message}</p>}

      {loading && !shipment ? (
        <p>Loading shipment…</p>
      ) : !shipment ? (
        <p>Shipment not found.</p>
      ) : (
        <>
          {discrepancies.length > 0 && (
            <div className="discrepancy-banner" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>Quantity discrepancies detected</strong>
                <ul>
                  {discrepancies.map((issue) => (
                    <li key={`${issue.type}-${issue.sku || issue.label}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="detail-card">
            <div className="detail-card-header">
              <div>
                <h2>{shipment.shipmentId}</h2>
                <p className="cell-muted">
                  {isFba ? 'Fulfilment Center Shipment' : 'Amazon Distribution Center Shipment'}
                  {shipment.carrierName ? ` · ${shipment.carrierName}` : ''}
                </p>
              </div>
              <span className={`status-badge shipment-status-${shipment.status.toLowerCase()}`}>
                {shipment.displayStatus || shipment.status}
              </span>
            </div>

            <div className="detail-grid">
              <DetailRow
                label="Shipment Name"
                value={displayShipmentName(shipment) || '—'}
              />
              <DetailRow label="Amazon Reference ID" value={shipment.referenceId || '—'} />
              <DetailRow label="Created Date" value={formatDate(shipment.createdDate)} />
              <DetailRow label="Last Updated Date" value={formatDate(shipment.lastUpdatedDate)} />
              <DetailRow
                label="Delivery Window"
                value={formatDeliveryWindow(shipment.shipDate, shipment.estimatedDeliveryDate)}
              />
              <DetailRow label="Number of SKUs" value={shipment.skuCount ?? 0} />
              {isFba ? (
                <>
                  <DetailRow
                    label="Units Expected"
                    value={shipment.unitsExpected ?? '—'}
                    highlight={unitsMismatch}
                  />
                  <DetailRow
                    label="Units Located"
                    value={shipment.unitsLocated ?? '—'}
                    highlight={unitsMismatch}
                  />
                </>
              ) : (
                <>
                  <DetailRow
                    label="Boxes Expected"
                    value={shipment.boxesExpected ?? '—'}
                    highlight={boxesMismatch}
                  />
                  <DetailRow
                    label="Boxes Received"
                    value={shipment.boxesReceived ?? '—'}
                    highlight={boxesMismatch}
                  />
                </>
              )}
              <DetailRow label="Tracking ID" value={shipment.trackingId || '—'} />
              {shipment.destinationCenterId && (
                <DetailRow label="Destination Center" value={shipment.destinationCenterId} />
              )}
              <DetailRow label="Last Tracked" value={formatDate(shipment.lastTrackedAt)} />
            </div>
          </div>

          <div className="detail-card" style={{ marginTop: '1rem' }}>
            <h3>Status Timeline</h3>
            {timeline.length === 0 ? (
              <p className="cell-muted">No status history yet. Tracking updates will appear here.</p>
            ) : (
              <ol className="shipment-timeline">
                {[...timeline].reverse().map((entry, index) => (
                  <li key={`${entry.status}-${entry.at}-${index}`}>
                    <span className={`status-badge shipment-status-${entry.status.toLowerCase()}`}>
                      {entry.displayStatus}
                    </span>
                    <span className="cell-muted">{formatDate(entry.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="detail-card" style={{ marginTop: '1rem' }}>
            <h3>Package Tracking</h3>
            {packages.length === 0 ? (
              <p className="cell-muted">
                No carrier tracking numbers from Amazon yet. Refresh tracking to check again.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Box</th>
                      <th>Carrier</th>
                      <th>Tracking ID</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.map((pkg, index) => (
                      <tr key={`${pkg.trackingId || pkg.boxId || index}`}>
                        <td>{pkg.boxId || `Package ${index + 1}`}</td>
                        <td>{pkg.carrierName || '—'}</td>
                        <td>{pkg.trackingId || '—'}</td>
                        <td>{pkg.packageStatus || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="detail-card" style={{ marginTop: '1rem' }}>
            <h3>Product Line Items</h3>
            {lineItems.length === 0 ? (
              <p className="cell-muted">
                SKU-level data is loaded when you open this page. If counts are still empty, run a
                sync and refresh tracking.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      {isFba && <th>FNSKU</th>}
                      <th>Expected</th>
                      <th>Received</th>
                      <th>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((line) => (
                      <tr
                        key={line.sku}
                        className={isClosed && line.variance !== 0 ? 'row-discrepancy' : undefined}
                      >
                        <td>{line.sku}</td>
                        {isFba && <td>{line.fnsku || '—'}</td>}
                        <td>{line.unitsExpected}</td>
                        <td>{line.unitsReceived}</td>
                        <td className={isClosed && line.variance !== 0 ? 'cell-discrepancy' : undefined}>
                          {line.variance > 0 ? `+${line.variance}` : line.variance}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
