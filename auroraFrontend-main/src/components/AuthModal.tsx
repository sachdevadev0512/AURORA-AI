import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import '../styles/auth.css';

interface AuthModalProps {
  onClose: () => void;
  onSuccess?: () => void;
}

export default function AuthModal({ onClose, onSuccess }: AuthModalProps) {
  const { login, register, error } = useAuth();

  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // 200ms smooth entrance animation
    const raf = requestAnimationFrame(() => {
      setIsVisible(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(onClose, 200);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError('');

    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await register(name || email.split('@')[0], email, password);
      }
      setIsVisible(false);
      setTimeout(() => {
        onClose();
        onSuccess?.();
      }, 150);
    } catch (err) {
      setFormError((err as Error).message || 'Authentication failed. Please check your credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`aurora-auth-modal-overlay ${isVisible ? 'visible' : ''}`}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`aurora-auth-modal-card ${isVisible ? 'visible' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="aurora-auth-modal-close"
          onClick={handleClose}
          type="button"
          aria-label="Close modal"
        >
          ×
        </button>

        <div className="aurora-auth-header">
          <div className="aurora-auth-badge">A</div>
          <h2 className="aurora-auth-title">
            {isLogin ? 'Sign in to Aurora AI' : 'Create Seller Account'}
          </h2>
          <p className="aurora-auth-subtitle">
            {isLogin
              ? 'Access real-time analytics, inventory intelligence, and catalog tools.'
              : 'Connect Amazon SP-API and manage your seller workspace.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="aurora-auth-form">
          {!isLogin && (
            <div className="aurora-auth-field">
              <label className="aurora-auth-label">Full Name</label>
              <input
                className="aurora-auth-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                required={!isLogin}
                autoComplete="name"
              />
            </div>
          )}

          <div className="aurora-auth-field">
            <label className="aurora-auth-label">Email Address</label>
            <input
              className="aurora-auth-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seller@company.com"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="aurora-auth-field">
            <label className="aurora-auth-label">Password</label>
            <input
              className="aurora-auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete={isLogin ? 'current-password' : 'new-password'}
            />
          </div>

          {(formError || error) && (
            <div className="aurora-auth-alert">
              {formError || error}
            </div>
          )}

          <button
            className="aurora-auth-submit-btn"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? (isLogin ? 'Signing in…' : 'Creating account…')
              : (isLogin ? 'Sign In' : 'Create Account')}
          </button>
        </form>

        <div className="aurora-auth-toggle-row">
          <span>{isLogin ? "Don't have an account?" : 'Already have an account?'}</span>
          <button
            type="button"
            className="aurora-auth-toggle-btn"
            onClick={() => {
              setIsLogin(!isLogin);
              setFormError('');
            }}
          >
            {isLogin ? 'Sign up' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
