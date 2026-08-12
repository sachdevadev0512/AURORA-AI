---
name: spline-3d-integration
description: Comprehensive skill for integrating Spline 3D interactive scenes, canvas backgrounds, and 3D objects into React applications using @splinetool/react-spline.
---

# Spline 3D Integration Skill

This skill provides patterns, components, and best practices for integrating interactive 3D scenes from [Spline](https://spline.design/) into React web applications using `@splinetool/react-spline` and `@splinetool/runtime`.

## Installation & Setup

Ensure the required dependencies are installed in the React frontend:

```bash
npm install @splinetool/react-spline @splinetool/runtime
```

## Basic Usage

To embed a Spline 3D scene in a React component:

```tsx
import Spline from '@splinetool/react-spline';

export default function Hero3D() {
  return (
    <div style={{ width: '100%', height: '500px', position: 'relative' }}>
      <Spline scene="https://prod.spline.design/YOUR_SCENE_ID/scene.splcode" />
    </div>
  );
}
```

## Advanced Patterns

### 1. Handling Load States & Fallbacks
3D scenes require asset downloads. Show a smooth loading indicator or fallback UI until the scene is fully rendered:

```tsx
import { useState } from 'react';
import Spline from '@splinetool/react-spline';

export function InteractiveSplineScene({ sceneUrl }: { sceneUrl: string }) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {isLoading && (
        <div className="spline-loader" style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(10, 15, 30, 0.8)',
          backdropFilter: 'blur(8px)',
          color: '#60a5fa',
          zIndex: 10
        }}>
          <span>Loading 3D Experience...</span>
        </div>
      )}
      <Spline
        scene={sceneUrl}
        onLoad={() => setIsLoading(false)}
      />
    </div>
  );
}
```

### 2. Fullscreen / Hero Canvas Background
When using Spline as an interactive 3D hero background:

```tsx
import Spline from '@splinetool/react-spline';

export function Background3DHero({ sceneUrl }: { sceneUrl: string }) {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
        <Spline scene={sceneUrl} />
      </div>
      <div style={{
        position: 'relative',
        zIndex: 2,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%'
      }}>
        <h1 style={{ pointerEvents: 'auto' }}>Aurora AI</h1>
      </div>
    </div>
  );
}
```

### 3. Interacting with Spline Objects via Code
Control Spline objects programmatically using `onLoad` ref callbacks:

```tsx
import { useRef } from 'react';
import Spline from '@splinetool/react-spline';
import type { Application } from '@splinetool/runtime';

export function ControlledSplineScene({ sceneUrl }: { sceneUrl: string }) {
  const splineRef = useRef<Application | null>(null);

  function onLoad(splineApp: Application) {
    splineRef.current = splineApp;
    // Find an object by name in Spline editor
    const obj = splineApp.findObjectByName('Cube');
    if (obj) {
      console.log('Found Spline object:', obj);
    }
  }

  function triggerAnimation() {
    splineRef.current?.emitEvent('mouseDown', 'Cube');
  }

  return (
    <div>
      <button onClick={triggerAnimation}>Trigger 3D Action</button>
      <Spline scene={sceneUrl} onLoad={onLoad} />
    </div>
  );
}
```

## Best Practices
- **Dimensions**: Always wrap `<Spline />` in a container with explicitly defined `width` and `height` (or CSS `inset: 0` inside a `position: relative` container).
- **Performance**: Enable `pointer-events: none` on overlay text or controls if user clicks should pass through to the 3D scene.
- **Scene URLs**: Use official `https://prod.spline.design/.../scene.splcode` URLs export links from the Spline Editor.
