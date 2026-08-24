import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { getOrderAnalytics, syncOrders, syncProducts } from '../api';
import type { DashboardDatePreset, OrderAnalytics, OrderAnalyticsQuery } from '../api';
import '../styles/dashboard.css';

const STATUS_COLORS: Record<string, string> = {
  Delivered: '#34c759',
  Shipped: '#0071e3',
  Unshipped: '#af52de',
  Pending: '#ff9500',
  Cancelled: '#ff3b30',
  Returned: 'var(--field-muted)',
  Other: '#aeaeb2',
};

const STATUS_ORDER = ['Delivered', 'Shipped', 'Unshipped', 'Pending', 'Cancelled', 'Returned', 'Other'];

const PRESET_OPTIONS: Array<{ value: DashboardDatePreset; label: string; index: number }> = [
  { value: 7, label: '7D', index: 0 },
  { value: 15, label: '15D', index: 1 },
  { value: 30, label: '30D', index: 2 },
  { value: 90, label: '90D', index: 3 },
  { value: 'custom', label: 'Custom', index: 4 },
];

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function formatCompactMoney(value: number) {
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return `$${Math.round(value)}`;
}

function formatDateInput(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type DateParts = { year: number; month: number; day: number };

function parseDateOnly(value: string): DateParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function formatDateOnly(parts: DateParts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function compareDateParts(a: DateParts, b: DateParts) {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

function addUtcDays(parts: DateParts, delta: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + delta);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addUtcMonths(parts: DateParts, delta: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + delta);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 };
}

function formatDisplayDate(value: string) {
  const parts = parseDateOnly(value);
  if (!parts) return value;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatPeriodLabel(period: OrderAnalytics['period'] | undefined) {
  if (!period) return 'Last 30 days';
  if (period.preset === 'custom') {
    return `${formatDisplayDate(period.startDate)} – ${formatDisplayDate(period.endDate)}`;
  }
  return `Last ${period.days} days`;
}

function formatComparison(current: number, previous: number): string | null {
  if (!previous) {
    return previous === 0 && current > 0 ? '+100%' : null;
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.01) return null;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}% vs prior`;
}

function mapStatusBucketsToPie(
  statusBuckets: OrderAnalytics['statusBuckets'],
): Array<{ name: string; value: number }> {
  const counts = new Map((statusBuckets ?? []).map((row) => [row._id, row.count || 0]));
  return STATUS_ORDER.map((name) => ({
    name,
    value: counts.get(name) || 0,
  })).filter((row) => row.value > 0);
}

function buildDailyChartData(
  dailySales: OrderAnalytics['dailySales'],
  period: OrderAnalytics['period'] | undefined,
) {
  if (!period) return [];
  const start = parseDateOnly(period.startDate);
  const end = parseDateOnly(period.endDate);
  if (!start || !end) return [];

  const byDay = new Map(
    (dailySales ?? []).map((row) => [row._id, { revenue: row.revenue || 0, orders: row.orders || 0 }]),
  );

  const points: Array<{ label: string; key: string; revenue: number; orders: number }> = [];
  let cursor = start;

  while (compareDateParts(cursor, end) <= 0) {
    const key = formatDateOnly(cursor);
    const entry = byDay.get(key) ?? { revenue: 0, orders: 0 };
    points.push({
      label: new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      key,
      revenue: Math.round(entry.revenue * 100) / 100,
      orders: entry.orders,
    });
    cursor = addUtcDays(cursor, 1);
  }

  return points;
}

function buildMonthlyChartData(
  chartSales: OrderAnalytics['chartSales'],
  period: OrderAnalytics['period'] | undefined,
) {
  const byMonth = new Map(
    (chartSales ?? []).map((row) => [row._id, { revenue: row.revenue || 0, orders: row.orders || 0 }]),
  );

  if (!period) return [];
  const start = parseDateOnly(period.startDate);
  const end = parseDateOnly(period.endDate);
  if (!start || !end) return [];

  const points: Array<{ label: string; key: string; revenue: number; orders: number }> = [];
  let cursor: DateParts = { year: start.year, month: start.month, day: 1 };
  const endMonth: DateParts = { year: end.year, month: end.month, day: 1 };

  while (compareDateParts(cursor, endMonth) <= 0) {
    const key = `${cursor.year}-${String(cursor.month).padStart(2, '0')}`;
    const entry = byMonth.get(key) ?? { revenue: 0, orders: 0 };
    points.push({
      label: new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).toLocaleDateString('en-US', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      }),
      key,
      revenue: Math.round(entry.revenue * 100) / 100,
      orders: entry.orders,
    });
    cursor = addUtcMonths(cursor, 1);
  }

  return points;
}

function buildChartData(analytics: OrderAnalytics | null) {
  if (!analytics) return [];
  const granularity = analytics.period?.chartGranularity ?? (analytics.period?.days ?? 30) <= 90 ? 'day' : 'month';
  if (granularity === 'day') {
    return buildDailyChartData(analytics.dailySales ?? [], analytics.period);
  }
  return buildMonthlyChartData(analytics.chartSales ?? analytics.monthlySales ?? [], analytics.period);
}

export default function Dashboard() {
  const { token } = useAuth();
  const [analytics, setAnalytics] = useState<OrderAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [preset, setPreset] = useState<DashboardDatePreset>(30);
  const [customStart, setCustomStart] = useState(() => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 29);
    return formatDateInput(start);
  });
  const [customEnd, setCustomEnd] = useState(() => formatDateInput(new Date()));
  const [appliedQuery, setAppliedQuery] = useState<OrderAnalyticsQuery>({ days: 30 });
  const [lastSyncMinutes, setLastSyncMinutes] = useState(12);

  const loadDashboard = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const analyticsResponse = await getOrderAnalytics(token, appliedQuery);
      setAnalytics(analyticsResponse.data);
      setSyncMessage('');
    } catch (err) {
      setSyncMessage((err as Error).message || 'Failed to load dashboard analytics.');
    } finally {
      setLoading(false);
    }
  }, [token, appliedQuery]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const applyPreset = (nextPreset: DashboardDatePreset) => {
    setPreset(nextPreset);
    if (nextPreset === 'custom') {
      if (customStart && customEnd && customStart <= customEnd) {
        setAppliedQuery({ startDate: customStart, endDate: customEnd });
      }
      return;
    }
    setAppliedQuery({ days: nextPreset });
  };

  const applyCustomRange = () => {
    if (!customStart || !customEnd || customStart > customEnd) {
      setSyncMessage('Choose a valid custom date range.');
      return;
    }
    setPreset('custom');
    setAppliedQuery({ startDate: customStart, endDate: customEnd });
    setSyncMessage('');
  };

  const handleSync = async () => {
    if (!token) return;

    try {
      setLoading(true);
      const [productsResult, ordersResult] = await Promise.all([syncProducts(token), syncOrders(token)]);
      setSyncMessage(`${productsResult.message}; ${ordersResult.message}`);
      setLastSyncMinutes(0);
      void loadDashboard();
    } catch (err) {
      setSyncMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const summary = analytics?.summary ?? {
    totalOrders: 0,
    totalRevenue: 0,
    totalItems: 0,
    averageOrderValue: 0,
  };
  const previous = analytics?.previousSummary ?? {
    totalOrders: 0,
    totalRevenue: 0,
    averageOrderValue: 0,
  };
  const productCounts = analytics?.productCounts ?? { active: 0, listed: 0 };
  const periodLabel = formatPeriodLabel(analytics?.period);

  const pieData = useMemo(
    () => mapStatusBucketsToPie(analytics?.statusBuckets ?? []),
    [analytics?.statusBuckets],
  );

  const revenueChartData = useMemo(() => buildChartData(analytics), [analytics]);

  const activeSegmentIndex = useMemo(() => {
    const item = PRESET_OPTIONS.find((opt) => opt.value === preset);
    return item ? item.index : 2;
  }, [preset]);

  return (
    <div className="apple-dashboard">
      <div className="apple-dashboard-container">
        {/* Header Section */}
        <header className="apple-dashboard-header">
          <div>
            <h1 className="apple-dashboard-title">Seller Dashboard</h1>
            <p className="apple-dashboard-subtitle">Overview of your store performance and Amazon activity</p>
          </div>
          <div className="apple-dashboard-controls">
            <div className="apple-sync-info">
              <span className="apple-sync-time">
                {lastSyncMinutes === 0 ? 'Just synced' : `Last synced ${lastSyncMinutes} min ago`}
              </span>
              <button
                aria-label="Sync"
                title="Sync now"
                onClick={handleSync}
                disabled={loading}
                className="apple-icon-btn"
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    animation: loading ? 'spin 1s linear infinite' : 'none',
                  }}
                >
                  refresh
                </span>
              </button>
            </div>

            {/* Segmented Control */}
            <div className="apple-segmented-control" style={{ width: preset === 'custom' ? 'auto' : undefined }}>
              <div
                className="apple-segment-highlighter"
                style={{
                  transform: `translateX(${activeSegmentIndex * 48}px)`,
                }}
              />
              {PRESET_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`apple-segment-btn${preset === opt.value ? ' active' : ''}`}
                  onClick={() => applyPreset(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {preset === 'custom' && (
              <div className="apple-custom-date-container">
                <input
                  type="date"
                  value={customStart}
                  max={customEnd}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <span style={{ fontSize: '0.8rem', color: '#86868B' }}>to</span>
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  max={formatDateInput(new Date())}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
                <button
                  type="button"
                  className="apple-btn-primary"
                  style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }}
                  onClick={applyCustomRange}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        </header>

        {syncMessage && <div className="apple-alert">{syncMessage}</div>}

        {/* KPI Section */}
        <section className="apple-kpi-grid">
          <div className="apple-kpi-card">
            <div className="apple-kpi-header">
              <span className="apple-kpi-label">Orders</span>
              <div className="apple-kpi-icon-badge">
                <span className="material-symbols-outlined">shopping_bag</span>
              </div>
            </div>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{summary.totalOrders.toLocaleString()}</span>
              {formatComparison(summary.totalOrders, previous.totalOrders) && (
                <span className="apple-kpi-trend">
                  {formatComparison(summary.totalOrders, previous.totalOrders)}
                </span>
              )}
            </div>
          </div>

          <div className="apple-kpi-card">
            <div className="apple-kpi-header">
              <span className="apple-kpi-label">Revenue</span>
              <div className="apple-kpi-icon-badge">
                <span className="material-symbols-outlined">attach_money</span>
              </div>
            </div>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{formatMoney(summary.totalRevenue)}</span>
              {formatComparison(summary.totalRevenue, previous.totalRevenue) && (
                <span className="apple-kpi-trend">
                  {formatComparison(summary.totalRevenue, previous.totalRevenue)}
                </span>
              )}
            </div>
          </div>

          <div className="apple-kpi-card">
            <div className="apple-kpi-header">
              <span className="apple-kpi-label">Avg. Order Value</span>
              <div className="apple-kpi-icon-badge">
                <span className="material-symbols-outlined">trending_up</span>
              </div>
            </div>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{formatMoney(summary.averageOrderValue)}</span>
              {formatComparison(summary.averageOrderValue, previous.averageOrderValue) && (
                <span className="apple-kpi-trend">
                  {formatComparison(summary.averageOrderValue, previous.averageOrderValue)}
                </span>
              )}
            </div>
          </div>

          <div className="apple-kpi-card">
            <div className="apple-kpi-header">
              <span className="apple-kpi-label">Active Products</span>
              <div className="apple-kpi-icon-badge">
                <span className="material-symbols-outlined">inventory_2</span>
              </div>
            </div>
            <div className="apple-kpi-value-row">
              <span className="apple-kpi-number">{productCounts.active.toLocaleString()}</span>
              {productCounts.listed > 0 && (
                <span className="apple-kpi-trend">{`${productCounts.listed} listed`}</span>
              )}
            </div>
          </div>
        </section>

        {/* Analytics Area */}
        <section className="apple-analytics-grid">
          {/* Revenue Column */}
          <div className="apple-card">
            <div className="apple-card-header-bar">
              <div>
                <h2 className="apple-card-title">Revenue performance</h2>
                <div className="apple-card-amount">{formatMoney(summary.totalRevenue)}</div>
                <span className="apple-card-sublabel">{periodLabel}</span>
              </div>
              <span className="apple-card-badge">Analytics</span>
            </div>

            <div style={{ width: '100%', height: 240, marginTop: '1rem' }}>
              {revenueChartData.some((row) => row.revenue > 0) ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revenueChartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F0F0F2" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: '#86868B', fontSize: 11 }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: '#86868B', fontSize: 11 }}
                      tickFormatter={formatCompactMoney}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card-bg)',
                        border: '1px solid var(--border)',
                        borderRadius: '10px',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
                        color: '#1D1D1F',
                        fontSize: '12px',
                      }}
                      formatter={(value) => [formatMoney(Number(value ?? 0)), 'Revenue']}
                    />
                    <Bar dataKey="revenue" fill="#4D669B" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="apple-empty-state" style={{ minHeight: 180, padding: '1.5rem' }}>
                  <div className="apple-empty-icon">
                    <span className="material-symbols-outlined">bar_chart</span>
                  </div>
                  <h3 className="apple-empty-heading">No revenue data</h3>
                  <p className="apple-empty-text" style={{ margin: 0 }}>
                    No revenue recorded for {periodLabel.toLowerCase()}.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Orders / Distribution Column */}
          <div className="apple-card" style={{ justifyContent: 'center' }}>
            {summary.totalOrders > 0 || pieData.length > 0 ? (
              <div>
                <div className="apple-card-header-bar">
                  <div>
                    <h2 className="apple-card-title">Order status distribution</h2>
                    <span className="apple-card-sublabel">{periodLabel}</span>
                  </div>
                  <span className="apple-card-badge">Breakdown</span>
                </div>
                <div style={{ width: '100%', height: 240, marginTop: '1rem' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="45%"
                        innerRadius={50}
                        outerRadius={75}
                        paddingAngle={2}
                        dataKey="value"
                        nameKey="name"
                      >
                        {pieData.map((entry) => (
                          <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || STATUS_COLORS.Other} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: 'var(--card-bg)',
                          border: '1px solid var(--border)',
                          borderRadius: '10px',
                          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
                        }}
                      />
                      <Legend verticalAlign="bottom" iconType="circle" />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <div className="apple-empty-state">
                <div className="apple-empty-icon">
                  <span className="material-symbols-outlined">shopping_bag</span>
                </div>
                <h3 className="apple-empty-heading">No orders recorded yet</h3>
                <p className="apple-empty-text">
                  Sync your Amazon store to start tracking fulfillment, sales performance, and order status breakdown.
                </p>
                <button
                  type="button"
                  className="apple-primary-link"
                  onClick={handleSync}
                  disabled={loading}
                >
                  Sync store now
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                    arrow_forward
                  </span>
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
