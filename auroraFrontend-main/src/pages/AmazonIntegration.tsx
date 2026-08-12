import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSearchParams } from 'react-router-dom';
import {
  initiateAmazonOAuth,
  initiateAmazonAdsOAuth,
  disconnectAmazon,
  getConnectionStatus,
} from '../api';
import notificationAPI from '../api/notificationAPI';
import { AmazonConnectionStatus } from '../types';
import '../styles/integration.css';

export default function AmazonIntegration() {
  const { token, user, refreshUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [connectionStatus, setConnectionStatus] = useState<AmazonConnectionStatus | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [adsLoading, setAdsLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [orderNotifSubscribed, setOrderNotifSubscribed] = useState<boolean | null>(null);
  const [pollerRunning, setPollerRunning] = useState<boolean | null>(null);

  const loadConnectionStatus = async () => {
    if (!token) return;
    try {
      const response = await getConnectionStatus(token);
      setConnectionStatus(response);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const success = searchParams.get('success');
    const adsConnected = searchParams.get('ads_connected');
    const error = searchParams.get('error');

    if (success === 'true') {
      setMessage('Amazon Selling Partner account connected successfully.');
      setSearchParams({});
      refreshUser();
      void loadConnectionStatus();
    } else if (adsConnected === 'true') {
      setMessage('Amazon Ads API connected successfully.');
      setSearchParams({});
      refreshUser();
      void loadConnectionStatus();
    } else if (error) {
      setMessage(`${decodeURIComponent(error)}`);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams, refreshUser]);

  useEffect(() => {
    if (token) {
      void loadConnectionStatus();
      void notificationAPI.getOrderNotificationStatus().then((d) => setOrderNotifSubscribed(Boolean(d.subscribed))).catch(() => {});
      void notificationAPI.getSqsStatus().then((d) => setPollerRunning(Boolean(d.pollerRunning))).catch(() => {});
    }
  }, [token]);

  const handleConnectAmazon = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const response = await initiateAmazonOAuth(token);
      const targetUrl = (response as any).oauthUrl || (response as any).authorizationURL;
      if (targetUrl) {
        window.location.href = targetUrl;
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectAds = async () => {
    if (!token) return;
    try {
      setAdsLoading(true);
      const response = await initiateAmazonAdsOAuth(token);
      const targetUrl = (response as any).oauthUrl || (response as any).authorizationURL;
      if (targetUrl) {
        window.location.href = targetUrl;
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setAdsLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!token) return;
    if (!window.confirm('Are you sure you want to disconnect your Amazon account?')) return;
    try {
      setDisconnecting(true);
      await disconnectAmazon(token);
      setMessage('Amazon account disconnected.');
      refreshUser();
      void loadConnectionStatus();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = Boolean(connectionStatus?.isConnected || user?.hasAmazonSpConnected);

  return (
    <div className="apple-integration-page">
      <div className="apple-integration-container">
        {/* Header Section */}
        <header className="apple-integration-header">
          <h1 className="apple-integration-title">Amazon Integration</h1>
          <p className="apple-integration-desc">
            Manage your Amazon Selling Partner API (SP-API) and Amazon Advertising connections.
          </p>
        </header>

        {message && <div className="apple-alert">{message}</div>}

        {/* Main Status Banner Card */}
        <div className="apple-status-banner">
          <div className="apple-banner-top">
            <div>
              <span className="apple-info-label">PRIMARY STORE CONNECTION</span>
              <h2 style={{ margin: '0.2rem 0 0', fontSize: '1.4rem', fontWeight: 600 }}>
                Amazon Seller Central
              </h2>
            </div>
            <div className={`apple-status-pill ${isConnected ? 'connected' : 'disconnected'}`}>
              <span className="apple-status-dot" />
              <span>{isConnected ? 'Connected' : 'Not Connected'}</span>
            </div>
          </div>

          <div className="apple-info-grid">
            <div className="apple-info-item">
              <span className="apple-info-label">Seller ID</span>
              <span className="apple-info-val">
                {connectionStatus?.amazonSellerId || user?.amazonSellerId || '—'}
              </span>
            </div>
            <div className="apple-info-item">
              <span className="apple-info-label">Marketplace</span>
              <span className="apple-info-val">
                {connectionStatus?.marketplace || user?.marketplace || 'Amazon.com (US)'}
              </span>
            </div>
            <div className="apple-info-item">
              <span className="apple-info-label">Status</span>
              <span className="apple-info-val">
                {isConnected ? 'Synchronizing' : 'Action Required'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {!isConnected ? (
              <button
                type="button"
                className="apple-btn-primary"
                onClick={handleConnectAmazon}
                disabled={loading}
              >
                <span className="material-symbols-outlined">link</span>
                {loading ? 'Connecting…' : 'Connect Amazon Account'}
              </button>
            ) : (
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleDisconnect}
                disabled={disconnecting}
                style={{ borderColor: '#ff3b30', color: '#ff3b30' }}
              >
                <span className="material-symbols-outlined">link_off</span>
                {disconnecting ? 'Disconnecting…' : 'Disconnect Amazon'}
              </button>
            )}
          </div>
        </div>

        {/* Feature Cards Grid */}
        <div className="apple-card-grid">
          {/* Amazon Ads */}
          <div className="apple-card">
            <div className="apple-card-header">
              <div className="apple-card-icon">
                <span className="material-symbols-outlined">campaign</span>
              </div>
              <h3 className="apple-card-title">Amazon Advertising</h3>
            </div>
            <p className="apple-card-desc">
              Synchronize Sponsored Products campaign budgets, keyword bids, and ACOS performance.
            </p>
            <div style={{ marginTop: 'auto', paddingTop: '0.5rem' }}>
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleConnectAds}
                disabled={adsLoading}
              >
                {adsLoading ? 'Connecting…' : 'Connect Amazon Ads'}
              </button>
            </div>
          </div>

          {/* Real-time Order Notifications */}
          <div className="apple-card">
            <div className="apple-card-header">
              <div className="apple-card-icon">
                <span className="material-symbols-outlined">notifications_active</span>
              </div>
              <h3 className="apple-card-title">Real-Time Sync Engine</h3>
            </div>
            <p className="apple-card-desc">
              Automated SP-API SQS message queue polling for instant inventory &amp; order updates.
            </p>
            <div style={{ display: 'flex', gap: '1rem', marginTop: 'auto', fontSize: '0.82rem' }}>
              <span style={{ color: orderNotifSubscribed ? '#137333' : '#86868B', fontWeight: 500 }}>
                ● Notifications {orderNotifSubscribed ? 'Active' : 'Standby'}
              </span>
              <span style={{ color: pollerRunning ? '#137333' : '#86868B', fontWeight: 500 }}>
                ● Poller {pollerRunning ? 'Running' : 'Standby'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
