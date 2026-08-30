import { useEffect, useRef } from "react";

const RMAX = 1400;
const FOV = 34;
const DPR_CAP = 1.25;
const FRAME_MS = 1000 / 24;
const TAU = Math.PI * 2;
const GAP_PER_WIDTH = 65 / 120;
const BAND_WIDTH_AT_50 = 120;
const FUZZ_AT_50 = 55;
const EDGE_GLOW_AT_50 = 38;
const AMPLITUDE_AT_100 = 400;
const COUNT_PER_DENSITY = 72;
const DEPTH_FADE = 55;
const WAVE_FREQUENCY = 4;
const WAVE_SPEED = 1.15;
const MORPH_PERIOD = 30;
const ROT_DEG_AT_50 = 10;
const BASE_DISTANCE = 3600;
const VOID_RATIO = 0.28;
const HOVER_EASE = 7;

const VERT = `
precision highp float;

attribute vec4 aRing;

uniform vec2  uRes;
uniform float uFocal;
uniform float uDist;
uniform float uPitchCam;
uniform float uRoll;
uniform float uSpin;
uniform float uDot;
uniform float uMorphT;
uniform float uVoidR;
uniform float uEdgeW;
uniform vec3  uCols[5];
uniform int   uColN;
uniform float uDepthFade;
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveT;

varying vec3  vCol;
varying float vA;

#define PI    3.14159265
#define TAU   6.28318530
#define RMAX  1400.0

float sdfCircle(vec2 p, float r) {
    return length(p) - r;
}

float sdfPentagon(vec2 p, float r) {
    float sector = TAU / 5.0;
    float a      = atan(p.y, p.x);
    float fa     = mod(a + PI / 5.0, sector) - sector * 0.5;
    return length(p) * cos(fa) - r * cos(PI / 5.0);
}

float sdfHeart(vec2 p, float r) {
    vec2 q  = p / max(r, 0.001);
    q.y     = -q.y - 0.2;
    q.x     = abs(q.x);
    vec2 a  = q - vec2(0.25,  0.75);
    vec2 b  = q - vec2(0.0,   1.0 );
    vec2 c2 = q - vec2(0.5,   0.0 );
    float region = clamp(q.y + q.x - 1.0, 0.0, 1.0);
    float da = sqrt(dot(a, a)) - sqrt(0.5) * 0.5;
    float db = min(sqrt(dot(b, b)), sqrt(dot(c2, c2))) - 0.5;
    return mix(db, da, region) * r;
}

float voidSDF(vec2 p, float r) {
    float dC = sdfCircle (p, r);
    float dP = sdfPentagon(p, r * 0.90);
    float dH = sdfHeart  (p, r * 1.10);
    float t3 = uMorphT * 3.0;
    float seg = floor(t3);
    float f   = fract(t3);
    float sf  = f * f * (3.0 - 2.0 * f);
    float d01 = mix(dC, dP, sf);
    float d12 = mix(dP, dH, sf);
    float d20 = mix(dH, dC, sf);
    float d   = mix(mix(d01, d12, step(1.0, seg)), d20, step(2.0, seg));
    return d;
}

vec3 pickCol(float t) {
    int n   = uColN;
    int idx = int(floor(clamp(t, 0.0, 0.9999) * float(n)));
    vec3 c  = uCols[0];
    for (int i = 0; i < 5; i++) {
        if (i >= n) break;
        if (i == idx) c = uCols[i];
    }
    return c;
}

void main() {
    float normR   = aRing.x;
    float theta   = aRing.y;
    float normBnd = aRing.z;
    float jitter  = aRing.w;

    float angle = theta + uSpin;
    float r     = normR * RMAX;
    float px    = r * cos(angle);
    float pz    = r * sin(angle);

    float vd    = voidSDF(vec2(px, pz), uVoidR);
    float edgeT = 1.0 - smoothstep(0.0, uEdgeW * 2.0, abs(vd));
    float maskA = smoothstep(-uEdgeW, uEdgeW, vd);

    float kFreq      = uWaveFreq * TAU / RMAX;
    float wavePhaseR = r  * kFreq - uWaveT;
    float wavePhaseX = px * kFreq - uWaveT * 0.71;
    float py         = (sin(wavePhaseR) * 0.65 + sin(wavePhaseX) * 0.35) * uWaveAmp;
    py *= smoothstep(0.0, uEdgeW * 3.0, vd);

    float bandBri = 0.38 + (1.0 - normBnd) * 0.62;
    float bsd     = 0.3 + jitter * 0.7;

    float c  = cos(uPitchCam);
    float s  = sin(uPitchCam);
    float ry = py * c + pz * s;
    float rz = uDist - py * s + pz * c;

    if (rz < 30.0) {
        gl_Position  = vec4(2.0, 2.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        vA = 0.0;
        vCol = uCols[0];
        return;
    }

    float cr = cos(uRoll);
    float sr = sin(uRoll);
    float sx = (px * cr - ry * sr) * uFocal / rz;
    float sy = (px * sr + ry * cr) * uFocal / rz;
    gl_Position = vec4(sx / (uRes.x * 0.5), sy / (uRes.y * 0.5), 0.0, 1.0);

    float szv    = 0.5 + bsd * 1.5;
    gl_PointSize = clamp(uDot * uFocal / rz * szv, 1.0, 28.0);

    vec3 col = pickCol(jitter);
    vec3 hi  = pickCol(1.0);
    col      = mix(col, hi, edgeT);
    col      = mix(col, vec3(1.0), edgeT * 0.30);

    float waveHi = max(0.0, py / max(uWaveAmp, 0.001));
    col          = mix(col, hi, waveHi * 0.25);

    float dep  = 1.0 - uDepthFade * smoothstep(uDist * 0.6, uDist * 1.6, rz);
    float bri  = (0.28 + bsd * 0.72) * bandBri * (1.0 + edgeT * 2.5);
    bri       *= 1.0 + waveHi * 0.40;

    vCol = col;
    vA   = clamp(bri * dep * maskA, 0.0, 3.0);
}
`;

const FRAG = `
precision highp float;
varying vec3  vCol;
varying float vA;
void main() {
    vec2  c  = gl_PointCoord - 0.5;
    float d  = length(c) * 2.0;
    float a  = vA * (1.0 - smoothstep(0.5, 1.0, d));
    gl_FragColor = vec4(vCol * a, a);
}
`;

const DARK_COLORS = ["#0a2c28", "#15685c", "#22c3a6", "#7ef0d6", "#f2fffb"];
const LIGHT_COLORS = ["#0c3f38", "#12786a", "#169882", "#1fb39a", "#34d1b6"];

type Live = {
  dark: boolean;
  hovering: boolean;
  reduced: boolean;
  hidden: boolean;
  offscreen: boolean;
};

function parseColor(input: string): [number, number, number] {
  if (!input) return [0, 0, 0];
  const s = input.trim();
  const fn = s.match(/rgba?\(([^)]+)\)/i);
  if (fn) {
    const p = fn[1].split(",").map((v) => parseFloat(v.trim()));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
  }
  let h = s.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  h = h.padEnd(6, "0");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd: () => number) {
  const u1 = Math.max(1e-9, rnd());
  const u2 = rnd();
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
  return Math.max(-3, Math.min(3, g));
}

function compile(gl: WebGLRenderingContext, type: number, src: string, tag: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("MorphingRings shader " + tag + ":", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function buildParticles(count: number, bands: number, width: number, softness: number) {
  const rnd = mulberry32(0x51a3c7e2);
  const data = new Float32Array(count * 4);
  const bandW = (width / 50) * BAND_WIDTH_AT_50;
  const gap = bandW * GAP_PER_WIDTH;
  const fuzz = (softness / 50) * FUZZ_AT_50;
  const voidR = VOID_RATIO * RMAX;
  const nBands = Math.max(1, bands);

  for (let i = 0; i < count; i++) {
    const band = i % nBands;
    const normBnd = nBands <= 1 ? 1 : band / (nBands - 1);
    const outer = RMAX - band * (bandW + gap);
    const inner = outer - bandW;
    let r = inner + (0.5 + gauss(rnd) * 0.32) * bandW;
    r += gauss(rnd) * fuzz * 0.18;
    r = Math.max(voidR * 0.72, Math.min(RMAX * 0.995, r));
    data[i * 4] = r / RMAX;
    data[i * 4 + 1] = rnd() * TAU;
    data[i * 4 + 2] = normBnd;
    data[i * 4 + 3] = rnd();
  }
  return data;
}

function palette(dark: boolean) {
  const src = dark ? DARK_COLORS : LIGHT_COLORS;
  const out = new Float32Array(15);
  for (let i = 0; i < 5; i++) {
    const [r, g, b] = parseColor(src[Math.min(i, src.length - 1)]);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return { data: out, n: src.length };
}

function themeIsDark() {
  const mode = document.documentElement.dataset.theme;
  return mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

type MorphingRingsProps = {
  className?: string;
};

export function MorphingRings({ className }: MorphingRingsProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live>({ dark: true, hovering: false, reduced: false, hidden: false, offscreen: false });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const canvas = document.createElement("canvas");
    canvas.className = "morphing-rings-canvas";
    wrap.appendChild(canvas);

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      canvas.remove();
      return;
    }

    const vert = compile(gl, gl.VERTEX_SHADER, VERT, "vert");
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG, "frag");
    const prog = gl.createProgram();
    if (!vert || !frag || !prog) {
      canvas.remove();
      return;
    }
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("MorphingRings program:", gl.getProgramInfoLog(prog));
      canvas.remove();
      return;
    }
    gl.useProgram(prog);

    const density = 36;
    const ringBands = 12;
    const ringWidth = 50;
    const softness = 50;
    const count = Math.min(density * COUNT_PER_DENSITY, 3200);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, buildParticles(count, ringBands, ringWidth, softness), gl.STATIC_DRAW);

    const aRing = gl.getAttribLocation(prog, "aRing");
    gl.enableVertexAttribArray(aRing);
    gl.vertexAttribPointer(aRing, 4, gl.FLOAT, false, 0, 0);

    const loc = {
      uRes: gl.getUniformLocation(prog, "uRes"),
      uFocal: gl.getUniformLocation(prog, "uFocal"),
      uDist: gl.getUniformLocation(prog, "uDist"),
      uPitchCam: gl.getUniformLocation(prog, "uPitchCam"),
      uRoll: gl.getUniformLocation(prog, "uRoll"),
      uSpin: gl.getUniformLocation(prog, "uSpin"),
      uDot: gl.getUniformLocation(prog, "uDot"),
      uMorphT: gl.getUniformLocation(prog, "uMorphT"),
      uVoidR: gl.getUniformLocation(prog, "uVoidR"),
      uEdgeW: gl.getUniformLocation(prog, "uEdgeW"),
      uCols: gl.getUniformLocation(prog, "uCols[0]") || gl.getUniformLocation(prog, "uCols"),
      uColN: gl.getUniformLocation(prog, "uColN"),
      uDepthFade: gl.getUniformLocation(prog, "uDepthFade"),
      uWaveAmp: gl.getUniformLocation(prog, "uWaveAmp"),
      uWaveFreq: gl.getUniformLocation(prog, "uWaveFreq"),
      uWaveT: gl.getUniformLocation(prog, "uWaveT"),
    };

    const speed = 50;
    const scale = 64;
    const amplitude = 22;
    const dotSize = 5.4;
    const tiltX = 36;
    const tiltY = -5;
    const dir = -1;
    const hoverMul = 2.05;
    const rotRate = ((ROT_DEG_AT_50 * Math.PI) / 180) * (speed / 50) * dir;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    let spin = 0;
    let morphT = 0;
    let waveT = 0;
    let hoverGate = 1;
    let raf = 0;
    let last = performance.now();
    let disposed = false;

    const mediaReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mediaColor = window.matchMedia("(prefers-color-scheme: dark)");
    const resume = () => {
      if (disposed || raf || liveRef.current.hidden || liveRef.current.offscreen) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const syncReduced = () => {
      liveRef.current.reduced = mediaReduce.matches;
      if (!mediaReduce.matches) resume();
    };
    const syncTheme = () => {
      liveRef.current.dark = themeIsDark();
    };
    const syncHidden = () => {
      liveRef.current.hidden = document.hidden;
      if (!document.hidden && !liveRef.current.offscreen) resume();
    };
    const syncVisible = (visible: boolean) => {
      liveRef.current.offscreen = !visible;
      if (visible && !liveRef.current.hidden) resume();
    };

    const host = wrap.parentElement || wrap;
    const onEnter = () => {
      liveRef.current.hovering = true;
    };
    const onLeave = () => {
      liveRef.current.hovering = false;
    };
    host.addEventListener("pointerenter", onEnter);
    host.addEventListener("pointerleave", onLeave);
    mediaReduce.addEventListener("change", syncReduced);
    mediaColor.addEventListener("change", syncTheme);
    document.addEventListener("visibilitychange", syncHidden);
    const themeObs = new MutationObserver(syncTheme);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        syncVisible(Boolean(entry?.isIntersecting && (entry.intersectionRatio || 0) > 0.02));
      },
      { threshold: [0, 0.02, 0.1] },
    );
    io.observe(wrap);

    const tick = (now: number) => {
      if (disposed) return;
      const live = liveRef.current;
      if (live.hidden || live.offscreen) {
        last = now;
        raf = 0;
        return;
      }
      if (!live.reduced && now - last < FRAME_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const dt = live.reduced ? 0 : Math.min(0.08, (now - last) / 1000);
      last = now;
      const target = live.hovering ? hoverMul : 1;
      hoverGate += dt ? (target - hoverGate) * (1 - Math.exp(-dt * HOVER_EASE)) : 0;
      const rate = live.reduced ? 0 : hoverGate;
      spin += rotRate * rate * dt;
      morphT = (morphT + (dt / MORPH_PERIOD) * rate) % 1;
      waveT += WAVE_SPEED * rate * dt;

      const { data, n } = palette(live.dark);
      const w = canvas.width;
      const h = canvas.height;
      const dist = BASE_DISTANCE / (scale / 50);
      const fov = (FOV * Math.PI) / 180;
      const focal = h * 0.5 / Math.tan(fov * 0.5);

      if (live.dark) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(loc.uRes, w, h);
      gl.uniform1f(loc.uFocal, focal);
      gl.uniform1f(loc.uDist, dist);
      gl.uniform1f(loc.uPitchCam, (tiltX * Math.PI) / 180);
      gl.uniform1f(loc.uRoll, (tiltY * Math.PI) / 180);
      gl.uniform1f(loc.uSpin, spin);
      gl.uniform1f(loc.uDot, live.dark ? dotSize : dotSize * 0.92);
      gl.uniform1f(loc.uMorphT, morphT);
      gl.uniform1f(loc.uVoidR, VOID_RATIO * RMAX);
      gl.uniform1f(loc.uEdgeW, (softness / 50) * EDGE_GLOW_AT_50);
      gl.uniform3fv(loc.uCols, data);
      gl.uniform1i(loc.uColN, n);
      gl.uniform1f(loc.uDepthFade, DEPTH_FADE / 100);
      gl.uniform1f(loc.uWaveAmp, (amplitude / 100) * AMPLITUDE_AT_100);
      gl.uniform1f(loc.uWaveFreq, WAVE_FREQUENCY);
      gl.uniform1f(loc.uWaveT, waveT);
      gl.drawArrays(gl.POINTS, 0, count);
      if (live.reduced) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    syncReduced();
    syncTheme();
    syncHidden();
    resume();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
      mediaReduce.removeEventListener("change", syncReduced);
      mediaColor.removeEventListener("change", syncTheme);
      document.removeEventListener("visibilitychange", syncHidden);
      themeObs.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(prog);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      canvas.remove();
    };
  }, []);

  return <div ref={wrapRef} className={className} aria-hidden />;
}
