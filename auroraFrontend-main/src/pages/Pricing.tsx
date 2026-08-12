import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getRepricerDashboard, runAllRepricers } from '../api';
import { Product, RepricerLog } from '../types';
import '../styles/dashboard.css';

function money(value?: number | null) {
  if (value == null) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function when(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function Pricing() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [stats, setStats] = useState({
    activeRules: 0,
    priceChangesToday: 0,
    errorsToday: 0,
    minimumHitsToday: 0,
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [logs, setLogs] = useState<RepricerLog[]>([]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const response = await getRepricerDashboard(token);
      setStats({
        activeRules: response.data.activeRules,
        priceChangesToday: response.data.priceChangesToday,
        errorsToday: response.data.errorsToday,
        minimumHitsToday: response.data.minimumHitsToday,
      });
      setProducts(response.data.recentProducts || []);
      setLogs(response.data.recentLogs || []);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRunAll = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const response = await runAllRepricers(token);
      setMessage(
        `Repricer batch: ${response.data.updated ?? 0} updated, ${response.data.skipped ?? 0} skipped, ${response.data.errors ?? 0} errors`,
      );
      void load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="apple-dashboard">
      <div className="apple-dashboard-container">
        {/* Header Section */}
        <header className="apple-dashboard-header">
          <div>
            <h1 className="apple-dashboard-title">Pricing Strategy</h1>
            <p className="apple-dashboard-subtitle">
              Monitor Buy Box placement, min/max price guardrails, and real-time repricing activity.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="apple-btn-primary"
              onClick={handleRunAll}
              disabled={loading}
            >
              <span
                className="material-symbols-outlined"
                style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}
              >
                sync
              </span>
              {loading ? 'Running Repricer…' : 'Run All Repricer Rules'}
            </button>
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* KPI Section */}
        <section className="apple-kpi-grid">
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Active Repricer Rules</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats.activeRules}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Price Adjustments (Today)</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats.priceChangesToday}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Floor Hits (Min Price)</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats.minimumHitsToday}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">System Errors</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats.errorsToday}</span>
            </div>
          </div>
        </section>

        {/* Recent Repriced Products */}
        <section className="apple-card">
          <h2 className="apple-card-title" style={{ marginBottom: '1rem' }}>Recent Price Adjustments</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="apple-table" style={{ minWidth: '700px' }}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Current Price</th>
                  <th>Min Price</th>
                  <th>Max Price</th>
                  <th>Rule State</th>
                  <th>Last Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#86868B' }}>
                      No pricing activity recorded.
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <tr key={product._id}>
                      <td style={{ fontWeight: 600 }}>{product.title}</td>
                      <td>{money(product.price?.amount)}</td>
                      <td>{money(product.minimumPrice?.amount)}</td>
                      <td>{money(product.maximumPrice?.amount)}</td>
                      <td>
                        <span className={`apple-badge ${product.repricer?.enabled ? 'active' : 'inactive'}`}>
                          {product.repricer?.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td style={{ color: '#86868B' }}>{when(product.repricer?.lastRunAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
