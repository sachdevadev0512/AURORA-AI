import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import '../styles/settings.css';

type SettingsTab = 'account' | 'amazon' | 'notifications' | 'security' | 'preferences';

export default function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>('account');
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [marketplace, setMarketplace] = useState(user?.marketplace || 'Amazon.com (US)');
  const [orderAlerts, setOrderAlerts] = useState(true);
  const [stockAlerts, setStockAlerts] = useState(true);
  const [digestEmail, setDigestEmail] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSavedMessage('Settings saved successfully.');
    setTimeout(() => setSavedMessage(''), 3000);
  };

  return (
    <div className="apple-settings-page">
      <div className="apple-settings-container">
        {/* Header Section */}
        <header className="apple-settings-header">
          <h1 className="apple-settings-title">Settings</h1>
          <p className="apple-settings-section-desc">
            Manage your account preferences, Amazon seller credentials, and notification rules.
          </p>
        </header>

        {savedMessage && <div className="apple-alert">{savedMessage}</div>}

        <div className="apple-settings-layout">
          {/* Sidebar Menu */}
          <nav className="apple-settings-sidebar">
            <button
              type="button"
              className={`apple-settings-tab${activeTab === 'account' ? ' active' : ''}`}
              onClick={() => setActiveTab('account')}
            >
              <span className="material-symbols-outlined">person</span>
              Account
            </button>
            <button
              type="button"
              className={`apple-settings-tab${activeTab === 'amazon' ? ' active' : ''}`}
              onClick={() => setActiveTab('amazon')}
            >
              <span className="material-symbols-outlined">storefront</span>
              Amazon
            </button>
            <button
              type="button"
              className={`apple-settings-tab${activeTab === 'notifications' ? ' active' : ''}`}
              onClick={() => setActiveTab('notifications')}
            >
              <span className="material-symbols-outlined">notifications</span>
              Notifications
            </button>
            <button
              type="button"
              className={`apple-settings-tab${activeTab === 'security' ? ' active' : ''}`}
              onClick={() => setActiveTab('security')}
            >
              <span className="material-symbols-outlined">security</span>
              Security
            </button>
            <button
              type="button"
              className={`apple-settings-tab${activeTab === 'preferences' ? ' active' : ''}`}
              onClick={() => setActiveTab('preferences')}
            >
              <span className="material-symbols-outlined">tune</span>
              Preferences
            </button>
          </nav>

          {/* Right Panel */}
          <div className="apple-settings-panel">
            {activeTab === 'account' && (
              <form onSubmit={handleSave} className="apple-settings-list">
                <div className="apple-settings-section-head">
                  <h2 className="apple-settings-section-title">Account Profile</h2>
                  <p className="apple-settings-section-desc">
                    Your personal identification and store account details.
                  </p>
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Full Name</label>
                  <input
                    type="text"
                    className="apple-settings-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Email Address</label>
                  <input
                    type="email"
                    className="apple-settings-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <button type="submit" className="apple-btn-primary">
                    Save changes
                  </button>
                </div>
              </form>
            )}

            {activeTab === 'amazon' && (
              <form onSubmit={handleSave} className="apple-settings-list">
                <div className="apple-settings-section-head">
                  <h2 className="apple-settings-section-title">Amazon Central Connection</h2>
                  <p className="apple-settings-section-desc">
                    Amazon Selling Partner API (SP-API) marketplace and regional settings.
                  </p>
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Seller Central ID</label>
                  <input
                    type="text"
                    className="apple-settings-input"
                    value={user?.amazonSellerId || 'A321EXAMPLE'}
                    disabled
                  />
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Primary Marketplace</label>
                  <select
                    className="apple-select"
                    style={{ maxWidth: '400px' }}
                    value={marketplace}
                    onChange={(e) => setMarketplace(e.target.value)}
                  >
                    <option value="Amazon.com (US)">Amazon.com (United States)</option>
                    <option value="Amazon.ca (Canada)">Amazon.ca (Canada)</option>
                    <option value="Amazon.com.mx (Mexico)">Amazon.com.mx (Mexico)</option>
                  </select>
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <button type="submit" className="apple-btn-primary">
                    Save changes
                  </button>
                </div>
              </form>
            )}

            {activeTab === 'notifications' && (
              <div className="apple-settings-list">
                <div className="apple-settings-section-head">
                  <h2 className="apple-settings-section-title">Notification Rules</h2>
                  <p className="apple-settings-section-desc">
                    Configure real-time alerts for orders, inventory syncs, and system digests.
                  </p>
                </div>

                <div className="apple-toggle-row">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Real-time Order Alerts</div>
                    <div style={{ fontSize: '0.8rem', color: '#86868B' }}>
                      Notify instantly when new Amazon orders arrive.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={orderAlerts}
                    onChange={(e) => setOrderAlerts(e.target.checked)}
                    style={{ width: 18, height: 18, cursor: 'pointer' }}
                  />
                </div>

                <div className="apple-toggle-row">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Low Stock Inventory Warnings</div>
                    <div style={{ fontSize: '0.8rem', color: '#86868B' }}>
                      Alert when FBA fulfillable stock drops below 10 units.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={stockAlerts}
                    onChange={(e) => setStockAlerts(e.target.checked)}
                    style={{ width: 18, height: 18, cursor: 'pointer' }}
                  />
                </div>

                <div className="apple-toggle-row">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Daily Sales Digest</div>
                    <div style={{ fontSize: '0.8rem', color: '#86868B' }}>
                      Receive a daily summary email of total revenue and active listings.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={digestEmail}
                    onChange={(e) => setDigestEmail(e.target.checked)}
                    style={{ width: 18, height: 18, cursor: 'pointer' }}
                  />
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <form onSubmit={handleSave} className="apple-settings-list">
                <div className="apple-settings-section-head">
                  <h2 className="apple-settings-section-title">Security &amp; Authentication</h2>
                  <p className="apple-settings-section-desc">
                    Manage your account password and active session tokens.
                  </p>
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Current Password</label>
                  <input type="password" className="apple-settings-input" placeholder="••••••••" />
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">New Password</label>
                  <input type="password" className="apple-settings-input" placeholder="••••••••" />
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <button type="submit" className="apple-btn-primary">
                    Update Password
                  </button>
                </div>
              </form>
            )}

            {activeTab === 'preferences' && (
              <form onSubmit={handleSave} className="apple-settings-list">
                <div className="apple-settings-section-head">
                  <h2 className="apple-settings-section-title">Application Preferences</h2>
                  <p className="apple-settings-section-desc">
                    System timezone, date formats, and default views.
                  </p>
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Timezone</label>
                  <select className="apple-select" style={{ maxWidth: '400px' }}>
                    <option value="America/Los_Angeles">Pacific Time (US &amp; Canada)</option>
                    <option value="America/New_York">Eastern Time (US &amp; Canada)</option>
                    <option value="UTC">UTC (Universal Time)</option>
                  </select>
                </div>

                <div className="apple-settings-row">
                  <label className="apple-settings-label">Default Items per Page</label>
                  <select className="apple-select" style={{ maxWidth: '400px' }}>
                    <option value="25">25 items</option>
                    <option value="50">50 items</option>
                    <option value="100">100 items</option>
                  </select>
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <button type="submit" className="apple-btn-primary">
                    Save preferences
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
