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
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [displayLocation, setDisplayLocation] = useState(location);
  const [transitionStage, setTransitionStage] = useState<'fadeIn' | 'fadeOut'>('fadeIn');

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
    <div style={{ background: isHomePage ? '#f9f9ff' : '#f9f9ff', minHeight: '100vh' }}>
      {/* Navbar is ONLY shown on Protected App Pages, NOT on Home Page */}
      {!isHomePage && (
        <nav
          className="navbar"
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            background: 'rgba(255, 255, 255, 0.85)',
            borderBottom: '1px solid #c1c6d6',
            color: '#181c23',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
            transition: 'background 0.3s ease, border-color 0.3s ease',
            padding: '0.65rem 1.5rem',
          }}
        >
          <div
            style={{
              maxWidth: 1440,
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
            }}
          >
            {/* Logo / Brand */}
            <Link
              to="/dashboard"
              style={{
                color: 'inherit',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: '1rem',
                letterSpacing: '-0.01em',
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  background: '#0059b5',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 700,
                }}
              >
                A
              </span>
              <span>Aurora Seller Dashboard</span>
            </Link>

            {/* Nav Links containing ALL app pages */}
            <div
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
                    style={{
                      fontSize: '0.82rem',
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? '#0059b5' : '#5e5e63',
                      padding: '0.35rem 0.65rem',
                      borderRadius: '6px',
                      background: isActive ? 'rgba(0, 89, 181, 0.08)' : 'transparent',
                      transition: 'all 0.15s ease',
                      textDecoration: 'none',
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
              <button
                type="button"
                onClick={handleLogout}
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid #c1c6d6',
                  background: '#e6e8f2',
                  color: '#181c23',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                Logout
              </button>
            </div>
          </div>
        </nav>
      )}

      <main key={displayLocation.pathname} className={`page-transition-container ${transitionStage}`}>
        {children}
      </main>
    </div>
  );
}