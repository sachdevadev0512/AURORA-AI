import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  getProducts,
  exportProductsCsv,
  syncProducts,
  deleteProduct,
} from '../api';
import { Product } from '../types';
import useInventorySocket from '../hooks/useInventorySocket';
import { buildAmazonListingUrl, getProductPrimaryImage } from '../utils/amazonListing';
import '../styles/products.css';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export default function Products() {
  const { token, user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [syncProcessed, setSyncProcessed] = useState(0);
  const [message, setMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [listingFilter, setListingFilter] = useState('listed');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [reportFilter, setReportFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState('lastUpdatedTime');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, pages: 0 });

  const hasActiveFilters = useMemo(
    () => Boolean(searchTerm || listingFilter !== 'listed' || fulfillmentFilter || stockFilter),
    [searchTerm, listingFilter, fulfillmentFilter, stockFilter],
  );

  const loadProducts = useCallback(
    async (
      page = 1,
      limit = 25,
      overrides: {
        search?: string;
        listing?: string;
        fulfillment?: string;
        stock?: string;
        sortBy?: string;
        sortOrder?: 'asc' | 'desc';
      } = {},
    ) => {
      if (!token) return;
      try {
        setLoading(true);
        const response = await getProducts(
          token,
          page,
          limit,
          overrides.search ?? searchTerm,
          undefined,
          overrides.stock ?? stockFilter,
          overrides.sortBy ?? sortBy,
          overrides.sortOrder ?? sortOrder,
          overrides.listing ?? listingFilter,
          overrides.fulfillment ?? fulfillmentFilter,
        );
        setProducts(response.data || []);
        if (response.pagination) {
          setPagination(response.pagination);
        }
      } catch (err) {
        setMessage((err as Error).message);
        setProducts([]);
      } finally {
        setLoading(false);
      }
    },
    [token, searchTerm, stockFilter, sortBy, sortOrder, listingFilter, fulfillmentFilter],
  );

  useInventorySocket({
    userId: user?._id,
    enabled: Boolean(token && user?._id),
    onSyncStatus: (data) => {
      if (data.processed != null) setSyncProcessed(data.processed);
      if (data.message) setMessage(data.message);
    },
    onSyncComplete: (data) => {
      setSyncLoading(false);
      if (data.processed != null) setSyncProcessed(data.processed);
      setMessage(data.message || 'Inventory sync finished.');
      void loadProducts(1, pagination.limit);
    },
  });

  useEffect(() => {
    const timeout = setTimeout(() => setSearchTerm(searchInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (token) {
      void loadProducts(1, pagination.limit);
    }
  }, [token, searchTerm, listingFilter, fulfillmentFilter, stockFilter, sortBy, sortOrder, loadProducts]);

  const handleSync = async () => {
    if (!token) return;
    try {
      setSyncLoading(true);
      const response = await syncProducts(token);
      setMessage(response.message || 'Product sync started on the server.');
      if (response.processed) setSyncProcessed(response.processed);
    } catch (err) {
      setMessage((err as Error).message);
      setSyncLoading(false);
    }
  };

  const downloadCsv = async () => {
    if (!token) return;
    try {
      setCsvLoading(true);
      const blob = await exportProductsCsv(
        token,
        searchTerm,
        undefined,
        stockFilter,
        sortBy,
        sortOrder,
        listingFilter,
        fulfillmentFilter,
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `amazon-inventory-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      setMessage('Products CSV downloaded successfully.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setCsvLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!token) return;
    if (!window.confirm('Delete this product entry from database?')) return;
    try {
      setLoading(true);
      await deleteProduct(token, id);
      setMessage('Product deleted.');
      void loadProducts(pagination.page, pagination.limit);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const s = (status || '').toLowerCase();
    const badgeClass =
      s.includes('active')
        ? 'active'
        : s.includes('inact') || s.includes('out')
          ? 'pending'
          : 'inactive';
    return <span className={`apple-badge ${badgeClass}`}>{status || 'Active'}</span>;
  };

  return (
    <div className="apple-products-page">
      <div className="apple-products-container">
        {/* Header Section */}
        <header className="apple-products-header">
          <div>
            <h1 className="apple-products-title">Products &amp; Inventory</h1>
            <p className="apple-products-desc">
              Syncs all Seller Central listings (FBA + merchant-fulfilled) and merges FBA warehouse quantities.
              <br />
              Runs on the server — safe to close this tab.
            </p>
          </div>

          <div className="apple-header-controls">
            <select
              className="apple-select"
              value={reportFilter}
              onChange={(e) => setReportFilter(e.target.value)}
            >
              <option value="">Report: Current</option>
              <option value="historical">Report: Historical</option>
            </select>

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
              {syncLoading ? 'Syncing…' : 'Sync Inventory'}
            </button>
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* Search & Filter Bar Section */}
        <section className="apple-search-card">
          <div className="apple-search-row">
            <div className="apple-search-wrap">
              <span className="material-symbols-outlined apple-search-icon">search</span>
              <input
                type="text"
                className="apple-search-input"
                placeholder="Search by title, SKU, ASIN, FNSKU, EAN, or brand..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="apple-btn-secondary"
              onClick={() => setShowFilters((v) => !v)}
            >
              <span className="material-symbols-outlined">filter_list</span>
              Filters {hasActiveFilters ? '|' : ''}
            </button>
          </div>

          {showFilters && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', paddingTop: '0.5rem' }}>
              <select
                className="apple-select"
                value={listingFilter}
                onChange={(e) => setListingFilter(e.target.value)}
              >
                <option value="listed">Listed on Amazon</option>
                <option value="all">All Catalog</option>
                <option value="active">Active Status</option>
                <option value="inactive">Inactive Status</option>
              </select>

              <select
                className="apple-select"
                value={fulfillmentFilter}
                onChange={(e) => setFulfillmentFilter(e.target.value)}
              >
                <option value="">All Fulfillment (FBA &amp; FBM)</option>
                <option value="FBA">FBA (Amazon)</option>
                <option value="FBM">FBM (Merchant)</option>
              </select>

              <select
                className="apple-select"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
              >
                <option value="">All Stock Levels</option>
                <option value="inStock">In Stock (&gt;= 1)</option>
                <option value="outOfStock">Out of Stock (= 0)</option>
              </select>
            </div>
          )}

          {/* Sub-filters / Meta Row */}
          <div className="apple-meta-row">
            <div className="apple-meta-text">
              On Seller Central | {pagination.total} total
            </div>

            <div className="apple-meta-controls">
              <select
                className="apple-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="lastUpdatedTime">Sort: Last Update</option>
                <option value="listingCreatedDate">Sort: Created Date</option>
                <option value="title">Sort: Title (A-Z)</option>
                <option value="price.amount">Sort: Price</option>
                <option value="inventory.quantity">Sort: Available Qty</option>
              </select>

              <select
                className="apple-select"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">High -&gt; Low</option>
                <option value="asc">Low -&gt; High</option>
              </select>

              <select
                className="apple-select"
                value={pagination.limit}
                onChange={(e) => {
                  const newLimit = Number(e.target.value);
                  void loadProducts(1, newLimit);
                }}
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
            </div>
          </div>
        </section>

        {/* Data Table Section */}
        <section className="apple-table-card" style={{ height: '480px' }}>
          <div className="apple-table-scroll">
            <table className="apple-table">
              <thead>
                <tr>
                  <th style={{ width: '180px' }}>Product</th>
                  <th style={{ width: '110px' }}>EAN</th>
                  <th style={{ width: '100px' }}>Condition</th>
                  <th style={{ width: '90px' }}>Status</th>
                  <th style={{ width: '110px' }}>Listing Status</th>
                  <th style={{ width: '100px' }}>Fulfillment</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Available</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Inbound</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Reserved</th>
                  <th style={{ width: '110px', textAlign: 'right' }}>Unfulfillable</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Price</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Min Price</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Max Price</th>
                  <th style={{ width: '110px', textAlign: 'right' }}>Business Price</th>
                  <th className="apple-table-sticky-actions" style={{ width: '80px', textAlign: 'center' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && products.length === 0 ? (
                  <tr>
                    <td colSpan={15} style={{ textAlign: 'center', padding: '4rem 1rem', color: '#5e5e63' }}>
                      Loading inventory...
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={15} style={{ textAlign: 'center', padding: '4rem 1rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#5e5e63' }}>
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: '64px', opacity: 0.35, marginBottom: '0.75rem' }}
                        >
                          inventory_2
                        </span>
                        <p style={{ margin: 0, fontSize: '0.92rem' }}>
                          No products found. Try adjusting filters or click Sync inventory.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  products.map((product) => {
                    const imgUrl = getProductPrimaryImage(product);
                    const amazonUrl = buildAmazonListingUrl(product.asin, user?.marketplace);

                    return (
                      <tr key={product._id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            {imgUrl ? (
                              <img
                                src={imgUrl}
                                alt=""
                                style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 6, border: '1px solid #c1c6d6' }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: 36,
                                  height: 36,
                                  borderRadius: 6,
                                  backgroundColor: '#ecedf7',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: '#5e5e63',
                                }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                                  image
                                </span>
                              </div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                              <a
                                href={amazonUrl || undefined}
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontWeight: 600, color: '#181c23', textDecoration: 'none' }}
                                title={product.title}
                              >
                                {product.title}
                              </a>
                              <span style={{ fontSize: '0.75rem', color: '#5e5e63' }}>
                                SKU: {product.sku} | ASIN: {product.asin}
                              </span>
                            </div>
                          </div>
                        </td>

                        <td>{product.ean || '-'}</td>
                        <td>{product.condition || 'New'}</td>
                        <td>{getStatusBadge(product.status)}</td>
                        <td>{product.listingStatus || (product.isListedOnAmazon ? 'Active' : 'Inactive')}</td>
                        <td>{product.fulfillmentType || product.inventory?.fulfillmentChannel || 'FBA'}</td>

                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {product.inventory?.fulfillableQuantity ?? product.inventory?.quantity ?? 0}
                        </td>
                        <td style={{ textAlign: 'right' }}>{product.inventory?.inboundQuantity ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>{product.inventory?.reservedQuantity ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>{product.inventory?.unfulfillableQuantity ?? 0}</td>

                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {product.price?.amount != null ? `$${product.price.amount.toFixed(2)}` : '-'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {product.minimumPrice?.amount != null ? `$${product.minimumPrice.amount.toFixed(2)}` : '-'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {product.maximumPrice?.amount != null ? `$${product.maximumPrice.amount.toFixed(2)}` : '-'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {product.businessPrice?.amount != null ? `$${product.businessPrice.amount.toFixed(2)}` : '-'}
                        </td>

                        <td className="apple-table-sticky-actions" style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="apple-btn-secondary"
                            style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                            onClick={() => handleDelete(product._id)}
                            title="Delete entry"
                          >
                            <span className="material-symbols-outlined" style={{ color: '#ba1a1a', fontSize: '18px' }}>
                              delete
                            </span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Minimal Pagination / Footer */}
          <footer className="apple-pagination-footer">
            <span>Showing {pagination.total} of {pagination.total} results</span>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                onClick={() => loadProducts(pagination.page - 1, pagination.limit)}
                disabled={pagination.page <= 1 || loading}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>chevron_left</span>
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                onClick={() => loadProducts(pagination.page + 1, pagination.limit)}
                disabled={pagination.page >= pagination.pages || loading}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>chevron_right</span>
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
