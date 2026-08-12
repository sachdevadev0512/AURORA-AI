import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="splash">
      <div className="card auth-panel">
        <h1>Page not found</h1>
        <p>The page you tried to access does not exist.</p>
        <Link className="btn" to="/dashboard">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
