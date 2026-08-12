import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { downloadOrdersCsvExport, getOrders, syncOrders } from '../api';
import { Order } from '../types';
import useOrderSocket from '../hooks/useOrderSocket';
import '../styles/orders.css';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

const ORDER_STATUS_TABS = [
  { value: '', label: 'All Orders' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Shipped', label: 'Shipped' },
  { value: 'PartiallyShipped', label: 'Partially Shipped' },
  { value: 'Canceled', label: 'Cancelled' },
  { value: 'Unfulfillable', label: 'Unfulfillable' },
] as const;

const DATE_RANGE_PRESETS = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom Range' },
] as const;

type DatePresetValue = (typeof DATE_RANGE_PRESETS)[number]['value'];
const DEFAULT_DATE_PRESET: DatePresetValue = '30';

export default function Orders() {
  const { token, user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncProcessed, setSyncProcessed] = useState(0);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [datePreset, setDatePreset] = useState<DatePresetValue>(DEFAULT_DATE_PRESET);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, pages: 0 });
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  const formatMoney = (amount?: number, currencyCode?: string) => {
    const value = amount ?? 0;
    const currency = currencyCode || 'USD';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatOrderDate = (order: Order) =>
    new Date(order.purchaseDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: order.displayTimeZone || undefined,
    });

  const loadOrders = useCallback(
    async (
      page = 1,
      limit = 25,
      overrides: {
        search?: string;
        status?: string;
        fulfillment?: string;
        preset?: DatePresetValue;
        days?: number;
        start?: string;
        end?: string;
      } = {},
    ) => {
      if (!token) return;
      try {
        setLoading(true);
        const daysToPass =
          (overrides.preset || datePreset) === 'custom'
            ? undefined
            : (overrides.days ?? parseInt(overrides.preset || datePreset, 10));

        const response = await getOrders(
          token,
          page,
          limit,
          overrides.status ?? statusFilter,
          overrides.fulfillment ?? fulfillmentFilter,
          overrides.start ?? (dateRange.start || undefined),
          overrides.end ?? (dateRange.end || undefined),
          overrides.search ?? searchTerm,
          'purchaseDate',
          'desc',
          daysToPass,
        );
        setOrders(response.data || []);
        if (response.pagination) {
          setPagination(response.pagination);
        }
      } catch (err) {
        setMessage((err as Error).message);
        setOrders([]);
      } finally {
        setLoading(false);
      }
    },
    [token, searchTerm, statusFilter, datePreset, fulfillmentFilter, dateRange],
  );

  useOrderSocket({
    userId: user?._id,
    enabled: Boolean(token && user?._id),
    onSyncStatus: (data) => {
      setIsBackgroundSyncing(true);
      if (data.processed != null) setSyncProcessed(data.processed);
      if (data.message) setMessage(data.message);
    },
    onSyncComplete: (data) => {
      setIsBackgroundSyncing(false);
      setSyncLoading(false);
      if (data.processed != null) setSyncProcessed(data.processed);
      setMessage(data.message || 'Order sync finished.');
      void loadOrders(1, pagination.limit);
    },
  });

  useEffect(() => {
    const timeout = setTimeout(() => setSearchTerm(searchInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (token) {
      void loadOrders(1, 25);
    }
  }, [token, searchTerm, statusFilter, datePreset, loadOrders]);

  const handleSync = async () => {
    if (!token) return;
    try {
      setSyncLoading(true);
      const response = await syncOrders(token, dateRange.start || undefined, dateRange.end || undefined);
      setIsBackgroundSyncing(true);
      setMessage(response.message || 'Order sync started on the server.');
      if (response.processed) setSyncProcessed(response.processed);
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
      const daysToPass = datePreset === 'custom' ? undefined : parseInt(datePreset, 10);
      const blob = await downloadOrdersCsvExport(token, {
        search: searchTerm,
        status: statusFilter,
        days: daysToPass,
        fulfillmentChannel: fulfillmentFilter,
        startDate: dateRange.start || undefined,
        endDate: dateRange.end || undefined,
        sortBy: 'purchaseDate',
        sortOrder: 'desc',
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `amazon-orders-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      setMessage(`CSV downloaded for ${pagination.total} order(s).`);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setCsvLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const s = (status || 'Pending').toLowerCase();
    const badgeClass =
      s.includes('shipped')
        ? 'delivered'
        : s.includes('cancel')
          ? 'cancelled'
          : 'pending';
    return <span className={`apple-order-badge ${badgeClass}`}>{status || 'Pending'}</span>;
  };

  return (
    <div className="apple-orders-page">
      <div className="apple-orders-container">
        {/* Header Section */}
        <header className="apple-orders-header">
          <div>
            <h1 className="apple-orders-title">Orders</h1>
            <p className="apple-orders-desc">
              Track and manage your Amazon orders, customer returns, and fulfillment status in real-time.
            </p>
          </div>
          <div className="apple-orders-actions">
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
              {syncLoading ? 'Syncing…' : 'Sync Orders'}
            </button>
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* Status Tabs */}
        <div className="apple-status-tabs">
          {ORDER_STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`apple-status-tab${statusFilter === tab.value ? ' active' : ''}`}
              onClick={() => {
                setStatusFilter(tab.value);
                void loadOrders(1, pagination.limit, { status: tab.value });
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Filter Controls */}
        <section className="apple-filter-card">
          <div className="apple-search-row">
            <div className="apple-search-wrap">
              <span className="material-symbols-outlined apple-search-icon">search</span>
              <input
                type="text"
                className="apple-search-input"
                placeholder="Search by Amazon Order ID, Buyer Name, SKU, or Title..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>

            <select
              className="apple-select"
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value as DatePresetValue)}
            >
              {DATE_RANGE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>

            <select
              className="apple-select"
              value={fulfillmentFilter}
              onChange={(e) => {
                setFulfillmentFilter(e.target.value);
                void loadOrders(1, pagination.limit, { fulfillment: e.target.value });
              }}
            >
              <option value="">All Fulfillment (FBA &amp; FBM)</option>
              <option value="AFN">FBA (Amazon Fulfilled)</option>
              <option value="MFN">FBM (Merchant Fulfilled)</option>
            </select>
          </div>
        </section>

        {/* Table Section */}
        <section className="apple-table-card">
          <div className="apple-table-scroll">
            <table className="apple-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Fulfillment</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '3rem 1rem', color: '#86868B' }}>
                      Loading orders…
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '3.5rem 1rem', color: '#86868B' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                        local_shipping
                      </span>
                      <p style={{ margin: '0.5rem 0 0' }}>No orders found for this view.</p>
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => {
                    const primaryItem = order.orderItems[0];
                    const itemCount = order.orderItems.reduce(
                      (sum, item) => sum + (item.quantityOrdered || 1),
                      0,
                    );

                    return (
                      <tr key={order._id} onClick={() => setSelectedOrder(order)}>
                        <td style={{ fontWeight: 600 }}>{order.amazonOrderId}</td>
                        <td style={{ color: '#86868B' }}>{formatOrderDate(order)}</td>
                        <td>{getStatusBadge(order.orderStatus)}</td>
                        <td>{order.fulfillmentChannel === 'AFN' ? 'FBA' : 'FBM'}</td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontWeight: 500 }}>{primaryItem?.title || 'Amazon Order Item'}</span>
                            <span style={{ fontSize: '0.75rem', color: '#86868B' }}>
                              {itemCount} unit{itemCount === 1 ? '' : 's'} • SKU: {primaryItem?.sellerSku || 'N/A'}
                            </span>
                          </div>
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {formatMoney(order.orderTotal?.amount, order.orderTotal?.currencyCode)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="apple-btn-secondary"
                            style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedOrder(order);
                            }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Side Drawer for Order Details */}
      {selectedOrder && (
        <>
          <div className="apple-drawer-backdrop" onClick={() => setSelectedOrder(null)} />
          <div className="apple-drawer-panel">
            <header className="apple-drawer-header">
              <div>
                <span style={{ fontSize: '0.78rem', color: '#86868B' }}>ORDER DETAILS</span>
                <h2 className="apple-drawer-title">{selectedOrder.amazonOrderId}</h2>
              </div>
              <button
                type="button"
                className="apple-drawer-close"
                onClick={() => setSelectedOrder(null)}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </header>

            <div className="apple-drawer-body">
              {/* Timeline */}
              <div className="apple-timeline">
                <div className="apple-timeline-step">
                  <div className="apple-timeline-dot completed" />
                  <span className="apple-timeline-label completed">Ordered</span>
                </div>
                <div className="apple-timeline-step">
                  <div className="apple-timeline-dot completed" />
                  <span className="apple-timeline-label completed">Confirmed</span>
                </div>
                <div className="apple-timeline-step">
                  <div
                    className={`apple-timeline-dot${
                      ['Shipped', 'PartiallyShipped'].includes(selectedOrder.orderStatus) ? ' completed' : ''
                    }`}
                  />
                  <span
                    className={`apple-timeline-label${
                      ['Shipped', 'PartiallyShipped'].includes(selectedOrder.orderStatus) ? ' completed' : ''
                    }`}
                  >
                    Shipped
                  </span>
                </div>
              </div>

              {/* Order Info */}
              <div className="apple-drawer-section">
                <h3 className="apple-drawer-section-title">Order Information</h3>
                <div className="apple-drawer-grid">
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Status</span>
                    <span className="apple-drawer-field-val">{getStatusBadge(selectedOrder.orderStatus)}</span>
                  </div>
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Purchase Date</span>
                    <span className="apple-drawer-field-val">{formatOrderDate(selectedOrder)}</span>
                  </div>
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Fulfillment Channel</span>
                    <span className="apple-drawer-field-val">
                      {selectedOrder.fulfillmentChannel === 'AFN' ? 'FBA (Amazon)' : 'FBM (Merchant)'}
                    </span>
                  </div>
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Sales Channel</span>
                    <span className="apple-drawer-field-val">{selectedOrder.salesChannel || 'Amazon.com'}</span>
                  </div>
                </div>
              </div>

              {/* Customer Info */}
              <div className="apple-drawer-section">
                <h3 className="apple-drawer-section-title">Customer</h3>
                <div className="apple-drawer-grid">
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Buyer Name</span>
                    <span className="apple-drawer-field-val">{selectedOrder.buyerName || 'Amazon Customer'}</span>
                  </div>
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Buyer Email</span>
                    <span className="apple-drawer-field-val">{selectedOrder.buyerEmail || 'Protected by Amazon'}</span>
                  </div>
                </div>
              </div>

              {/* Items */}
              <div className="apple-drawer-section">
                <h3 className="apple-drawer-section-title">Purchased Items ({selectedOrder.orderItems.length})</h3>
                {selectedOrder.orderItems.map((item, idx) => (
                  <div key={item.asin || idx} className="apple-drawer-item-card">
                    <span className="material-symbols-outlined" style={{ fontSize: '24px', color: '#86868B' }}>
                      package_2
                    </span>
                    <div style={{ flex: 1 }}>
                      <div className="apple-drawer-item-title">{item.title}</div>
                      <div className="apple-drawer-item-sub">
                        ASIN: {item.asin} • SKU: {item.sellerSku || 'N/A'} • Qty: {item.quantityOrdered}
                      </div>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {formatMoney(item.itemPrice?.amount, item.itemPrice?.currencyCode)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Payment & Shipping */}
              <div className="apple-drawer-section">
                <h3 className="apple-drawer-section-title">Payment &amp; Shipping</h3>
                <div className="apple-drawer-grid">
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Payment Method</span>
                    <span className="apple-drawer-field-val">
                      {selectedOrder.paymentMethodDetails?.paymentMethod || selectedOrder.paymentMethod || 'Standard'}
                    </span>
                  </div>
                  <div className="apple-drawer-field">
                    <span className="apple-drawer-field-label">Total Amount</span>
                    <span className="apple-drawer-field-val" style={{ color: '#0071e3', fontSize: '1rem' }}>
                      {formatMoney(selectedOrder.orderTotal?.amount, selectedOrder.orderTotal?.currencyCode)}
                    </span>
                  </div>
                  <div className="apple-drawer-field" style={{ gridColumn: 'span 2' }}>
                    <span className="apple-drawer-field-label">Ship Address</span>
                    <span className="apple-drawer-field-val">
                      {selectedOrder.shippingAddress
                        ? `${selectedOrder.shippingAddress.city || ''}, ${selectedOrder.shippingAddress.stateOrRegion || ''} ${selectedOrder.shippingAddress.postalCode || ''}, ${selectedOrder.shippingAddress.countryCode || ''}`
                        : 'Confidential (FBA Fulfillment)'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}