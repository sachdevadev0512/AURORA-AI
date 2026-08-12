import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../styles/auth.css';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError('');

    try {
      await register(name, email, password);
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
          <h1 className="apple-auth-title">Create your seller account</h1>
          <p className="apple-auth-sub">Connect Amazon SP-API and manage your catalog.</p>
        </div>

        <form onSubmit={handleSubmit} className="apple-auth-form">
          <div className="apple-auth-field">
            <label className="apple-auth-label">Full Name</label>
            <input
              className="apple-auth-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              required
            />
          </div>

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

          {formError && <div className="apple-alert">{formError}</div>}

          <button
            className="apple-btn-primary"
            type="submit"
            disabled={submitting}
            style={{ width: '100%', justifyContent: 'center', padding: '0.65rem', marginTop: '0.5rem' }}
          >
            {submitting ? 'Creating account…' : 'Register'}
          </button>
        </form>

        <div className="apple-auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
