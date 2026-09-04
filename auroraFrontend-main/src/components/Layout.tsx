import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

interface LayoutProps {
  children: React.ReactNode;
}

const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/products', label: 'Products' },
  { path: '/orders', label: 'Orders' },
  { path: '/shipments', label: 'Shipments' },
  { path: '/ads', label: 'Ads' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/repricer', label: 'Repricer' },
  { path: '/ai', label: 'AI Assistant' },
  { path: '/integration', label: 'Integration' },
  { path: '/settings', label: 'Settings' },
];

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isLandingArrival, setIsLandingArrival] = useState(() => Boolean((location.state as any)?.fromLanding));

  const [displayLocation, setDisplayLocation] = useState(location);
  const [transitionStage, setTransitionStage] = useState<'fadeIn' | 'fadeOut'>('fadeIn');

  useEffect(() => {
    if (isLandingArrival) {
      const timer = setTimeout(() => {
        setIsLandingArrival(false);
      }, 900);
      return () => clearTimeout(timer);
    }
  }, [isLandingArrival]);

  useEffect(() => {
    if (location.pathname !== displayLocation.pathname) {
      setTransitionStage('fadeOut');
      const timer = setTimeout(() => {
        setDisplayLocation(location);
        setTransitionStage('fadeIn');
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      }, 180);
      return () => clearTimeout(timer);
    }
  }, [location, displayLocation]);

  const isHomePage = location.pathname === '/';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div style={{ background: 'transparent', minHeight: '100vh' }}>
      {/* Navbar is ONLY shown on Protected App Pages, NOT on Home Page */}
      {!isHomePage && (
        <header
          className={`navbar-sticky-wrapper ${isLandingArrival ? 'landing-arrival' : ''}`}
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 100,
            width: '100%',
            padding: '0.65rem 1rem 0.65rem',
            background: 'transparent',
          }}
        >
          <nav
            className="navbar"
            style={{
              maxWidth: '1280px',
              margin: '0 auto',
            }}
          >
            <div
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
              }}
            >
              {/* Nav Links containing ALL app pages */}
              <div
                className="navbar-links"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  overflowX: 'auto',
                  msOverflowStyle: 'none',
                  scrollbarWidth: 'none',
                }}
              >
                {NAV_LINKS.map((link) => {
                  const isActive = location.pathname.startsWith(link.path);

                  return (
                    <Link
                      key={link.path}
                      to={link.path}
                      className={isActive ? 'active' : ''}
                      style={{
                        fontSize: '0.88rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </div>

              {/* Right Section */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                <NotificationBell />
                {user ? (
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="apple-btn-secondary"
                  >
                    Logout
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate('/login')}
                    className="apple-btn-secondary"
                  >
                    Login / Sign Up
                  </button>
                )}
              </div>
            </div>
          </nav>
        </header>
      )}

      <main key={displayLocation.pathname} className={`page-transition-container ${transitionStage} ${isLandingArrival ? 'landing-arrival' : ''}`}>
        {children}
      </main>
    </div>
  );
}