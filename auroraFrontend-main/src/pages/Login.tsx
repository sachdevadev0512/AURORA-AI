import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../styles/auth.css';

export default function Login() {
  const { login, error } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError('');

    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="apple-auth-page">
      <div className="apple-auth-card">
        <div className="apple-auth-logo">
          <div className="apple-auth-logo-box">A</div>
          <span style={{ fontSize: '1.2rem', fontWeight: 600 }}>Aurora AI</span>
        </div>

        <div>
          <h1 className="apple-auth-title">Sign in to your store</h1>
          <p className="apple-auth-sub">Access seller analytics and Amazon SP-API data.</p>
        </div>

        <form onSubmit={handleSubmit} className="apple-auth-form">
          <div className="apple-auth-field">
            <label className="apple-auth-label">Email Address</label>
            <input
              className="apple-auth-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              required
            />
          </div>

          <div className="apple-auth-field">
            <label className="apple-auth-label">Password</label>
            <input
              className="apple-auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {(formError || error) && <div className="apple-alert">{formError || error}</div>}

          <button
            className="apple-btn-primary"
            type="submit"
            disabled={submitting}
            style={{ width: '100%', justifyContent: 'center', padding: '0.65rem', marginTop: '0.5rem' }}
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="apple-auth-footer">
          New to Aurora? <Link to="/register">Create an account</Link>
        </div>
      </div>
    </div>
  );
}
