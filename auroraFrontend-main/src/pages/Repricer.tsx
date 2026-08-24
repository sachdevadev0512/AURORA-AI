import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  bulkConfigureRepricer,
  bulkSetListingPrices,
  getAllRepricerLogs,
  getProducts,
  getRepricerDashboard,
  runAllRepricers,
  runProductRepricer,
} from '../api';
import { Product, ProductRepricerConfig } from '../types';
import { auroraSocket } from '../lib/auroraSocket';
import '../styles/repricer.css';

type FormState = {
  enabled: boolean;
  dryRun: boolean;
  strategy: NonNullable<ProductRepricerConfig['strategy']>;
  pricingMode: NonNullable<ProductRepricerConfig['pricingMode']>;
  speedMode: NonNullable<ProductRepricerConfig['speedMode']>;
  minPrice: string;
  maxPrice: string;
  beatByAmount: string;
  cooldownMinutes: string;
  maxChangePercent: string;
  unitCost: string;
  inboundShipping: string;
  targetProfit: string;
  minRoiPercent: string;
  fbaOnly: boolean;
  excludeAmazon: boolean;
  minFeedbackPercent: string;
  minFeedbackCount: string;
  raiseWhenAlonePercent: string;
  autoDisable: boolean;
};

const STRATEGIES: Array<{ id: FormState['strategy']; label: string }> = [
  { id: 'MATCH_LOWEST', label: 'Match lowest' },
  { id: 'BEAT_LOWEST', label: 'Below lowest by $' },
  { id: 'BEAT_BUY_BOX', label: 'Above lowest by $' },
  { id: 'MATCH_BUY_BOX', label: 'Match Buy Box' },
];

function emptyForm(): FormState {
  return {
    enabled: true,
    dryRun: false,
    strategy: 'MATCH_LOWEST',
    pricingMode: 'PROFIT_FIRST',
    speedMode: 'CONSERVATIVE',
    minPrice: '',
    maxPrice: '',
    beatByAmount: '0.01',
    cooldownMinutes: '30',
    maxChangePercent: '15',
    unitCost: '',
    inboundShipping: '',
    targetProfit: '',
    minRoiPercent: '',
    fbaOnly: false,
    excludeAmazon: false,
    minFeedbackPercent: '',
    minFeedbackCount: '',
    raiseWhenAlonePercent: '5',
    autoDisable: true,
  };
}

export default function Repricer() {
  const { token, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [sortBy, setSortBy] = useState('updatedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState>(emptyForm());
  const [fixedPrice, setFixedPrice] = useState('');

  const loadProducts = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const response = await getProducts(
        token,
        page,
        pageSize,
        searchTerm || undefined,
        undefined,
        'inStock',
        sortBy,
        sortOrder,
        'active',
        fulfillmentFilter || undefined,
      );
      setProducts(response.data || []);
      setTotal(response.pagination?.total ?? response.data?.length ?? 0);
      setPages(response.pagination?.pages ?? 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, page, pageSize, searchTerm, fulfillmentFilter, sortBy, sortOrder]);

  useEffect(() => {
    if (token) {
      void loadProducts();
    }
  }, [token, loadProducts]);

  useEffect(() => {
    if (!token || !user?._id) return undefined;
    auroraSocket.connect(user._id);
    const unsub = auroraSocket.on('repricerUpdate', () => {
      void loadProducts();
    });
    return () => unsub();
  }, [token, user?._id, loadProducts]);

  // Deep-link from product detail: /repricer?productId=...
  useEffect(() => {
    const focusId = searchParams.get('productId');
    if (!focusId || products.length === 0) return;
    const match = products.find((p) => p._id === focusId);
    if (!match) return;
    setSelected((prev) => new Set(prev).add(focusId));
    setSearchParams({}, { replace: true });
  }, [products, searchParams, setSearchParams]);

  const selectedIds = useMemo(
    () => [...selected].map(String).filter(Boolean),
    [selected],
  );

  const allVisibleSelected =
    products.length > 0 && products.every((p) => selected.has(p._id));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) products.forEach((p) => next.delete(p._id));
      else products.forEach((p) => next.add(p._id));
      return next;
    });
  };

  const toggleOne = (productId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const applySearch = () => {
    setPage(1);
    setSearchTerm(searchInput.trim());
  };

  // Bulk Actions
  const handleFillSelected = () => {
    if (selectedIds.length === 0) {
      setError('Select at least one listing first.');
      return;
    }
    setMessage(`Applied inputs to ${selectedIds.length} selected listing(s).`);
    setError('');
  };

  const handleSaveBounds = async () => {
    if (!token) return;
    if (selectedIds.length === 0) {
      setError('Select at least one listing first.');
      return;
    }
    try {
      setBusy(true);
      setError('');
      const minP = form.minPrice ? Number(form.minPrice) : undefined;
      const maxP = form.maxPrice ? Number(form.maxPrice) : undefined;
      await bulkConfigureRepricer(token, selectedIds, {
        minPrice: minP,
        maxPrice: maxP,
        strategy: form.strategy,
        enabled: form.enabled,
        raiseWhenAlonePercent: Number(form.raiseWhenAlonePercent) || 5,
        autoDisable: form.autoDisable,
      });
      setMessage(`Saved bounds and strategy for ${selectedIds.length} listing(s).`);
      void loadProducts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCheckLIF = async () => {
    if (!token) return;
    try {
      setBusy(true);
      setError('');
      setMessage('Checking Low Inventory Fee protection across catalog...');
      await runAllRepricers(token);
      setMessage('Low Inventory Fee check completed.');
      void loadProducts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRunRepriceNow = async () => {
    if (!token) return;
    try {
      setBusy(true);
      setError('');
      if (selectedIds.length === 1) {
        await runProductRepricer(token, selectedIds[0]);
      } else {
        await runAllRepricers(token);
      }
      setMessage('Repricer execution finished.');
      void loadProducts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyPrice = async () => {
    if (!token) return;
    if (selectedIds.length === 0) {
      setError('Select at least one listing first.');
      return;
    }
    try {
      setBusy(true);
      setError('');
      if (fixedPrice && Number(fixedPrice) > 0) {
        await bulkSetListingPrices(token, selectedIds, Number(fixedPrice));
        setMessage(`Applied price $${fixedPrice} to ${selectedIds.length} selected listing(s).`);
      } else {
        await handleSaveBounds();
      }
      void loadProducts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="repricer-page">
      <div className="apple-products-container">
        {/* Header */}
        <header className="page-header">
          <div>
            <h1>Repricer</h1>
            <p>
              Set min/max and strategy, reprice against competitors, and protect against Low Inventory Fee.
            </p>
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--field-muted)', fontWeight: 500, alignSelf: 'center' }}>
            {selected.size} selected | {total} listings
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}
        {error && <div className="apple-alert danger">{error}</div>}

        {/* Main Repricer Control Box Card */}
        <section className="apple-search-card" style={{ gap: '1rem', padding: '1.25rem' }}>
          {/* Row 1: Search ASIN, SKU, or title + Search button */}
          <div className="apple-search-row">
            <div className="apple-search-wrap">
              <span className="material-symbols-outlined apple-search-icon">search</span>
              <input
                type="text"
                className="apple-search-input"
                placeholder="Search ASIN, SKU, or title"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              />
            </div>
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={applySearch}
              disabled={loading}
            >
              Search
            </button>
          </div>

          {/* Row 2: Inputs Grid (Min, Max, Apply price, Strategy, LIF raise %, Auto, LIF protect) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
              gap: '0.75rem',
              alignItems: 'end',
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--field-muted)', marginBottom: '0.25rem', fontWeight: 500 }}>
                Min
              </label>
              <input
                type="number"
                step="0.01"
                className="apple-search-input"
                style={{ padding: '0.45rem 0.65rem' }}
                placeholder="0.00"
                value={form.minPrice}
                onChange={(e) => setForm((f) => ({ ...f, minPrice: e.target.value }))}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--field-muted)', marginBottom: '0.25rem', fontWeight: 500 }}>
                Max
              </label>
              <input
                type="number"
                step="0.01"
                className="apple-search-input"
                style={{ padding: '0.45rem 0.65rem' }}
                placeholder="0.00"
                value={form.maxPrice}
                onChange={(e) => setForm((f) => ({ ...f, maxPrice: e.target.value }))}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--field-muted)', marginBottom: '0.25rem', fontWeight: 500 }}>
                Apply price
              </label>
              <input
                type="number"
                step="0.01"
                className="apple-search-input"
                style={{ padding: '0.45rem 0.65rem' }}
                placeholder="Current listed price"
                value={fixedPrice}
                onChange={(e) => setFixedPrice(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--field-muted)', marginBottom: '0.25rem', fontWeight: 500 }}>
                Strategy
              </label>
              <select
                className="apple-select"
                style={{ width: '100%', padding: '0.45rem 1.8rem 0.45rem 0.65rem' }}
                value={form.strategy}
                onChange={(e) => setForm((f) => ({ ...f, strategy: e.target.value as any }))}
              >
                {STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--field-muted)', marginBottom: '0.25rem', fontWeight: 500 }}>
                LIF raise %
              </label>
              <input
                type="number"
                className="apple-search-input"
                style={{ padding: '0.45rem 0.65rem' }}
                value={form.raiseWhenAlonePercent}
                onChange={(e) => setForm((f) => ({ ...f, raiseWhenAlonePercent: e.target.value }))}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingBottom: '0.4rem' }}>
              <input
                type="checkbox"
                id="chk-auto"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <label htmlFor="chk-auto" style={{ fontSize: '0.82rem', color: 'var(--field-text)', cursor: 'pointer', fontWeight: 500 }}>
                Auto
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingBottom: '0.4rem' }}>
              <input
                type="checkbox"
                id="chk-lif"
                checked={form.autoDisable}
                onChange={(e) => setForm((f) => ({ ...f, autoDisable: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <label htmlFor="chk-lif" style={{ fontSize: '0.82rem', color: 'var(--field-text)', cursor: 'pointer', fontWeight: 500 }}>
                LIF protect
              </label>
            </div>
          </div>

          {/* Row 3: Per page + Action buttons */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
              borderTop: '1px solid var(--border)',
              paddingTop: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.78rem', color: 'var(--field-muted)', fontWeight: 500 }}>Per page</span>
              <select
                className="apple-select"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleFillSelected}
                disabled={busy || loading}
              >
                Fill selected
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleSaveBounds}
                disabled={busy || loading}
              >
                Save bounds
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleCheckLIF}
                disabled={busy || loading}
              >
                Check LIF now
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleRunRepriceNow}
                disabled={busy || loading}
              >
                Reprice now
              </button>
              <button
                type="button"
                className="apple-btn-primary"
                onClick={handleApplyPrice}
                disabled={busy || loading}
              >
                Apply price
              </button>
            </div>
          </div>
        </section>

        {/* Selection Status Banner Card */}
        <section
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            padding: '0.85rem 1.15rem',
            fontSize: '0.88rem',
            color: 'var(--field-text)',
            fontWeight: 500,
          }}
        >
          {selected.size === 0
            ? 'Select at least one listing first.'
            : `${selected.size} listing(s) selected.`}
        </section>

        {/* Listings Table / Empty State Card */}
        <section className="apple-table-card" style={{ height: '480px' }}>
          <div className="apple-table-scroll">
            <table className="apple-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={products.length > 0 && selected.size === products.length}
                      onChange={toggleAllVisible}
                      style={{ cursor: 'pointer' }}
                    />
                  </th>
                  <th style={{ minWidth: '300px', width: '100%' }}>Product</th>
                  <th style={{ minWidth: '150px' }}>ASIN / SKU</th>
                  <th style={{ minWidth: '110px' }}>Fulfillment</th>
                  <th style={{ minWidth: '130px', textAlign: 'right' }}>Current Price</th>
                  <th style={{ minWidth: '110px', textAlign: 'right' }}>Min Price</th>
                  <th style={{ minWidth: '110px', textAlign: 'right' }}>Max Price</th>
                  <th style={{ minWidth: '150px' }}>Strategy</th>
                  <th style={{ minWidth: '110px', textAlign: 'right' }}>LIF Raise %</th>
                  <th style={{ minWidth: '90px', textAlign: 'center' }}>Auto</th>
                  <th style={{ minWidth: '110px', textAlign: 'center' }}>LIF Protect</th>
                  <th className="apple-table-sticky-actions" style={{ minWidth: '90px', textAlign: 'center' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && products.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--field-muted)' }}>
                      Loading repricer catalog...
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ textAlign: 'center', padding: '4rem 1rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--field-muted)' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.35, marginBottom: '0.5rem' }}>
                          inventory_2
                        </span>
                        <p style={{ margin: 0, fontSize: '0.92rem' }}>No listings found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  products.map((product) => {
                    const isChecked = selected.has(product._id);
                    const repricer = product.repricer;

                    return (
                      <tr key={product._id} className={isChecked ? 'repricer-row-selected' : ''}>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleOne(product._id)}
                            style={{ cursor: 'pointer' }}
                          />
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--field-text)', fontSize: '0.88rem' }}>
                            {product.title}
                          </div>
                        </td>
                        <td>
                          <div style={{ fontSize: '0.78rem', color: 'var(--field-muted)' }}>
                            ASIN: {product.asin}
                            <br />
                            SKU: {product.sku}
                          </div>
                        </td>
                        <td>{product.fulfillmentType || 'FBA'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {product.price?.amount != null ? `$${product.price.amount.toFixed(2)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {repricer?.minPrice != null ? `$${repricer.minPrice.toFixed(2)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {repricer?.maxPrice != null ? `$${repricer.maxPrice.toFixed(2)}` : '—'}
                        </td>
                        <td>{repricer?.strategy || 'MATCH_LOWEST'}</td>
                        <td style={{ textAlign: 'right' }}>{repricer?.raiseWhenAlonePercent ?? 5}%</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={repricer?.enabled ? 'repricer-status-on' : 'repricer-status-off'}>
                            {repricer?.enabled ? 'Active' : 'Off'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {repricer?.autoDisable !== false ? 'Yes' : 'No'}
                        </td>
                        <td className="apple-table-sticky-actions" style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="apple-btn-secondary"
                            style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                            onClick={async () => {
                              try {
                                setBusy(true);
                                await runProductRepricer(token!, product._id);
                                setMessage(`Repriced ${product.sku}`);
                                void loadProducts();
                              } catch (err) {
                                setError((err as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                            title="Run repricer for item"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                              play_arrow
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

          {/* Footer Pagination */}
          <footer className="apple-pagination-footer">
            <span>
              Showing {total === 0 ? 0 : (page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total} listings
            </span>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>chevron_left</span>
              </button>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages || loading}
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
