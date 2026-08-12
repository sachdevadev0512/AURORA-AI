import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Spline from '@splinetool/react-spline';
import '../styles/commandDeck.css';

interface HomeProps {
  sceneUrl?: string;
}

export default function Home({
  sceneUrl = 'https://prod.spline.design/wDKFjJRPsbtdtuyM/scene.splinecode',
}: HomeProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleEnterDashboard = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);

    // 450ms crossfade & slight zoom-out transition (scale 1 -> 0.96, opacity 1 -> 0)
    setTimeout(() => {
      navigate('/dashboard');
    }, 450);
  };

  return (
    <div className={`command-deck-stage ${isTransitioning ? 'transition-exit' : ''}`}>
      <div className="grid-overlay" />

      {/* 3D Spline Canvas */}
      <div className="spline-container">
        <Spline
          scene={sceneUrl}
          onLoad={() => setIsLoading(false)}
          style={{ width: '100%', height: '100%' }}
        />
      </div>

      {/* Loading Indicator */}
      {isLoading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(249, 249, 255, 0.9)',
            backdropFilter: 'blur(10px)',
            color: '#5e5e63',
            fontFamily: "'Inter', sans-serif",
            fontSize: '0.95rem',
            fontWeight: 500,
          }}
        >
          <span>Initializing 3D Experience...</span>
        </div>
      )}

      {/* Hero Content with "Enter User Dashboard" Button */}
      <div className="hero-content-center">
        <h1 className="hero-title">AURORA AI</h1>
        <p className="hero-subtitle">Autonomous Seller Intelligence Platform</p>

        <button
          type="button"
          className="btn-enter-dashboard"
          onClick={handleEnterDashboard}
          disabled={isTransitioning}
        >
          {isTransitioning ? (
            <>
              <span className="material-symbols-outlined spinner-icon" style={{ fontSize: '20px' }}>
                sync
              </span>
              <span>Opening Workspace...</span>
            </>
          ) : (
            <>
              <span>Enter User Dashboard</span>
              <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
                arrow_forward
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
