import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  exportShipmentsCsv,
  getShipments,
  syncShipments,
} from '../api';
import { Shipment, ShipmentType } from '../types';
import useShipmentSocket from '../hooks/useShipmentSocket';
import '../styles/shipments.css';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export default function Shipments() {
  const { token, user } = useAuth();
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [shipmentType, setShipmentType] = useState<ShipmentType>('fba_fc');
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, pages: 0 });

  const loadShipments = useCallback(
    async (page = 1, limit = 25) => {
      if (!token) return;
      try {
        setLoading(true);
        const response = await getShipments(
          token,
          page,
          limit,
          shipmentType,
          searchTerm,
          undefined,
          undefined,
          'lastUpdatedDate',
          'desc',
        );
        setShipments(response.data || []);
        if (response.pagination) {
          setPagination(response.pagination);
        }
      } catch (err) {
        setMessage((err as Error).message);
        setShipments([]);
      } finally {
        setLoading(false);
      }
    },
    [token, shipmentType, searchTerm],
  );

  useShipmentSocket({
    userId: user?._id,
    enabled: Boolean(token && user?._id),
    onSyncStatus: (data) => {
      setIsBackgroundSyncing(true);
      if (data.message) setMessage(data.message);
    },
    onSyncComplete: (data) => {
      setIsBackgroundSyncing(false);
      setSyncLoading(false);
      setMessage(data.message || 'Shipment sync finished.');
      void loadShipments(1, pagination.limit);
    },
  });

  useEffect(() => {
    const timeout = setTimeout(() => setSearchTerm(searchInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (token) {
      void loadShipments(1, pagination.limit);
    }
  }, [token, searchTerm, shipmentType, loadShipments]);

  const handleSync = async () => {
    if (!token) return;
    try {
      setSyncLoading(true);
      const response = await syncShipments(token);
      setIsBackgroundSyncing(true);
      setMessage(response.message || 'Shipment sync started on the server.');
    } catch (err) {
      setMessage((err as Error).message);
      setSyncLoading(false);
      setIsBackgroundSyncing(false);
    }
  };

  const downloadCsv = async () => {
    if (!token) return;
    try {
      setCsvLoading(true);
      const blob = await exportShipmentsCsv(token, shipmentType, searchTerm);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fba-shipments-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      setMessage('Shipments CSV downloaded successfully.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setCsvLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const s = (status || '').toLowerCase();
    const badgeClass =
      s.includes('receiv') || s.includes('closed') || s.includes('deliver')
        ? 'active'
        : s.includes('work') || s.includes('transit')
          ? 'pending'
          : 'inactive';
    return <span className={`apple-badge ${badgeClass}`}>{status || 'Working'}</span>;
  };

  return (
    <div className="apple-shipments-page">
      <div className="apple-shipments-container">
        {/* Header Section */}
        <header className="apple-shipments-header">
          <div>
            <h1 className="apple-shipments-title">FBA Shipments</h1>
            <p className="apple-shipments-desc">
              Track inbound Amazon FBA inventory shipments, fulfillment center destinations, and receiving progress.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={downloadCsv}
              disabled={csvLoading || loading}
            >
              <span className="material-symbols-outlined">download</span>
              {csvLoading ? 'Downloading…' : 'Download CSV'}
            </button>
            <button
              type="button"
              className="apple-btn-primary"
              onClick={handleSync}
              disabled={syncLoading || loading}
            >
              <span
                className="material-symbols-outlined"
                style={{ animation: syncLoading ? 'spin 1s linear infinite' : 'none' }}
              >
                sync
              </span>
              {syncLoading ? 'Syncing…' : 'Sync Shipments'}
            </button>
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* Filter Bar */}
        <section className="apple-filter-card">
          <div className="apple-search-row">
            <div className="apple-search-wrap">
              <span className="material-symbols-outlined apple-search-icon">search</span>
              <input
                type="text"
                className="apple-search-input"
                placeholder="Search by Shipment ID, Name, or FC Center..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <select
              className="apple-select"
              value={shipmentType}
              onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
            >
              <option value="fba_fc">FBA Inbound Shipments</option>
              <option value="awd_dc">AWD DC Shipments</option>
            </select>
          </div>
        </section>

        {/* Table Section */}
        <section className="apple-table-card">
          <div className="apple-table-scroll">
            <table className="apple-table">
              <thead>
                <tr>
                  <th>Shipment ID</th>
                  <th>Name</th>
                  <th>Destination FC</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>SKUs</th>
                  <th style={{ textAlign: 'right' }}>Expected</th>
                  <th style={{ textAlign: 'right' }}>Located</th>
                  <th>Created Date</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && shipments.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '3rem 1rem', color: '#86868B' }}>
                      Loading shipments…
                    </td>
                  </tr>
                ) : shipments.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '3.5rem 1rem', color: '#86868B' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                        local_shipping
                      </span>
                      <p style={{ margin: '0.5rem 0 0' }}>No FBA shipments found.</p>
                    </td>
                  </tr>
                ) : (
                  shipments.map((shipment) => (
                    <tr key={shipment._id}>
                      <td style={{ fontWeight: 600 }}>{shipment.shipmentId}</td>
                      <td>{shipment.shipmentName || 'FBA Inbound Shipment'}</td>
                      <td style={{ fontWeight: 500 }}>{shipment.destinationCenterId || '—'}</td>
                      <td>{getStatusBadge(shipment.displayStatus || shipment.status)}</td>
                      <td style={{ textAlign: 'right' }}>{shipment.skuCount || shipment.lineItems?.length || 0}</td>
                      <td style={{ textAlign: 'right' }}>{shipment.unitsExpected ?? 0}</td>
                      <td style={{ textAlign: 'right' }}>{shipment.unitsLocated ?? 0}</td>
                      <td style={{ color: '#86868B' }}>
                        {shipment.createdDate ? new Date(shipment.createdDate).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Link to={`/shipments/${shipment._id}`} className="apple-btn-secondary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }}>
                          View
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <footer className="apple-pagination-footer">
            <span>
              Showing {pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1} to{' '}
              {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} shipments
            </span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={() => loadShipments(pagination.page - 1, pagination.limit)}
                disabled={pagination.page <= 1 || loading}
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={() => loadShipments(pagination.page + 1, pagination.limit)}
                disabled={pagination.page >= pagination.pages || loading}
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
