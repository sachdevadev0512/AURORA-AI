import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getProduct, getProductRepricerLogs } from '../api';
import { Product, RepricerLog } from '../types';
import { auroraSocket } from '../lib/auroraSocket';
import {
  formatProductFee,
  formatProductFbaFee,
  getProductReferralFee,
  getProductTotalFees,
} from '../utils/productFees';

function formatMoney(value?: { amount?: number; currency?: string } | number | null, currency = 'USD') {
  if (value == null) return 'N/A';
  if (typeof value === 'number') {
    return `${currency} ${value.toFixed(2)}`;
  }
  if (value.amount == null) return 'N/A';
  return `${value.currency || currency} ${value.amount.toFixed(2)}`;
}

function formatListingPrice(value?: { amount?: number; currency?: string } | null) {
  if (!value || value.amount == null || value.amount <= 0) return '—';
  return formatMoney(value);
}

function formatDate(value?: string | null) {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

function formatListingDate(value?: string | null) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <p>
      <strong>{label}:</strong> {value}
    </p>
  );
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [logs, setLogs] = useState<RepricerLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const loadProduct = useCallback(async () => {
    if (!token || !id) return;
    try {
      setLoading(true);
      const response = await getProduct(token, id);
      setProduct(response.data);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, token]);

  const loadLogs = useCallback(async () => {
    if (!token || !id) return;
    try {
      const response = await getProductRepricerLogs(token, id, 10);
      setLogs(response.data || []);
    } catch {
      setLogs([]);
    }
  }, [id, token]);

  useEffect(() => {
    void loadProduct();
    void loadLogs();
  }, [loadProduct, loadLogs]);

  useEffect(() => {
    if (!user?._id || !id) return;

    auroraSocket.connect(user._id);

    const unsubFees = auroraSocket.on('productFeesUpdated', (payload) => {
      const data = payload as { productId?: string };
      if (!data?.productId || data.productId === id) {
        void loadProduct();
      }
    });

    const unsubRepricer = auroraSocket.on('repricerUpdate', (payload) => {
      const data = payload as { productId?: string };
      if (!data?.productId || data.productId === id) {
        void loadProduct();
        void loadLogs();
      }
    });

    return () => {
      unsubFees();
      unsubRepricer();
    };
  }, [user?._id, id, loadProduct, loadLogs]);

  const fulfillmentType =
    product?.fulfillmentType && product.fulfillmentType !== 'UNKNOWN'
      ? product.fulfillmentType
      : product?.inventory?.fulfillmentChannel?.startsWith('AMAZON') ||
          product?.inventory?.fulfillmentChannel === 'AFN'
        ? 'FBA'
        : product?.inventory?.fulfillmentChannel === 'MFN' ||
            product?.inventory?.fulfillmentChannel === 'DEFAULT'
          ? 'FBM'
          : 'N/A';

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <h1>Product detail</h1>
          <p>Inventory, pricing, and fees for this listing.</p>
        </div>
        <Link className="btn secondary" to="/products">
          Back to products
        </Link>
      </div>

      {message && <div className="alert">{message}</div>}

      {loading ? (
        <div className="card">Loading product details…</div>
      ) : product ? (
        <>
          <div className="card">
            <h2>{product.title}</h2>

            <h3 style={{ marginTop: '1.5rem' }}>Listing</h3>
            <DetailRow label="ASIN" value={product.asin} />
            <DetailRow label="SKU" value={product.sku} />
            <DetailRow label="Listing Status" value={product.listingStatus || product.status} />
            <DetailRow label="Fulfillment Type" value={fulfillmentType} />
            <DetailRow label="Listing Created Date" value={formatListingDate(product.listingCreatedDate)} />
            <DetailRow label="Last Update Date" value={formatListingDate(product.lastUpdatedTime)} />

            <h3 style={{ marginTop: '1.5rem' }}>Pricing & Fees</h3>
            <DetailRow label="Current Price" value={formatMoney(product.price)} />
            <DetailRow label="Minimum Price" value={formatListingPrice(product.minimumPrice)} />
            <DetailRow label="Maximum Price" value={formatListingPrice(product.maximumPrice)} />
            <DetailRow label="Business Price" value={formatListingPrice(product.businessPrice)} />
            <DetailRow label="Lowest Marketplace Price" value={formatMoney(product.lowestPrice)} />
            <DetailRow
              label="Featured Offer (Buy Box)"
              value={
                product.featuredOffer?.isBuyBox
                  ? `Yes — ${formatMoney(product.featuredOffer.price)}`
                  : 'No'
              }
            />
            <DetailRow label="Referral Fee" value={formatProductFee(getProductReferralFee(product))} />
            <DetailRow
              label="FBA Fee"
              value={
                product.fulfillmentType === 'FBM'
                  ? '— (merchant-fulfilled — no FBA fee)'
                  : formatProductFbaFee(product)
              }
            />
            <DetailRow label="Total Fees" value={formatProductFee(getProductTotalFees(product))} />
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Competitive Repricer</h3>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
              Configure rules, dry-run, and bulk reprice from the Repricer page.
            </p>
            <DetailRow label="Status" value={product.repricer?.enabled ? 'Enabled' : 'Off'} />
            <DetailRow label="Strategy" value={product.repricer?.strategy || 'N/A'} />
            <DetailRow
              label="Min / Max"
              value={`${formatMoney(product.repricer?.minPrice, product.price?.currency)} – ${formatMoney(product.repricer?.maxPrice, product.price?.currency)}`}
            />
            <DetailRow label="Last action" value={product.repricer?.lastAction || 'N/A'} />
            <DetailRow label="Last run" value={formatDate(product.repricer?.lastRunAt)} />
            <div className="repricer-actions">
              <Link className="btn" to={`/repricer?productId=${product._id}`}>
                Open in Repricer
              </Link>
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Repricer history</h3>
            {logs.length === 0 ? (
              <p style={{ color: '#94a3b8' }}>No repricer runs yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Action</th>
                      <th>Previous</th>
                      <th>Competitor</th>
                      <th>Applied</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log._id}>
                        <td>{formatDate(log.createdAt)}</td>
                        <td>
                          {log.action}
                          {log.dryRun ? ' (dry)' : ''}
                        </td>
                        <td>{formatMoney(log.previousPrice)}</td>
                        <td>{formatMoney(log.competitorPrice)}</td>
                        <td>{formatMoney(log.appliedPrice)}</td>
                        <td>{log.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="card">Product not found.</div>
      )}
    </div>
  );
}
