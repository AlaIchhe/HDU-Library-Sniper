"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

import { cn } from "@/lib/utils";

export interface AntigravityParticlesProps {
  theme?: "light" | "dark";
  ringWidth?: number;
  ringWidth2?: number;
  ringDisplacement?: number;
  density?: number;
  particlesScale?: number;
  className?: string;
}

interface ThemePalette {
  color1: string;
  color2: string;
  color3: string;
  colorScheme: number;
}

const THEME_PALETTES: Record<"light" | "dark", ThemePalette> = {
  light: {
    color1: "#2c64ed",
    color2: "#f84242",
    color3: "#ffcf03",
    colorScheme: 1,
  },
  dark: {
    color1: "#7189ff",
    color2: "#3074f9",
    color3: "#000000",
    colorScheme: 0,
  },
};

const SIM_SIZE = 256;
const SIM_LENGTH = SIM_SIZE * SIM_SIZE;
const MAX_DELTA_TIME = 0.1;

const SIMPLEX_NOISE_3D_GLSL = /* glsl */ `
  vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 1.0 / 7.0;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

function clampDeltaTime(dt: number): number {
  return !Number.isFinite(dt) || dt <= 0 ? 0 : Math.min(dt, MAX_DELTA_TIME);
}

/** Bridson's 2D Poisson disk sampling to distribute particles evenly without clustering. */
function poissonDiskSample(
  width: number,
  height: number,
  minDistance: number,
  maxDistance: number,
  tries: number,
): [number, number][] {
  const cellSize = minDistance / Math.SQRT2;
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const grid = new Int32Array(cols * rows).fill(-1);
  const points: [number, number][] = [];
  const active: number[] = [];

  const minSq = minDistance * minDistance;
  const span = Math.max(0, maxDistance - minDistance);

  const addPoint = (x: number, y: number): void => {
    const idx = points.length;
    points.push([x, y]);
    active.push(idx);
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    grid[gy * cols + gx] = idx;
  };

  addPoint(Math.random() * width, Math.random() * height);

  while (active.length > 0) {
    const activeIdx = Math.floor(Math.random() * active.length);
    const point = points[active[activeIdx]];
    let found = false;

    for (let i = 0; i < tries; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = minDistance + Math.random() * span;
      const nx = point[0] + Math.cos(angle) * radius;
      const ny = point[1] + Math.sin(angle) * radius;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const gx = Math.floor(nx / cellSize);
      const gy = Math.floor(ny / cellSize);
      const minX = Math.max(0, gx - 2);
      const maxX = Math.min(cols - 1, gx + 2);
      const minY = Math.max(0, gy - 2);
      const maxY = Math.min(rows - 1, gy + 2);

      let tooClose = false;
      for (let yy = minY; yy <= maxY && !tooClose; yy++) {
        const rowOffset = yy * cols;
        for (let xx = minX; xx <= maxX; xx++) {
          const neighborIdx = grid[rowOffset + xx];
          if (neighborIdx !== -1) {
            const dx = nx - points[neighborIdx][0];
            const dy = ny - points[neighborIdx][1];
            if (dx * dx + dy * dy < minSq) {
              tooClose = true;
              break;
            }
          }
        }
      }

      if (!tooClose) {
        addPoint(nx, ny);
        found = true;
        break;
      }
    }

    if (!found) {
      active.splice(activeIdx, 1);
    }
  }

  return points;
}

class ValueNoise1D {
  private readonly values: number[] = [];
  private readonly mask = 255;

  constructor() {
    for (let i = 0; i < 256; i++) {
      this.values.push(Math.random());
    }
  }

  getVal(x: number): number {
    const xi = Math.floor(x);
    const t = x - xi;
    const smooth = t * t * (3 - 2 * t);
    const a = xi & this.mask;
    const b = (a + 1) & this.mask;
    return this.values[a] * (1 - smooth) + this.values[b] * smooth;
  }
}

interface SimulationOptions {
  container: HTMLElement;
  theme: "light" | "dark";
  ringWidth: number;
  ringWidth2: number;
  ringDisplacement: number;
  density: number;
  particlesScale: number;
}

class ParticleRingSimulation {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock: THREE.Clock;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouseNDC = new THREE.Vector2();
  private readonly intersectionPoint = new THREE.Vector3();
  private readonly raycastPlane: THREE.Mesh;

  private readonly simScene: THREE.Scene;
  private readonly simCamera: THREE.OrthographicCamera;
  private readonly simMaterial: THREE.ShaderMaterial;
  private readonly renderMaterial: THREE.ShaderMaterial;
  private readonly pointsMesh: THREE.Points;
  private readonly posTex: THREE.DataTexture;
  private rt1: THREE.WebGLRenderTarget;
  private rt2: THREE.WebGLRenderTarget;

  private readonly noise1D = new ValueNoise1D();
  private readonly ringPos = new THREE.Vector2(0, 0);
  private readonly cursorPos = new THREE.Vector2(0, 0);
  private readonly pointerClient = new THREE.Vector2(0, 0);
  private readonly prevColorManagementEnabled: boolean;

  private pixelRatio: number;
  private particlesScale: number;
  private ringWidth: number;
  private ringWidth2: number;
  private ringDisplacement: number;

  private time = 0;
  private lastSceneTime = 0;
  private lastParticleTime = 0;
  private everRendered = false;
  private isPaused = false;
  private isIntersecting = false;
  private hasPointerMoved = false;
  private skipRaycastFrame = false;
  private rectDirty = true;
  private canvasRect: DOMRect | null = null;
  private screenWidth = window.innerWidth;
  private screenHeight = window.innerHeight;
  private isOffscreen = false;
  private frameSkipCounter = 0;
  private rafId: number | null = null;
  private readonly reducedMotion: boolean;
  private readonly visibilityObserver?: IntersectionObserver;
  private readonly resizeObserver?: ResizeObserver;

  constructor(options: SimulationOptions) {
    this.container = options.container;
    this.particlesScale = options.particlesScale;
    this.ringWidth = options.ringWidth;
    this.ringWidth2 = options.ringWidth2;
    this.ringDisplacement = options.ringDisplacement;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.reducedMotion =
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

    this.prevColorManagementEnabled = THREE.ColorManagement.enabled;
    THREE.ColorManagement.enabled = false;

    this.scene = new THREE.Scene();
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.container.appendChild(this.canvas);

    const width = Math.max(1, this.container.offsetWidth);
    const height = Math.max(1, this.container.offsetHeight);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
      precision: "highp",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(this.pixelRatio);

    const gl = this.renderer.getContext();
    this.renderer.extensions.get("EXT_color_buffer_float");

    this.camera = new THREE.PerspectiveCamera(
      40,
      gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight),
      0.1,
      1000,
    );
    this.camera.position.z = 3.1;

    this.clock = new THREE.Clock();

    this.raycastPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(12.5, 12.5),
      new THREE.MeshBasicMaterial({ color: 0xff0000, visible: false, side: THREE.DoubleSide }),
    );
    this.scene.add(this.raycastPlane);

    const effectiveDensity = this.reducedMotion ? Math.min(options.density, 110) : options.density;
    const sampled = poissonDiskSample(
      500,
      500,
      mapRange(effectiveDensity, 0, 300, 10, 2),
      mapRange(effectiveDensity, 0, 300, 11, 3),
      this.reducedMotion ? 12 : 20,
    );

    const count = Math.min(sampled.length, SIM_LENGTH);
    const posData = new Float32Array(SIM_LENGTH * 4);
    for (let i = 0; i < count; i++) {
      const idx = i * 4;
      posData[idx] = (sampled[i][0] - 250) / 250;
      posData[idx + 1] = (sampled[i][1] - 250) / 250;
      posData[idx + 2] = 0;
      posData[idx + 3] = 0;
    }

    this.posTex = new THREE.DataTexture(posData, SIM_SIZE, SIM_SIZE, THREE.RGBAFormat, THREE.FloatType);
    this.posTex.needsUpdate = true;

    const rtOptions: THREE.RenderTargetOptions = {
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rt1 = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, rtOptions);
    this.rt2 = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, rtOptions);

    this.renderer.setRenderTarget(this.rt1);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.rt2);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);

    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uPosRefs: { value: this.posTex },
        uRingPos: { value: new THREE.Vector2(0, 0) },
        uRingRadius: { value: 0.2 },
        uDeltaTime: { value: 0 },
        uRingWidth: { value: this.ringWidth },
        uRingWidth2: { value: this.ringWidth2 },
        uRingDisplacement: { value: this.ringDisplacement },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uPosition;
        uniform sampler2D uPosRefs;
        uniform vec2 uRingPos;
        uniform float uTime;
        uniform float uDeltaTime;
        uniform float uRingRadius;
        uniform float uRingWidth;
        uniform float uRingWidth2;
        uniform float uRingDisplacement;

        ${SIMPLEX_NOISE_3D_GLSL}

        void main() {
          vec2 simTexCoords = gl_FragCoord.xy / vec2(${SIM_SIZE.toFixed(1)}, ${SIM_SIZE.toFixed(1)});
          vec4 pFrame = texture2D(uPosition, simTexCoords);

          float scale = pFrame.z;
          float velocity = pFrame.w;
          vec2 refPos = texture2D(uPosRefs, simTexCoords).xy;

          float time = uTime * 0.5;
          vec2 currentPos = refPos;

          vec2 pos = pFrame.xy;
          pos *= 0.8;

          float dist = distance(currentPos.xy, uRingPos);
          float noise0 = snoise(vec3(currentPos.xy * 0.2 + vec2(18.4924, 72.9744), time * 0.5));
          float dist1 = distance(currentPos.xy + (noise0 * 0.005), uRingPos);

          float t = smoothstep(uRingRadius - (uRingWidth * 2.0), uRingRadius, dist)
                  - smoothstep(uRingRadius, uRingRadius + uRingWidth, dist1);
          float t2 = smoothstep(uRingRadius - (uRingWidth2 * 2.0), uRingRadius, dist)
                   - smoothstep(uRingRadius, uRingRadius + uRingWidth2, dist1);
          float t3 = smoothstep(uRingRadius + uRingWidth2, uRingRadius, dist);

          t = pow(t, 2.0);
          t2 = pow(t2, 3.0);

          t += t2 * 3.0;
          t += t3 * 0.4;
          t += snoise(vec3(currentPos.xy * 30.0 + vec2(11.4924, 12.9744), time * 0.5)) * t3 * 0.5;

          float nS = snoise(vec3(currentPos.xy * 2.0 + vec2(18.4924, 72.9744), time * 0.5));
          t += pow((nS + 1.5) * 0.5, 2.0) * 0.6;

          float noise1 = snoise(vec3(currentPos.xy * 4.0 + vec2(88.494, 32.4397), time * 0.35));
          float noise2 = snoise(vec3(currentPos.xy * 4.0 + vec2(50.904, 120.947), time * 0.35));
          float noise3 = snoise(vec3(currentPos.xy * 20.0 + vec2(18.4924, 72.9744), time * 0.5));
          float noise4 = snoise(vec3(currentPos.xy * 20.0 + vec2(50.904, 120.947), time * 0.5));

          vec2 disp = vec2(noise1, noise2) * 0.03;
          disp += vec2(noise3, noise4) * 0.005;

          disp.x += sin((refPos.x * 20.0) + (time * 4.0)) * 0.02 * clamp(dist, 0.0, 1.0);
          disp.y += cos((refPos.y * 20.0) + (time * 3.0)) * 0.02 * clamp(dist, 0.0, 1.0);

          pos -= (uRingPos - (currentPos + disp)) * pow(t2, 0.75) * uRingDisplacement;

          float scaleDiff = t - scale;
          scaleDiff *= 0.2;
          scale += scaleDiff;

          vec2 finalPos = currentPos + disp + (pos * 0.25);

          velocity *= 0.5;
          velocity += scale * 0.25;

          gl_FragColor = vec4(finalPos, scale, velocity);
        }
      `,
    });
    const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMaterial);
    this.simScene.add(simQuad);

    const geometry = new THREE.BufferGeometry();
    const uvs = new Float32Array(count * 2);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      uvs[i * 2] = (i % SIM_SIZE) / SIM_SIZE;
      uvs[i * 2 + 1] = Math.floor(i / SIM_SIZE) / SIM_SIZE;
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("seeds", new THREE.BufferAttribute(seeds, 4));

    const palette = THEME_PALETTES[options.theme];
    const particleScale = (this.renderer.domElement.width / this.pixelRatio / 2000) * this.particlesScale;

    this.renderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uTime: { value: 0 },
        uColor1: { value: new THREE.Color(palette.color1) },
        uColor2: { value: new THREE.Color(palette.color2) },
        uColor3: { value: new THREE.Color(palette.color3) },
        uAlpha: { value: 1 },
        uRingPos: { value: new THREE.Vector2(0, 0) },
        uRez: {
          value: new THREE.Vector2(this.renderer.domElement.width, this.renderer.domElement.height),
        },
        uParticleScale: { value: particleScale },
        uPixelRatio: { value: this.pixelRatio },
        uColorScheme: { value: palette.colorScheme },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        attribute vec4 seeds;

        uniform sampler2D uPosition;
        uniform float uTime;
        uniform float uParticleScale;
        uniform float uPixelRatio;
        uniform int uColorScheme;

        varying vec4 vSeeds;
        varying float vVelocity;
        varying vec2 vLocalPos;
        varying vec2 vScreenPos;
        varying float vScale;

        void main() {
          vec4 pos = texture2D(uPosition, uv);
          vSeeds = seeds;
          vVelocity = pos.w;
          vScale = pos.z;
          vLocalPos = pos.xy;

          vec4 viewSpace = modelViewMatrix * vec4(vec3(pos.xy, 0.0), 1.0);
          gl_Position = projectionMatrix * viewSpace;
          vScreenPos = gl_Position.xy;

          gl_PointSize = ((vScale * 7.0) * (uPixelRatio * 0.5) * uParticleScale);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        varying vec4 vSeeds;
        varying vec2 vScreenPos;
        varying vec2 vLocalPos;
        varying float vScale;
        varying float vVelocity;

        uniform vec3 uColor1;
        uniform vec3 uColor2;
        uniform vec3 uColor3;
        uniform vec2 uRingPos;
        uniform vec2 uRez;
        uniform float uAlpha;
        uniform float uTime;
        uniform int uColorScheme;

        ${SIMPLEX_NOISE_3D_GLSL}

        float sdRoundBox(in vec2 p, in vec2 b, in vec4 r) {
          r.xy = (p.x > 0.0) ? r.xy : r.zw;
          r.x  = (p.y > 0.0) ? r.x  : r.y;
          vec2 q = abs(p) - b + r.x;
          return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r.x;
        }

        vec2 rotate2d(vec2 v, float a) {
          float s = sin(a);
          float c = cos(a);
          return mat2(c, s, -s, c) * v;
        }

        void main() {
          float noiseAngle = snoise(vec3(vLocalPos * 10.0 + vec2(18.4924, 72.9744), uTime * 0.85));
          float noiseColor = snoise(vec3(vLocalPos * 2.0 + vec2(74.664, 91.556), uTime * 0.5));
          noiseColor = (noiseColor + 1.0) * 0.5;

          float angle = atan(vLocalPos.y - uRingPos.y, vLocalPos.x - uRingPos.x);

          vec2 uv = gl_PointCoord.xy - vec2(0.5);
          uv.y *= -1.0;
          uv = rotate2d(uv, -angle + (noiseAngle * 0.5));

          float h = 0.8;
          float progress = smoothstep(0.0, 0.75, pow(noiseColor, 2.0));
          vec3 col = mix(
            mix(uColor1, uColor2, progress / h),
            mix(uColor2, uColor3, (progress - h) / (1.0 - h)),
            step(h, progress)
          );
          vec3 color = col;

          float rounded = sdRoundBox(uv, vec2(0.5, 0.2), vec4(0.25));
          rounded = smoothstep(0.1, 0.0, rounded);

          float a = uAlpha * rounded * smoothstep(0.1, 0.2, vScale);
          if (a < 0.01) {
            discard;
          }

          color = clamp(color, 0.0, 1.0);
          color = mix(color, color * clamp(vVelocity, 0.0, 1.0), float(uColorScheme));

          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));

          #ifdef SRGB_TRANSFER
            gl_FragColor = sRGBTransferOETF(gl_FragColor);
          #endif
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.pointsMesh = new THREE.Points(geometry, this.renderMaterial);
    this.pointsMesh.position.set(0, 0, 0);
    this.pointsMesh.scale.set(5, 5, 5);
    this.scene.add(this.pointsMesh);

    if (typeof IntersectionObserver !== "undefined") {
      this.visibilityObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            this.isOffscreen = !entry.isIntersecting;
            if (entry.isIntersecting && !document.hidden) {
              this.resume();
            } else {
              this.stop();
            }
          }
        },
        { root: null, rootMargin: "100px 0px", threshold: 0 },
      );
      this.visibilityObserver.observe(this.container);
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
      });
      this.resizeObserver.observe(this.container);
    }

    window.addEventListener("resize", this.handleResize, { passive: true });
    window.addEventListener("scroll", this.handleScroll, { passive: true });
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) {
      window.addEventListener("mousemove", this.handleMouseMove, { passive: true });
    } else {
      window.addEventListener("pointerdown", this.handlePointerDown, { passive: true, capture: true });
    }

    this.resume();
  }

  setTheme(theme: "light" | "dark"): void {
    const palette = THEME_PALETTES[theme];
    this.renderMaterial.uniforms.uColor1.value.set(palette.color1);
    this.renderMaterial.uniforms.uColor2.value.set(palette.color2);
    this.renderMaterial.uniforms.uColor3.value.set(palette.color3);
    this.renderMaterial.uniforms.uColorScheme.value = palette.colorScheme;
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    this.pointerClient.set(event.clientX, event.clientY);
    this.hasPointerMoved = true;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") return;
    this.pointerClient.set(event.clientX, event.clientY);
    this.hasPointerMoved = true;
  };

  private readonly handleScroll = (): void => {
    this.rectDirty = true;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (!this.isOffscreen) {
      this.resume();
    }
  };

  private readonly handleResize = (): void => {
    this.screenWidth = window.innerWidth;
    this.screenHeight = window.innerHeight;
    this.resize();
  };

  resize(): void {
    const width = this.container.offsetWidth;
    const height = this.container.offsetHeight;
    if (width <= 0 || height <= 0) return;

    this.rectDirty = true;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderMaterial.uniforms.uRez.value.set(
      this.renderer.domElement.width,
      this.renderer.domElement.height,
    );
    this.renderMaterial.uniforms.uPixelRatio.value = this.pixelRatio;
  }

  stop(): void {
    this.isPaused = true;
    this.clock.stop();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume(): void {
    if (document.hidden) return;
    this.isPaused = false;
    this.clock.start();
    this.lastSceneTime = 0;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    if (this.isPaused || document.hidden || this.isOffscreen) {
      this.rafId = null;
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
    this.render();
  };

  private updateRaycast(): void {
    this.skipRaycastFrame = !this.skipRaycastFrame;
    if (this.skipRaycastFrame || !this.hasPointerMoved) return;

    if (this.rectDirty || !this.canvasRect) {
      this.canvasRect = this.canvas.getBoundingClientRect();
      this.rectDirty = false;
    }

    const rect = this.canvasRect;
    if (!rect.width || !rect.height) {
      this.isIntersecting = false;
      return;
    }

    const localX = (this.pointerClient.x - rect.left) * (this.screenWidth / rect.width);
    const localY = (this.pointerClient.y - rect.top) * (this.screenHeight / rect.height);
    this.mouseNDC.x = (localX / this.screenWidth) * 2 - 1;
    this.mouseNDC.y = -(localY / this.screenHeight) * 2 + 1;

    if (this.mouseNDC.x < -1 || this.mouseNDC.x > 1 || this.mouseNDC.y < -1 || this.mouseNDC.y > 1) {
      this.isIntersecting = false;
      return;
    }

    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObject(this.raycastPlane);
    if (hits.length > 0) {
      this.intersectionPoint.copy(hits[0].point);
      this.isIntersecting = true;
    } else {
      this.isIntersecting = false;
    }
  }

  private render(): void {
    const elapsed = this.clock.getElapsedTime();
    const dt = clampDeltaTime(elapsed - this.lastSceneTime);
    this.lastSceneTime = elapsed;
    this.time += dt;

    if (this.isOffscreen && this.everRendered) {
      this.lastParticleTime = elapsed;
      return;
    }

    const isMobileViewport = window.innerWidth <= 768;
    if (isMobileViewport && this.everRendered) {
      this.frameSkipCounter += 1;
      if (this.frameSkipCounter % 2 !== 0) {
        this.lastParticleTime = elapsed;
        return;
      }
    }

    const simDt = clampDeltaTime(elapsed - this.lastParticleTime);
    this.lastParticleTime = elapsed;

    this.updateRaycast();

    const driftX = (this.noise1D.getVal(this.time * 0.66 + 94.234) - 0.5) * 2;
    const driftY = (this.noise1D.getVal(this.time * 0.75 + 21.028) - 0.5) * 2;

    if (this.isIntersecting) {
      this.cursorPos.set(
        this.intersectionPoint.x * 0.175 + driftX * 0.1,
        this.intersectionPoint.y * 0.175 + driftY * 0.1,
      );
      this.ringPos.set(
        this.ringPos.x + (this.cursorPos.x - this.ringPos.x) * 0.02,
        this.ringPos.y + (this.cursorPos.y - this.ringPos.y) * 0.02,
      );
    } else {
      this.cursorPos.set(driftX * 0.2, driftY * 0.1);
      this.ringPos.set(
        this.ringPos.x + (this.cursorPos.x - this.ringPos.x) * 0.01,
        this.ringPos.y + (this.cursorPos.y - this.ringPos.y) * 0.01,
      );
    }

    const particleScale = (this.renderer.domElement.width / this.pixelRatio / 2000) * this.particlesScale;

    this.simMaterial.uniforms.uPosition.value = this.everRendered ? this.rt1.texture : this.posTex;
    this.simMaterial.uniforms.uTime.value = this.time;
    this.simMaterial.uniforms.uDeltaTime.value = simDt;
    this.simMaterial.uniforms.uRingRadius.value =
      0.175 + Math.sin(this.time * 1.0) * 0.03 + Math.cos(this.time * 3.0) * 0.02;
    this.simMaterial.uniforms.uRingPos.value.copy(this.ringPos);
    this.simMaterial.uniforms.uRingWidth.value = this.ringWidth;
    this.simMaterial.uniforms.uRingWidth2.value = this.ringWidth2;
    this.simMaterial.uniforms.uRingDisplacement.value = this.ringDisplacement;

    this.renderer.setRenderTarget(this.rt2);
    this.renderer.render(this.simScene, this.simCamera);
    this.renderer.setRenderTarget(null);

    this.renderMaterial.uniforms.uPosition.value = this.everRendered ? this.rt2.texture : this.posTex;
    this.renderMaterial.uniforms.uTime.value = this.time;
    this.renderMaterial.uniforms.uRingPos.value.copy(this.ringPos);
    this.renderMaterial.uniforms.uParticleScale.value = particleScale;

    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    const tmp = this.rt1;
    this.rt1 = this.rt2;
    this.rt2 = tmp;
    this.everRendered = true;
  }

  dispose(): void {
    this.stop();
    this.visibilityObserver?.disconnect();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("scroll", this.handleScroll);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("pointerdown", this.handlePointerDown, true);

    this.scene.remove(this.pointsMesh);
    this.pointsMesh.geometry.dispose();
    this.renderMaterial.dispose();

    this.scene.remove(this.raycastPlane);
    this.raycastPlane.geometry.dispose();
    (this.raycastPlane.material as THREE.Material).dispose();

    for (const child of this.simScene.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
    this.simMaterial.dispose();

    this.rt1.dispose();
    this.rt2.dispose();
    this.posTex.dispose();
    this.renderer.dispose();
    this.canvas.parentElement?.removeChild(this.canvas);
    THREE.ColorManagement.enabled = this.prevColorManagementEnabled;
  }
}

export function AntigravityParticles({
  theme = "light",
  ringWidth = 0.011,
  ringWidth2 = 0.107,
  ringDisplacement = 0.53,
  density = 230,
  particlesScale = 0.59,
  className,
}: AntigravityParticlesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<ParticleRingSimulation | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let initObserver: ResizeObserver | undefined;

    const startSimulation = () => {
      if (disposed || simRef.current) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

      try {
        simRef.current = new ParticleRingSimulation({
          container,
          theme: themeRef.current,
          ringWidth,
          ringWidth2,
          ringDisplacement,
          density,
          particlesScale,
        });
      } catch {
        // WebGL unavailable (e.g. headless test environment or disabled GPU): degrade silently.
      }
    };

    startSimulation();

    if (!simRef.current && typeof ResizeObserver !== "undefined") {
      initObserver = new ResizeObserver(() => {
        startSimulation();
        if (simRef.current) {
          initObserver?.disconnect();
          initObserver = undefined;
        }
      });
      initObserver.observe(container);
    }

    return () => {
      disposed = true;
      initObserver?.disconnect();
      simRef.current?.dispose();
      simRef.current = null;
    };
  }, [ringWidth, ringWidth2, ringDisplacement, density, particlesScale]);

  useEffect(() => {
    simRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 overflow-hidden", className)}
    />
  );
}
