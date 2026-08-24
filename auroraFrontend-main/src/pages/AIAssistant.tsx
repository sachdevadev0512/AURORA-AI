import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import '../styles/dashboard.css';

const AI_BASE_URL = (import.meta.env.VITE_AI_URL || 'http://localhost:8000').replace(/\/$/, '');

export default function AIAssistant() {
  const { token, user } = useAuth();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [frameError, setFrameError] = useState(false);

  const iframeSrc = useMemo(() => {
    if (!token) return '';
    const params = new URLSearchParams({
      token,
      embedded: '1',
    });
    if (user?.email) params.set('email', user.email);
    return `${AI_BASE_URL}/?${params.toString()}`;
  }, [token, user?.email, reloadKey]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'aurora-ai-logout') {
        setFrameError(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="apple-dashboard">
      <div className="apple-dashboard-container" style={{ paddingBottom: '1rem' }}>
        {/* Header */}
        <header className="apple-dashboard-header">
          <div>
            <h1 className="apple-dashboard-title">AI Assistant</h1>
            <p className="apple-dashboard-subtitle">
              Ask intelligence questions about campaigns, orders, inventory velocity, profit margins, or restock alerts.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={() => {
                setFrameError(false);
                setReloadKey((v) => v + 1);
              }}
            >
              <span className="material-symbols-outlined">refresh</span>
              Reload Engine
            </button>
          </div>
        </header>

        {frameError && (
          <div className="apple-alert">
            Session ended. Click Reload, or sign in to Aurora again.
          </div>
        )}

        {/* Embedded AI Service Shell */}
        <div
          className="apple-card"
          style={{
            padding: 0,
            height: 'calc(100vh - 230px)',
            minHeight: '540px',
            overflow: 'hidden',
          }}
        >
          {iframeSrc ? (
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              title="Aurora AI Assistant"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
              }}
            />
          ) : (
            <div className="apple-empty-state">
              <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.5 }}>
                smart_toy
              </span>
              <h3 className="apple-empty-heading">Authentication required</h3>
              <p className="apple-empty-text">Please log in to access the AI Assistant engine.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
