import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getAds, syncAds, deleteAd, getAdStats } from '../api';
import { Ad } from '../types';
import useAdsSyncSocket from '../hooks/useAdsSyncSocket';
import '../styles/ads.css';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface AdStats {
  totalAds: number;
  activeAds: number;
  totalSpend: number;
  totalSales: number;
  totalImpressions: number;
  totalClicks: number;
  totalOrders: number;
  avgAcos: number;
  avgRoas: number;
}

export default function Ads() {
  const { token, user } = useAuth();
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [campaignTypeFilter, setCampaignTypeFilter] = useState('');
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, pages: 0 });
  const [stats, setStats] = useState<AdStats | null>(null);

  const formatMoney = (amount?: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount ?? 0);
  };

  const loadAds = useCallback(
    async (page = 1, limit = 25) => {
      if (!token) return;
      try {
        setLoading(true);
        const response = await getAds(
          token,
          page,
          limit,
          statusFilter || undefined,
          campaignTypeFilter || undefined,
          undefined,
          undefined,
          searchTerm || undefined,
          'impressions',
          'desc',
        );
        setAds(response.ads || []);
        if (response.pagination) {
          setPagination(response.pagination);
        }
      } catch (err) {
        setMessage((err as Error).message);
        setAds([]);
      } finally {
        setLoading(false);
      }
    },
    [token, searchTerm, statusFilter, campaignTypeFilter],
  );

  const loadStats = useCallback(async () => {
    if (!token) return;
    try {
      const response = await getAdStats(token);
      setStats(response as unknown as AdStats);
    } catch {
      // ignore
    }
  }, [token]);

  useAdsSyncSocket({
    userId: user?._id,
    enabled: Boolean(token && user?._id),
    onSyncComplete: () => {
      setSyncLoading(false);
      void loadAds(1, pagination.limit);
      void loadStats();
    },
  });

  useEffect(() => {
    const timeout = setTimeout(() => setSearchTerm(searchInput.trim()), 350);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (token) {
      void loadAds(1, pagination.limit);
      void loadStats();
    }
  }, [token, searchTerm, statusFilter, campaignTypeFilter, loadAds, loadStats]);

  const handleSync = async () => {
    if (!token) return;
    try {
      setSyncLoading(true);
      const response = await syncAds(token);
      setMessage(response.message || 'Ads sync started on the server.');
    } catch (err) {
      setMessage((err as Error).message);
      setSyncLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!token) return;
    if (!window.confirm('Delete this ad campaign?')) return;
    try {
      setLoading(true);
      await deleteAd(token, id);
      setMessage('Campaign deleted.');
      void loadAds(pagination.page, pagination.limit);
      void loadStats();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="apple-ads-page">
      <div className="apple-ads-container">
        {/* Header Section */}
        <header className="apple-ads-header">
          <div>
            <h1 className="apple-ads-title">Amazon Advertising</h1>
            <p className="apple-ads-desc">
              Track Sponsored Products PPC campaign budgets, ACOS performance, ROAS, and keyword attribution.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link to="/ads/create" className="apple-btn-primary">
              <span className="material-symbols-outlined">add</span>
              Create Campaign
            </Link>
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={handleSync}
              disabled={syncLoading || loading}
            >
              <span
                className="material-symbols-outlined"
                style={{ animation: syncLoading ? 'spin 1s linear infinite' : 'none' }}
              >
                sync
              </span>
              {syncLoading ? 'Syncing…' : 'Sync Ads'}
            </button>
          </div>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* KPI Metrics Section */}
        <section className="apple-kpi-grid">
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Ad Spend</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{formatMoney(stats?.totalSpend)}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Ad Sales</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{formatMoney(stats?.totalSales)}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Avg. ACOS</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats?.avgAcos ? `${stats.avgAcos.toFixed(1)}%` : '0%'}</span>
            </div>
          </div>
          <div className="apple-kpi-card">
            <span className="apple-kpi-label">Avg. ROAS</span>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{stats?.avgRoas ? `${stats.avgRoas.toFixed(2)}x` : '0.00x'}</span>
            </div>
          </div>
        </section>

        {/* Filter Bar */}
        <section className="apple-filter-card">
          <div className="apple-search-row">
            <div className="apple-search-wrap">
              <span className="material-symbols-outlined apple-search-icon">search</span>
              <input
                type="text"
                className="apple-search-input"
                placeholder="Search by Campaign Name or Targeting..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <select
              className="apple-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Paused">Paused</option>
              <option value="Archived">Archived</option>
            </select>
          </div>
        </section>

        {/* Table Section */}
        <section className="apple-table-card">
          <div className="apple-table-scroll">
            <table className="apple-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Daily Budget</th>
                  <th style={{ textAlign: 'right' }}>Spend</th>
                  <th style={{ textAlign: 'right' }}>Sales</th>
                  <th style={{ textAlign: 'right' }}>ACOS</th>
                  <th style={{ textAlign: 'right' }}>ROAS</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && ads.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '3rem 1rem', color: '#86868B' }}>
                      Loading campaigns…
                    </td>
                  </tr>
                ) : ads.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '3.5rem 1rem', color: '#86868B' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                        campaign
                      </span>
                      <p style={{ margin: '0.5rem 0 0' }}>No ad campaigns found.</p>
                    </td>
                  </tr>
                ) : (
                  ads.map((ad) => (
                    <tr key={ad._id}>
                      <td style={{ fontWeight: 600 }}>{ad.campaignName}</td>
                      <td>{ad.campaignType || 'Sponsored Products'}</td>
                      <td>
                        <span
                          className={`apple-badge ${
                            ad.status === 'Active'
                              ? 'active'
                              : ad.status === 'Paused'
                                ? 'pending'
                                : 'inactive'
                          }`}
                        >
                          {ad.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(ad.budget?.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(ad.spend?.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(ad.sales?.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{ad.acos ? `${ad.acos.toFixed(1)}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{ad.roas ? `${ad.roas.toFixed(2)}x` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="apple-btn-secondary"
                          style={{ padding: '0.2rem 0.4rem', border: 'none' }}
                          onClick={() => handleDelete(ad._id)}
                          title="Delete campaign"
                        >
                          <span className="material-symbols-outlined" style={{ color: '#ff3b30', fontSize: '16px' }}>
                            delete
                          </span>
                        </button>
                      </td>
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
