import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import '../styles/HomeAurora.css';
import { useAuth } from '../context/AuthContext';
import AuthModal from '../components/AuthModal';

/* ═══════════════════════════════════════════════════════
   Seeded PRNG — consistent particles on every refresh
═══════════════════════════════════════════════════════ */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HomeProps {
  isTransitionActive?: boolean;
  onStartTransition?: () => void;
  onTransitionComplete?: () => void;
}

export default function Home({ isTransitionActive, onStartTransition, onTransitionComplete }: HomeProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(Boolean(isTransitionActive));
  const [fadeOutHandoff, setFadeOutHandoff] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Transition controller ref inside Three.js animation loop for locked 60/120fps performance
  const transitionRef = useRef<{
    active: boolean;
    startTime: number;
    reducedMotion: boolean;
  }>({
    active: Boolean(isTransitionActive),
    startTime: isTransitionActive ? performance.now() : 0,
    reducedMotion: false,
  });

  const startTransition = useCallback(() => {
    if (transitionRef.current.active) return;
    setIsTransitioning(true);
    setIsAuthModalOpen(false);
    onStartTransition?.();

    const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    transitionRef.current = {
      active: true,
      startTime: performance.now(),
      reducedMotion: isReduced,
    };

    if (isReduced) {
      navigate('/dashboard');
      setTimeout(() => {
        onTransitionComplete?.();
      }, 200);
      return;
    }

    // ═══════════════════════════════════════════════════════
    // ATMOSPHERIC TRANSITION BRIDGE:
    // 0ms - 80ms: Subtle CTA response & text fade
    // 100ms - 750ms: Gentle Aurora drift & camera glide forward
    // 220ms - 850ms: Atmospheric veil & luminous center bloom into #e8edf5
    // 500ms: Route pre-load to /dashboard in background
    // 900ms: Overlay dissolves smoothly over 200ms
    // 1100ms: Transition complete
    // ═══════════════════════════════════════════════════════
    setTimeout(() => {
      navigate('/dashboard');
    }, 500);

    setTimeout(() => {
      setFadeOutHandoff(true);
    }, 900);

    setTimeout(() => {
      onTransitionComplete?.();
    }, 1100);
  }, [navigate, onStartTransition, onTransitionComplete]);

  useEffect(() => {
    if (!containerRef.current) return;

    const rng = mulberry32(42);

    /* ═══════════════════════════════════════════════════════
       Config
    ═══════════════════════════════════════════════════════ */
    const COUNT = 52000;
    const SPEED_MULT = 0.82;
    const AUTO_SPIN = true;

    const GLOBE_RADIUS = 36;
    const GLOBE_HOLD = 1.2;
    const SCATTER_DUR = 2.2;

    const pointer = new THREE.Vector2(9999, 9999);
    const pointerWorld = new THREE.Vector3();
    const pointerRay = new THREE.Raycaster();
    const repulsion = { radius: 18, strength: 10 };

    const bgStartColor = new THREE.Color(0x0a1628);
    const bgEndColor = new THREE.Color(0xe8edf5);
    const fogStartColor = new THREE.Color(0x0d2240);

    const scene = new THREE.Scene();
    scene.background = bgStartColor.clone();
    scene.fog = new THREE.FogExp2(0x0d2240, 0.0035);

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 2400);
    camera.position.set(0, 18, 110);
    camera.lookAt(0, 18, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    containerRef.current.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.035;
    controls.enableRotate = false;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.target.set(0, 18, 0);
    controls.autoRotate = AUTO_SPIN;
    controls.autoRotateSpeed = 0.045;
    controls.minDistance = 55;
    controls.maxDistance = 210;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.65, 0.85, 0.06);
    bloom.strength = 1.65;
    bloom.radius = 0.85;
    bloom.threshold = 0.06;
    composer.addPass(bloom);

    // Stars
    const starCount = 1800;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 320 + rng() * 480;
      const theta = rng() * Math.PI * 2;
      starPositions[i * 3] = Math.cos(theta) * r;
      starPositions[i * 3 + 1] = 28 + rng() * 360;
      starPositions[i * 3 + 2] = Math.sin(theta) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xdff7ff,
      size: 0.8,
      transparent: true,
      opacity: 0.72,
      sizeAttenuation: true
    });
    scene.add(new THREE.Points(starGeo, starMaterial));

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const target = new THREE.Vector3();
    const geometry = new THREE.SphereGeometry(0.16, 5, 4);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.84,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const aurora = new THREE.InstancedMesh(geometry, material, COUNT);
    aurora.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    aurora.frustumCulled = false;
    scene.add(aurora);

    /* ═══════════════════════════════════════════════════════
       Aurora Curtain Config (seeded)
    ═══════════════════════════════════════════════════════ */
    const PARAMS = {
      auroraWidth: 380,
      auroraHeight: 200,
      waveAmplitude: 22,
      flowSpeed: 0.19,
      depth: 90,
      intensity: 2.9,
      waveVariation: 1.2
    };
    const NUM_CURTAINS = 11;
    const curtains: any[] = [];
    for (let c = 0; c < NUM_CURTAINS; c++) {
      curtains.push({
        xOffset: ((c / (NUM_CURTAINS - 1) - 0.5) * PARAMS.auroraWidth * 0.98) + (rng() - 0.5) * 9,
        width: PARAMS.auroraWidth * (0.3 + rng() * 0.24),
        heightBase: PARAMS.auroraHeight * (0.78 + rng() * 0.42),
        depthBase: (rng() - 0.5) * PARAMS.depth * 1.7,
        depthVariance: 6 + rng() * 8,
        freqA: 0.017 + rng() * 0.023,
        freqB: 0.045 + rng() * 0.045,
        ampA: PARAMS.waveAmplitude * (0.68 + rng() * 0.62),
        ampB: PARAMS.waveAmplitude * (0.24 + rng() * 0.38),
        speedA: 0.1 + rng() * 0.08,
        speedB: 0.23 + rng() * 0.15,
        phase: rng() * Math.PI * 2,
        hueBase: 0.4 + rng() * 0.16,
        brightnessMult: 0.75 + rng() * 0.52
      });
    }

    /* ═══════════════════════════════════════════════════════
       Globe — Fibonacci sphere (seeded radius jitter)
    ═══════════════════════════════════════════════════════ */
    const globePos: THREE.Vector3[] = new Array(COUNT);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < COUNT; i++) {
      const t = i / (COUNT - 1);
      const inc = Math.acos(1 - 2 * t);
      const az = golden * i;
      const r = GLOBE_RADIUS * (0.95 + rng() * 0.1);
      globePos[i] = new THREE.Vector3(
        r * Math.sin(inc) * Math.cos(az),
        r * Math.cos(inc) + 18,
        r * Math.sin(inc) * Math.sin(az)
      );
    }

    /* ═══════════════════════════════════════════════════════
       Particle Init (seeded)
    ═══════════════════════════════════════════════════════ */
    const positions = Array.from({ length: COUNT }, (_, i) => globePos[i].clone());
    const curtainIndex = new Int16Array(COUNT);
    const uArr = new Float32Array(COUNT);
    const vArr = new Float32Array(COUNT);
    const jitterPhase = new Float32Array(COUNT);
    const scaleVar = new Float32Array(COUNT);
    const edgeBias = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      curtainIndex[i] = i % NUM_CURTAINS;
      uArr[i] = rng() * 2 - 1;
      vArr[i] = Math.pow(rng(), 0.58);
      jitterPhase[i] = rng() * Math.PI * 2;
      scaleVar[i] = 0.48 + rng() * 1.05;
      edgeBias[i] = Math.abs(uArr[i]);
      aurora.setColorAt(i, new THREE.Color(0x8ed7ff));
    }

    /* ═══════════════════════════════════════════════════════
       Animation
    ═══════════════════════════════════════════════════════ */
    const clock = new THREE.Clock();
    let cameraLocked = false;

    const camStart = new THREE.Vector3(0, 18, 110);
    const camEnd = new THREE.Vector3(28, 8, 136);

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    };
    const onPointerLeave = () => pointer.set(9999, 9999);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    function easeInOutCubic(t: number) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    let animationId: number;
    function animate() {
      animationId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      const time = elapsed * SPEED_MULT;
      const now = performance.now();

      const transState = transitionRef.current;
      const isTrans = transState.active;
      const transElapsed = isTrans ? (now - transState.startTime) : -1;

      // ═══════════════════════════════════════════════════════
      // PHASE 4 — COLOR BRIDGE INTERPOLATION (250ms -> 850ms)
      // ═══════════════════════════════════════════════════════
      if (isTrans && transElapsed >= 250) {
        const bgProgress = Math.min(1.0, (transElapsed - 250) / 600);
        // Smooth interpolation: #010b13 -> dark navy -> cool blue-gray -> #e8edf5
        const easeBg = bgProgress * bgProgress * (3.0 - 2.0 * bgProgress);
        scene.background.lerpColors(bgStartColor, bgEndColor, easeBg);
        if (scene.fog) {
          scene.fog.color.lerpColors(fogStartColor, bgEndColor, easeBg);
          (scene.fog as THREE.FogExp2).density = THREE.MathUtils.lerp(0.0038, 0.0001, easeBg);
        }
      } else if (!isTrans) {
        scene.background.copy(bgStartColor);
      }

      // Stars fade out cleanly into the morning veil (80ms -> 550ms)
      if (isTrans && transElapsed >= 80) {
        const starFade = Math.max(0.0, 1.0 - (transElapsed - 80) / 470);
        starMaterial.opacity = 0.68 * starFade;
      }

      // Bloom glow gently relaxes into workspace (250ms -> 700ms)
      if (isTrans && transElapsed >= 250) {
        const bloomFade = Math.max(0.0, 1.0 - (transElapsed - 250) / 450);
        bloom.strength = 1.85 * bloomFade;
      }

      // Camera forward glide creates natural 3D depth into the light
      if (isTrans && transElapsed >= 80) {
        const camGlideT = Math.min(1.0, (transElapsed - 80) / 700);
        const camGlideEase = camGlideT * (2.0 - camGlideT);
        camera.position.z = THREE.MathUtils.lerp(136, 85, camGlideEase);
      } else if (!cameraLocked) {
        let T = 0;
        if (elapsed < GLOBE_HOLD) {
          T = 0;
        } else if (elapsed < GLOBE_HOLD + SCATTER_DUR) {
          T = easeInOutCubic((elapsed - GLOBE_HOLD) / SCATTER_DUR);
        } else {
          T = 1;
        }

        camera.position.lerpVectors(camStart, camEnd, T);
        if (T >= 1) cameraLocked = true;
      }

      controls.update();
      pointerRay.setFromCamera(pointer, camera);

      const gAngle = elapsed * 0.4;
      const cosG = Math.cos(gAngle);
      const sinG = Math.sin(gAngle);

      // Pre-calculate transition fade multiplier once per frame
      let transFadeMultiplier = 1.0;
      let transDriftMultiplier = 0.0;
      if (isTrans && transElapsed >= 80) {
        const tProgress = Math.min(1.0, (transElapsed - 80) / 600);
        transFadeMultiplier = Math.max(0.0, 1.0 - tProgress * tProgress);
        transDriftMultiplier = (tProgress * tProgress * 1.5 + tProgress * 0.5) * 0.45;
      }

      for (let i = 0; i < COUNT; i++) {
        const cIdx = curtainIndex[i];
        const c = curtains[cIdx];
        const u = uArr[i];
        const v = vArr[i];
        const verticalFade = Math.pow(Math.sin(v * Math.PI), 0.58);

        const baseX = c.xOffset + u * c.width;
        const fanLean = v * v * (u * 13.5) + Math.sin(v * 3.2 + c.phase) * 3.2;
        const wave1 = Math.sin(baseX * c.freqA + time * c.speedA * PARAMS.flowSpeed * 5 + c.phase);
        const wave2 = Math.sin(v * PARAMS.auroraHeight * c.freqB - time * c.speedB * PARAMS.flowSpeed * 5 + c.phase * 1.7);
        const wave3 = Math.sin(u * 3.4 + time * 1.1 * PARAMS.flowSpeed + jitterPhase[i]);
        const waveOffset = (wave1 * c.ampA + wave2 * c.ampB) * PARAMS.waveVariation;
        const shimmer = wave3 * 1.15 * PARAMS.waveVariation;
        const ax = baseX + fanLean + waveOffset * 0.62 + shimmer;
        const ay = (v - 0.08) * c.heightBase - PARAMS.auroraHeight * 0.15;
        const az =
          c.depthBase +
          Math.sin(v * Math.PI * 0.86 + time * 0.18 * PARAMS.flowSpeed + c.phase) * c.depthVariance +
          shimmer * 0.55 +
          Math.sin(v * 4.5 + c.phase) * 2.5;

        const gp = globePos[i];
        const gx = gp.x * cosG - gp.z * sinG;
        const gy = gp.y;
        const gz = gp.x * sinG + gp.z * cosG;

        let T = 1;
        if (elapsed < GLOBE_HOLD) {
          T = 0;
        } else if (elapsed < GLOBE_HOLD + SCATTER_DUR) {
          T = easeInOutCubic((elapsed - GLOBE_HOLD) / SCATTER_DUR);
        }

        target.set(gx + (ax - gx) * T, gy + (ay - gy) * T, gz + (az - gz) * T);

        if (T > 0.5 && (!isTrans || transElapsed < 80)) {
          const rayDistance = (target.z - camera.position.z) / pointerRay.ray.direction.z;
          pointerWorld.copy(pointerRay.ray.origin).addScaledVector(pointerRay.ray.direction, rayDistance);
          const dx = target.x - pointerWorld.x;
          const dy = target.y - pointerWorld.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < repulsion.radius) {
            const str = Math.min(1, (T - 0.5) * 2);
            const falloff = Math.pow(1 - distance / repulsion.radius, 2);
            const safeDistance = Math.max(distance, 0.001);
            target.x += (dx / safeDistance) * falloff * repulsion.strength * str;
            target.y += (dy / safeDistance) * falloff * repulsion.strength * str;
            target.z += falloff * 3.5 * str;
          }
        }

        // Color computation
        if (!isTrans || transElapsed < 250) {
          const edge = edgeBias[i];
          const fold = (Math.sin(v * 5.1 + wave1 * 1.8 + c.phase) + 1) * 0.5;
          let hue = 0.60 + v * 0.025 + fold * 0.012 + (cIdx / NUM_CURTAINS) * 0.018 + Math.sin(time * 0.1 + c.phase) * 0.006;
          if (edge > 0.78) hue = 0.61 + (edge - 0.78) * 0.06;
          const sat = Math.min(1, 0.48 + verticalFade * 0.28);
          const pulse = Math.sin(time * 0.82 + i * 0.00055) * 0.5 + 0.5;
          const baseGlow = Math.pow(verticalFade, 0.72) * (0.22 + 0.38 * PARAMS.intensity * 0.5) * c.brightnessMult;
          const lit = baseGlow + pulse * 0.12 * verticalFade;

          color.setHSL((hue + 1) % 1, sat, Math.min(0.86, Math.max(0.025, lit)));
          aurora.setColorAt(i, color);
        }

        // Fast, zero-square-root outward drift vector calculation
        if (isTrans && transDriftMultiplier > 0) {
          target.x += positions[i].x * transDriftMultiplier;
          target.y += (positions[i].y - 18) * transDriftMultiplier;
          target.z += positions[i].z * transDriftMultiplier;
        }

        positions[i].lerp(target, T < 1 ? 0.06 : 0.12);
        dummy.position.copy(positions[i]);

        const taperedScale = (0.42 + verticalFade * 0.9) * (1.0 - v * 0.34);
        const baseScale = scaleVar[i] * taperedScale;

        if (isTrans && transElapsed >= 80) {
          dummy.scale.setScalar(baseScale * transFadeMultiplier);
        } else if (T < 1) {
          const gS = 0.5;
          const aS = baseScale;
          dummy.scale.setScalar(gS + (aS - gS) * T);
        } else {
          dummy.scale.setScalar(baseScale);
        }

        dummy.updateMatrix();
        aurora.setMatrixAt(i, dummy.matrix);
      }

      aurora.instanceMatrix.needsUpdate = true;
      if (!isTrans || transElapsed < 250) {
        if (aurora.instanceColor) aurora.instanceColor.needsUpdate = true;
      }
      composer.render();
    }
    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(animationId);
      controls.dispose();
      renderer.dispose();
      scene.clear();
      if (containerRef.current && renderer.domElement && containerRef.current.contains(renderer.domElement)) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  const handleEnterDashboard = () => {
    if (isTransitioning) return;
    if (!user) {
      setIsAuthModalOpen(true);
      return;
    }
    startTransition();
  };

  return (
    <div
      className={`aurora-page-wrapper ${isTransitioning ? 'transitioning' : ''} ${fadeOutHandoff ? 'fade-out-handoff' : ''}`}
      style={{
        zIndex: isTransitioning ? 99999 : 50,
        pointerEvents: isTransitioning ? 'none' : 'auto',
      }}
    >
      <div className="canvas-container" ref={containerRef} />

      {/* ── Atmospheric Transition Veil (Luminous Center & Soft Blue-Gray Dawn Bridge) ── */}
      <div className="atmospheric-veil" />

      <div className="content-overlay">
        <div className="content-inner">
          <h1 className="title">AURORA AI</h1>
          <p className="tagline">Run your Amazon business with clarity.</p>
          <p className="description">
            One connected platform for catalog management, inventory intelligence, and smarter
            advertising – built to help sellers grow with confidence.
          </p>
          <button
            className="dashboard-button"
            type="button"
            onClick={handleEnterDashboard}
            disabled={isTransitioning}
            aria-label="Enter User Dashboard"
          >
            {isTransitioning ? 'Entering Aurora…' : 'Enter User Dashboard'}
          </button>
        </div>
      </div>

      {isAuthModalOpen && (
        <AuthModal
          onClose={() => setIsAuthModalOpen(false)}
          onSuccess={startTransition}
        />
      )}
    </div>
  );
}
