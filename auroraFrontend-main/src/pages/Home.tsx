import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import '../styles/HomeAurora.css';

/* ═══════════════════════════════════════════════════════════════
   Props interface
   ═══════════════════════════════════════════════════════════════ */
interface HomeProps {
  isTransitionActive?: boolean;
  onStartTransition?: () => void;
  onTransitionComplete?: () => void;
}

export default function Home({ isTransitionActive, onStartTransition, onTransitionComplete }: HomeProps) {
  const navigate = useNavigate();
  const [isTransitioning, setIsTransitioning] = useState(Boolean(isTransitionActive));
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const landingRef = useRef<HTMLDivElement>(null);
  const flutedArtRef = useRef<HTMLDivElement>(null);
  const showcaseStageRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLElement>(null);
  const [isAboutInView, setIsAboutInView] = useState(false);
  const navigatedRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  /* ─── Trigger Text Animation when Scrolled to About Section ─── */
  useEffect(() => {
    const el = aboutRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsAboutInView(true);
        }
      },
      { threshold: 0.18 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ─── Show Toast Notification ─── */
  const triggerToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2400);
  }, []);

  /* ─── Seamless 1-Way Transition into Dashboard ─── */
  const completeOneWayEntrance = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    setIsTransitioning(true);
    triggerToast('Entering Aurora Seller Dashboard...');
    onStartTransition?.();

    const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (isReduced) {
      navigate('/dashboard', { replace: true, state: { fromLanding: true } });
      setTimeout(() => onTransitionComplete?.(), 50);
      return;
    }

    // Play ultra-smooth cinematic exit animation matching the fluted aurora theme
    const exitTl = gsap.timeline({
      onComplete: () => {
        navigate('/dashboard', { replace: true, state: { fromLanding: true } });
        setTimeout(() => onTransitionComplete?.(), 300);
      },
    });

    exitTl
      .to('.landing-hero', {
        y: -90,
        opacity: 0,
        duration: 0.5,
        ease: 'power3.inOut',
      }, 0)
      .to('.showcase-stage', {
        y: 60,
        opacity: 0,
        duration: 0.45,
        ease: 'power2.inOut',
      }, 0)
      .to('.fluted-art-stage', {
        opacity: 0.2,
        duration: 0.6,
        ease: 'power2.inOut',
      }, 0)
      .to('.theme-morph-overlay', {
        opacity: 1,
        duration: 0.55,
        ease: 'power2.inOut',
      }, 0.05)
      .to('.transition-veil', {
        opacity: 1,
        duration: 0.45,
        ease: 'power2.inOut',
      }, 0.1);
  }, [navigate, onStartTransition, onTransitionComplete, triggerToast]);

  /* ─── GSAP Entrance & Scroll Choreography ─── */
  useEffect(() => {
    const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (isReduced) {
      return;
    }

    const ctx = gsap.context(() => {
      /* ── 5-Step Sequential Entrance Animation Timeline ── */
      const entranceTl = gsap.timeline();

      // Step 1: First, when the site is loaded or refreshed, the background image fades in
      entranceTl.fromTo(
        flutedArtRef.current,
        { opacity: 0 },
        {
          opacity: 1,
          duration: 0.8,
          ease: 'power2.out',
        }
      );

      // Step 2: After background is loaded in, the brand logo and all-caps header fade in
      entranceTl.fromTo(
        '.hero-logo-wrapper',
        {
          opacity: 0,
          y: 12,
          scale: 0.92,
          filter: 'blur(10px)',
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 0.45,
          ease: 'power3.out',
        },
        '+=0.03'
      );

      entranceTl.fromTo(
        '.hero-letter',
        {
          opacity: 0,
          y: 7,
          filter: 'blur(10px)',
        },
        {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          duration: 0.32,
          stagger: 0.024,
          ease: 'power2.out',
        },
        '-=0.22'
      );

      // Step 3: After the header loads in, the description fades in line by line
      entranceTl.fromTo(
        '.desc-line',
        {
          opacity: 0,
          y: 10,
          filter: 'blur(7px)',
        },
        {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          duration: 0.46,
          stagger: 0.11,
          ease: 'power3.out',
        },
        '+=0.04'
      );

      // Step 4: After that, the button fades in
      entranceTl.fromTo(
        '.zensman-cta-btn',
        {
          opacity: 0,
          y: 12,
          scale: 0.98,
          filter: 'blur(5px)',
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 0.40,
          ease: 'power3.out',
        },
        '+=0.05'
      );

      // Step 5: Cards fade in sequentially
      // 5a. First the middle card fades in as a solid blank card (hide inner info initially)
      entranceTl.set(
        '.showcase-center-header, .showcase-inner-card',
        { opacity: 0 }
      );
      entranceTl.fromTo(
        '.showcase-center-anchor',
        {
          opacity: 0,
          y: 32,
          scale: 0.96,
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.76,
          ease: 'power3.out',
        },
        '+=0.12'
      );

      // 5b. And then all the information in the middle card loads in
      entranceTl.fromTo(
        '.showcase-center-header, .showcase-inner-card',
        {
          opacity: 0,
          y: 10,
          filter: 'blur(5px)',
        },
        {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          duration: 0.55,
          stagger: 0.12,
          ease: 'power3.out',
        },
        '+=0.12'
      );

      // 5c. And then lines connecting other 2 cards appear from the main card connecting them
      entranceTl.fromTo(
        '.showcase-circuit-svg',
        { opacity: 0 },
        { opacity: 1, duration: 0.25, ease: 'power2.out' },
        '+=0.08'
      );
      entranceTl.fromTo(
        '.circuit-path-line',
        { strokeDashoffset: 160 },
        {
          strokeDashoffset: 0,
          duration: 0.65,
          ease: 'power2.out',
        },
        '<'
      );

      // 5d. Then both side cards appear first as blank cards (hide inner info initially)
      entranceTl.set(
        '.showcase-satellite-card .satellite-label, .showcase-satellite-card .satellite-value-row',
        { opacity: 0 }
      );
      entranceTl.fromTo(
        '.showcase-satellite-left-anchor, .showcase-satellite-right-anchor',
        {
          opacity: 0,
          y: 18,
          scale: 0.96,
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.62,
          stagger: 0.10,
          ease: 'power3.out',
        },
        '-=0.08'
      );

      // 5e. Followed by the information in both side cards
      entranceTl.fromTo(
        '.showcase-satellite-card .satellite-label, .showcase-satellite-card .satellite-value-row',
        {
          opacity: 0,
          y: 6,
          filter: 'blur(3px)',
        },
        {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          duration: 0.50,
          stagger: 0.08,
          ease: 'power3.out',
        },
        '+=0.08'
      );
    }, landingRef);

    return () => {
      ctx.revert();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  return (
    <div
      ref={landingRef}
      className={`aurora-landing ${isTransitioning ? 'transitioning' : ''}`}
    >
      {/* ── Fluted Aurora Columns (Fixed background across whole landing page) ── */}
      <div className="fluted-art-stage" ref={flutedArtRef}>
        <div className="fluted-art-base" />
        <div className="fluted-art-swapped" />
      </div>

      {/* ── Theme morph overlay for scroll-into-dashboard transition ── */}
      <div className="theme-morph-overlay" />

      {/* ── Hero Fold (100vh) ── */}
      <div className="landing-pin-container">
        {/* ── Landing Content Layout ── */}
        <div className="landing-content">
          {/* Hero Section */}
          <section className="landing-hero" ref={heroRef}>
            {/* Brand Emblem Logo */}
            <div className="hero-logo-wrapper">
              <img
                src="/aurora-logo.png"
                alt="Aurora AI Logo"
                className="hero-logo-img"
              />
            </div>

            <h1 className="zensman-hero-title">
              <span className="hero-line-mask" aria-label="Aurora AI">
                <span className="hero-line-inner">
                  {Array.from("Aurora AI").map((char, index) => (
                    <span
                      key={`char-${index}`}
                      className="hero-letter"
                      aria-hidden="true"
                    >
                      {char === ' ' ? '\u00A0' : char}
                    </span>
                  ))}
                </span>
              </span>
            </h1>

            <p className="zensman-hero-subtitle">
              <span className="desc-line">Step into a platform built to transform how you run</span>
              <span className="desc-line">Amazon operations, catalog intelligence, and the</span>
              <span className="desc-line">broader e-commerce ecosystem.</span>
            </p>

            <button
              type="button"
              className="zensman-cta-btn"
              onClick={completeOneWayEntrance}
              aria-label="Enter user dashboard"
            >
              <span>Enter user dashboard</span>
              <span className="zensman-cta-arrow">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <polyline points="13 5 20 12 13 19" />
                </svg>
              </span>
            </button>
          </section>

          {/* Bottom Showcase Interface (Pixel-matched to design reference) */}
          <section className="showcase-stage" ref={showcaseStageRef}>
            {/* Left curved circuit connection */}
            <svg
              className="showcase-circuit-svg showcase-circuit-left-svg"
              viewBox="0 0 110 55"
              fill="none"
              aria-hidden="true"
            >
              <path
                className="circuit-path-line circuit-path-left"
                d="M 110,1 L 20,1 A 18,18 0 0,0 2,19 L 2,55"
                stroke="url(#circuitGradientLeft)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <defs>
                <linearGradient id="circuitGradientLeft" x1="110" y1="1" x2="2" y2="55" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="rgba(81, 244, 233, 0.9)" />
                  <stop offset="100%" stopColor="rgba(56, 189, 248, 0.6)" />
                </linearGradient>
              </defs>
            </svg>

            {/* Left Satellite Card Anchor */}
            <div className="showcase-satellite-left-anchor">
              <div className="showcase-satellite-card showcase-satellite-left">
                <div className="satellite-label">
                  <span className="satellite-dot-green" />
                  <span>Total Orders</span>
                </div>
                <div className="satellite-value-row">
                  <span className="satellite-amount">1,248</span>
                  <span className="satellite-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                      <line x1="3" y1="6" x2="21" y2="6"/>
                      <path d="M16 10a4 4 0 0 1-8 0"/>
                    </svg>
                  </span>
                </div>
              </div>
            </div>

            {/* Center Revenue Card Anchor */}
            <div className="showcase-center-anchor">
              <div className="showcase-center-card">
                <div className="showcase-center-header">
                  <span className="showcase-center-title">Revenue Performance</span>
                  <div className="showcase-center-controls">
                    <span className="showcase-badge-pill">Last 30 days</span>
                  </div>
                </div>

                <div className="showcase-inner-card">
                  <div className="showcase-inner-left">
                    <div className="showcase-balance-label">
                      <span>Total Revenue</span>
                      <span className="showcase-growth-pill">+12.4%</span>
                    </div>
                    <div className="showcase-balance-amount">$45,290.50</div>
                  </div>

                  <div className="showcase-mini-gradient-card">
                    <div className="mini-card-top">
                      <span className="mini-card-label">Avg. Order</span>
                      <span className="mini-card-chip">⚙</span>
                    </div>
                    <div className="mini-card-bottom">
                      <span className="mini-card-val">$36.29</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right curved circuit connection */}
            <svg
              className="showcase-circuit-svg showcase-circuit-right-svg"
              viewBox="0 0 110 55"
              fill="none"
              aria-hidden="true"
            >
              <path
                className="circuit-path-line circuit-path-right"
                d="M 0,1 L 90,1 A 18,18 0 0,1 108,19 L 108,55"
                stroke="url(#circuitGradientRight)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <defs>
                <linearGradient id="circuitGradientRight" x1="0" y1="1" x2="108" y2="55" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="rgba(81, 244, 233, 0.9)" />
                  <stop offset="100%" stopColor="rgba(56, 189, 248, 0.6)" />
                </linearGradient>
              </defs>
            </svg>

            {/* Right Satellite Card Anchor */}
            <div className="showcase-satellite-right-anchor">
              <div className="showcase-satellite-card showcase-satellite-right">
                <div className="satellite-label">
                  <span className="satellite-dot-blue" />
                  <span>Active Products</span>
                </div>
                <div className="satellite-value-row">
                  <span className="satellite-amount">142</span>
                  <span className="satellite-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                      <line x1="12" y1="22.08" x2="12" y2="12"/>
                    </svg>
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* ── About Aurora AI Section (Second Page Fold) ── */}
      <section
        className={`about-section ${isAboutInView ? 'is-in-view' : ''}`}
        id="about"
        ref={aboutRef}
      >
        <div className="about-content">
          <h2 className="about-headline">About Aurora AI</h2>

          <div className="about-body">
            <p className="about-lead-text">
              Everything you need to manage and grow your Amazon business.
            </p>

            <p className="about-body-text">
              Aurora AI streamlines repricing, inventory, advertising, and order management with real-time insights and intelligent automation, helping you operate efficiently and drive sustainable growth.
            </p>
          </div>

          <div className="about-action-row">
            <button
              type="button"
              className="zensman-cta-btn"
              onClick={completeOneWayEntrance}
              aria-label="Enter user dashboard"
            >
              <span>Enter user dashboard</span>
              <span className="zensman-cta-arrow">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <polyline points="13 5 20 12 13 19" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* ── Toast Feedback Notification ── */}
      <div
        className={`toast ${toastMessage ? 'is-visible' : ''}`}
        role="status"
        aria-live="polite"
      >
        {toastMessage}
      </div>

      {/* ── Transition veil ── */}
      <div className="transition-veil" />
    </div>
  );
}
