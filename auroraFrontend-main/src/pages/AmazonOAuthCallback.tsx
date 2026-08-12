import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handleAmazonCallback } from '../api';

export default function AmazonOAuthCallback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const processCallback = async () => {
      try {
        const code = searchParams.get('code');
        const state = searchParams.get('state');
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');

        // Handle OAuth errors from Amazon
        if (error) {
          setStatus('error');
          setMessage(errorDescription || error);
          setTimeout(() => navigate('/integration'), 3000);
          return;
        }

        // Validate required parameters
        if (!code || !state) {
          setStatus('error');
          setMessage('Missing authorization code or state parameter');
          setTimeout(() => navigate('/integration'), 3000);
          return;
        }

        // Exchange code for token (this happens on the backend)        npm start
        // The backend will redirect us back with success/error
        setMessage('Connecting your Amazon account...');

        // In a real implementation, you might want to call an API here
        // But since the backend handles the callback directly, we just show success
        setStatus('success');
        setMessage('Amazon account connected successfully!');

        // Redirect to integration page after success
        setTimeout(() => navigate('/integration'), 2000);

      } catch (err) {
        setStatus('error');
        setMessage((err as Error).message);
        setTimeout(() => navigate('/integration'), 3000);
      }
    };

    processCallback();
  }, [searchParams, navigate]);

  return (
    <div className="container" style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ maxWidth: '500px', textAlign: 'center' }}>
        {status === 'loading' && (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⏳</div>
            <h2>Connecting Amazon Account</h2>
            <p>Please wait while we connect your Amazon Seller account...</p>
            <div className="loading-spinner" style={{ margin: '2rem auto' }}></div>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
            <h2>Success!</h2>
            <p>{message}</p>
            <p style={{ color: '#666', fontSize: '0.9rem', marginTop: '1rem' }}>
              Redirecting you back to the integration page...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>❌</div>
            <h2>Connection Failed</h2>
            <p>{message}</p>
            <p style={{ color: '#666', fontSize: '0.9rem', marginTop: '1rem' }}>
              Redirecting you back to try again...
            </p>
          </>
        )}
      </div>
    </div>
  );
}