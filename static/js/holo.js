/* Console holograms: procedurally generated wireframe models (antenna, planets,
   satellites, comets, galaxies, ...) drawn white on a canvas and tinted by one
   multiply layer, so every colour theme applies uniformly. Every model can be
   dragged to rotate. */
"use strict";

const allHolos = new Set();

/* ---------- small 3D toolkit ---------- */
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rotX = ([x, y, z], a) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotZ = ([x, y, z], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
const add = ([x, y, z], [a, b, c]) => [x + a, y + b, z + c];
const mapLines = (lines, fn) => lines.map(line => line.map(fn));

function ring(r, n = 48, y = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; pts.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
  return pts;
}
function sphere(r, lats = 7, lons = 12, center = [0, 0, 0]) {
  const lines = [];
  for (let i = 1; i < lats; i++) {
    const phi = -Math.PI / 2 + i / lats * Math.PI;
    lines.push(ring(Math.cos(phi) * r, 40, Math.sin(phi) * r).map(p => add(p, center)));
  }
  for (let j = 0; j < lons; j++) {
    const theta = j / lons * Math.PI * 2, pts = [];
    for (let i = 0; i <= 24; i++) {
      const phi = -Math.PI / 2 + i / 24 * Math.PI;
      pts.push(add([Math.cos(phi) * Math.cos(theta) * r, Math.sin(phi) * r, Math.cos(phi) * Math.sin(theta) * r], center));
    }
    lines.push(pts);
  }
  return lines;
}
function box(w, h, d, c = [0, 0, 0]) {
  const v = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) v.push(add([x, y, z], c));
  const e = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return e.map(([a, b]) => [v[a], v[b]]);
}
function panel(w, h, cols, rows, c = [0, 0, 0]) {
  const lines = [];
  for (let i = 0; i <= cols; i++) { const x = -w / 2 + w * i / cols; lines.push([add([x, 0, -h / 2], c), add([x, 0, h / 2], c)]); }
  for (let j = 0; j <= rows; j++) { const z = -h / 2 + h * j / rows; lines.push([add([-w / 2, 0, z], c), add([w / 2, 0, z], c)]); }
  return lines;
}
function cylinder(r, len, segs = 10, rings = 4, axis = "x", c = [0, 0, 0]) {
  const lines = [];
  const place = (u, a) => {
    const p = axis === "x" ? [u, Math.cos(a) * r, Math.sin(a) * r] : axis === "y" ? [Math.cos(a) * r, u, Math.sin(a) * r] : [Math.cos(a) * r, Math.sin(a) * r, u];
    return add(p, c);
  };
  for (let i = 0; i <= rings; i++) {
    const u = -len / 2 + len * i / rings, pts = [];
    for (let k = 0; k <= 24; k++) pts.push(place(u, k / 24 * Math.PI * 2));
    lines.push(pts);
  }
  for (let k = 0; k < segs; k++) { const a = k / segs * Math.PI * 2; lines.push([place(-len / 2, a), place(len / 2, a)]); }
  return lines;
}
function icosphere(r, seed, roughness, subdivide = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = p => { const l = Math.hypot(...p); return p.map(c => c / l); };
  verts = verts.map(norm);
  for (let s = 0; s < subdivide; s++) {
    const cache = new Map(), next = [];
    const mid = (a, b) => { const k = a < b ? `${a}_${b}` : `${b}_${a}`; if (!cache.has(k)) { verts.push(norm(verts[a].map((c, i) => (c + verts[b][i]) / 2))); cache.set(k, verts.length - 1); } return cache.get(k); };
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  const rand = rng(seed);
  const bumps = Array.from({ length: 5 }, () => [norm([rand() - .5, rand() - .5, rand() - .5]), (rand() - .3) * roughness]);
  verts = verts.map(v => {
    let k = 1 + (rand() - .5) * roughness * .5;
    for (const [dir, amt] of bumps) k += amt * Math.max(0, v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) ** 3;
    return v.map(c => c * r * k);
  });
  const edges = new Set(), lines = [];
  for (const f of faces) for (let i = 0; i < 3; i++) {
    const a = f[i], b = f[(i + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!edges.has(k)) { edges.add(k); lines.push([verts[a], verts[b]]); }
  }
  return lines;
}

/* ---------- model library ---------- */
const MODELS = {
  ringed: () => {
    const lines = sphere(0.55, 8, 14);
    for (const r of [0.8, 0.92, 1.05, 1.14]) lines.push(ring(r, 64));
    return mapLines(lines, p => rotZ(p, 0.42));
  },
  moon: (seed) => {
    const lines = sphere(0.7, 9, 16);
    const rand = rng(seed);
    for (let k = 0; k < 9; k++) {
      const theta = rand() * Math.PI * 2, phi = (rand() - .5) * 2.4, cr = 0.06 + rand() * 0.12;
      const crater = ring(cr, 18).map(([x, , z]) => {
        let p = [x, 0.7, z];
        p = rotX(p, phi); p = rotY(p, theta);
        const l = Math.hypot(...p); return p.map(c => c / l * 0.7);
      });
      lines.push(crater);
    }
    return lines;
  },
  star: () => {
    const base = sphere(0.42, 6, 10);
    return t => {
      const lines = [...base];
      for (let k = 0; k < 14; k++) {
        const theta = k * 2.399, phi = Math.asin(1 - 2 * (k + .5) / 14);
        const dir = [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
        const len = 0.62 + 0.28 * (0.5 + 0.5 * Math.sin(t * 2.2 + k));
        lines.push([dir.map(c => c * 0.48), dir.map(c => c * len * 1.3)]);
      }
      lines.push(mapLines([ring(0.7 + 0.04 * Math.sin(t * 3), 60)], p => rotX(p, Math.PI / 2))[0]);
      return lines;
    };
  },
  nova: () => {
    const core = sphere(0.22, 5, 8);
    return t => {
      const lines = [...core];
      for (let k = 0; k < 3; k++) {
        const r = 0.3 + ((t * 0.25 + k / 3) % 1) * 0.85;
        lines.push(...mapLines([ring(r, 56)], p => rotX(p, Math.PI / 2)), ...mapLines([ring(r, 56)], p => rotZ(rotX(p, Math.PI / 2), Math.PI / 2)));
      }
      return lines;
    };
  },
  binary: () => t => {
    const a = t * 0.9, lines = [];
    lines.push(...sphere(0.28, 5, 8, [Math.cos(a) * 0.48, 0, Math.sin(a) * 0.48]));
    lines.push(...sphere(0.2, 5, 8, [-Math.cos(a) * 0.65, 0, -Math.sin(a) * 0.65]));
    lines.push(ring(0.48, 60), ring(0.65, 60));
    return lines;
  },
  asteroid: seed => icosphere(0.62, seed, 0.9, 1),
  comet: seed => {
    const nucleus = icosphere(0.18, seed, 0.8, 1).map(l => l.map(p => add(p, [0.55, 0, 0])));
    const rand = rng(seed + 7);
    const tail = [];
    for (let k = 0; k < 16; k++) {
      const spread = (rand() - .5) * 0.5, lift = (rand() - .5) * 0.5, pts = [];
      for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push([0.55 - u * 1.7, spread * u * 1.6 + 0.12 * u * u, lift * u * 1.6]); }
      tail.push(pts);
    }
    const coma = [0.28, 0.36].map(r => ring(r, 40).map(p => add(rotZ(p, Math.PI / 2), [0.55, 0, 0])));
    return [...nucleus, ...tail, ...coma];
  },
  meteor: seed => {
    const rock = icosphere(0.24, seed, 1.1, 1).map(l => l.map(p => add(p, [0.45, 0.3, 0])));
    return t => {
      const rand = rng(seed + Math.floor(t * 6));
      const lines = [...rock];
      for (let k = 0; k < 10; k++) {
        const o = (rand() - .5) * 0.3, z = (rand() - .5) * 0.3, len = 0.6 + rand() * 0.8;
        lines.push([[0.32, 0.22 + o, z], [0.32 - len, 0.22 + o - len * 0.55, z]]);
      }
      return lines;
    };
  },
  galaxy: seed => {
    const lines = [], rand = rng(seed);
    for (let arm = 0; arm < 2; arm++) {
      for (let lane = 0; lane < 3; lane++) {
        const pts = [];
        for (let i = 0; i <= 60; i++) {
          const a = i / 60 * Math.PI * 2.6 + arm * Math.PI + lane * 0.18, r = 0.08 + 0.9 * i / 60;
          pts.push([Math.cos(a) * r, (rand() - .5) * 0.04, Math.sin(a) * r]);
        }
        lines.push(pts);
      }
    }
    lines.push(ring(1.0, 72), ring(0.55, 56));
    lines.push(...sphere(0.14, 4, 8));
    return mapLines(lines, p => rotX(p, 0.5));
  },
  quasar: () => {
    const disk = [ring(0.6, 60), ring(0.42, 50), ring(0.26, 40)];
    const core = sphere(0.12, 4, 8);
    return t => {
      const jets = [];
      for (const dir of [1, -1]) {
        for (let k = 0; k < 8; k++) {
          const a = k / 8 * Math.PI * 2 + t * 1.5;
          jets.push([[0, 0.1 * dir, 0], [Math.cos(a) * 0.12, 1.15 * dir, Math.sin(a) * 0.12]]);
        }
        jets.push(ring(0.12, 20, 1.15 * dir));
      }
      return mapLines([...disk, ...core, ...jets], p => rotX(p, 0.35));
    };
  },
  pulsar: () => {
    const star = sphere(0.24, 5, 8);
    const field = [];
    for (let k = 0; k < 6; k++) {
      const pts = [];
      for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2; pts.push(rotY([Math.sin(a) * 0.62 * Math.abs(Math.sin(a)) + 0.0, Math.cos(a) * 0.62, 0], k / 6 * Math.PI)); }
      field.push(pts);
    }
    return t => {
      const beams = [];
      for (const dir of [1, -1]) {
        for (let k = 0; k < 10; k++) {
          const a = k / 10 * Math.PI * 2;
          beams.push([[0, 0.25 * dir, 0], [Math.cos(a) * 0.3, 1.2 * dir, Math.sin(a) * 0.3]]);
        }
        beams.push(ring(0.3, 30, 1.2 * dir));
      }
      return mapLines([...star, ...field, ...mapLines(beams, p => rotY(rotZ(p, 0.5), t * 4))], p => p);
    };
  },
  nebula: seed => {
    const rand = rng(seed), lines = [];
    for (let k = 0; k < 9; k++) {
      const base = 0.35 + rand() * 0.55, pts = [], phase = rand() * 6, wob = 0.1 + rand() * 0.25;
      for (let i = 0; i <= 60; i++) { const a = i / 60 * Math.PI * 2, r = base * (1 + wob * Math.sin(a * 3 + phase) + 0.08 * Math.sin(a * 7)); pts.push([Math.cos(a) * r, 0, Math.sin(a) * r]); }
      const ax = rand() * Math.PI, az = rand() * Math.PI;
      lines.push(pts.map(p => rotZ(rotX(p, ax), az)));
    }
    for (let k = 0; k < 30; k++) { const p = [(rand() - .5) * 1.4, (rand() - .5) * 1.4, (rand() - .5) * 1.4]; lines.push([p, add(p, [0.02, 0.02, 0])]); }
    return lines;
  },
  cluster: seed => {
    const rand = rng(seed), lines = [];
    for (let k = 0; k < 55; k++) {
      const r = Math.pow(rand(), 1.8) * 0.95, th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1);
      const c = [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], s = 0.025 + rand() * 0.035;
      lines.push([add(c, [-s, 0, 0]), add(c, [s, 0, 0])], [add(c, [0, -s, 0]), add(c, [0, s, 0])], [add(c, [0, 0, -s]), add(c, [0, 0, s])]);
    }
    return lines;
  },
  constellation: seed => {
    const rand = rng(seed), stars = [], lines = [];
    const n = 6 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) stars.push([(rand() - .5) * 1.8, (rand() - .5) * 1.4, (rand() - .5) * 0.3]);
    stars.sort((a, b) => a[0] - b[0]);
    lines.push(stars);
    for (const s of stars) { const r = 0.05; lines.push(ring(r, 12).map(p => add(rotX(p, Math.PI / 2), s))); }
    if (n > 6) lines.push([stars[2], stars[n - 2]]);
    return lines;
  },
  station: () => {
    const lines = [...box(2.0, 0.08, 0.08)];
    for (const x of [-0.85, -0.55, 0.55, 0.85]) for (const z of [-1, 1]) lines.push(...panel(0.22, 0.5, 2, 6, [x, 0, z * 0.32]));
    lines.push(...cylinder(0.09, 0.9, 8, 4, "z", [0, 0, 0]));
    lines.push(...cylinder(0.08, 0.5, 8, 3, "x", [0, 0, 0.5]));
    lines.push(...box(0.25, 0.08, 0.35, [0, -0.06, -0.12]));
    return mapLines(lines, p => rotX(p, 0.35));
  },
  starlink: () => {
    const lines = [...box(0.6, 0.06, 0.38, [-0.2, 0, 0]), ...panel(1.2, 0.36, 10, 3, [0.7, 0, 0])];
    lines.push([[0.1, 0, 0], [0.1, 0, 0]]);
    return mapLines(lines, p => rotX(p, 0.4));
  },
  debris: seed => {
    const rand = rng(seed), parts = [];
    for (let k = 0; k < 7; k++) parts.push({ c: [(rand() - .5) * 1.4, (rand() - .5) * 1.0, (rand() - .5) * 1.0], s: 0.08 + rand() * 0.16, ax: rand() * 6, sp: 0.5 + rand() * 2, seed: seed + k });
    const shapes = parts.map(p => icosphere(p.s, p.seed, 1.6, 0));
    return t => parts.flatMap((p, i) => mapLines(shapes[i], q => add(rotX(rotZ(q, t * p.sp + p.ax), t * p.sp * 0.7), p.c)));
  },
  rocketbody: () => {
    const lines = [...cylinder(0.22, 1.3, 10, 6, "x")];
    for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; lines.push([[0.65, Math.cos(a) * 0.22, Math.sin(a) * 0.22], [0.9, Math.cos(a) * 0.12, Math.sin(a) * 0.12]]); }
    lines.push(ring(0.12, 20).map(p => add(rotZ(p, Math.PI / 2), [0.9, 0, 0])));
    return mapLines(lines, p => rotZ(p, 0.5));
  },
  telescope: () => {
    const lines = [...cylinder(0.22, 1.2, 10, 5, "x"), ...panel(0.25, 0.9, 2, 6, [0.1, 0, 0.55]), ...panel(0.25, 0.9, 2, 6, [0.1, 0, -0.55])];
    lines.push([[-0.6, 0.22, 0], [-0.85, 0.42, 0]]);
    return mapLines(lines, p => rotZ(p, 0.3));
  },
  probe: () => {
    const lines = [];
    for (let i = 1; i <= 5; i++) { const r = i / 5 * 0.6; lines.push(ring(r, 40, 0.18 - (r * r) * 0.5)); }
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2, pts = []; for (let i = 0; i <= 6; i++) { const r = i / 6 * 0.6; pts.push([Math.cos(a) * r, 0.18 - r * r * 0.5, Math.sin(a) * r]); } lines.push(pts); }
    lines.push(...box(0.4, 0.2, 0.4, [0, -0.08, 0]));
    lines.push([[0.2, -0.1, 0], [1.05, -0.2, 0]], [[-0.2, -0.1, 0], [-0.8, -0.35, 0.2]], [[0, -0.18, 0.2], [0, -0.7, 0.4]]);
    lines.push(...cylinder(0.05, 0.25, 6, 2, "x", [-0.85, -0.37, 0.2]));
    return mapLines(lines, p => rotX(p, 0.4));
  },
  signal: () => t => {
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const r = ((t * 0.35 + k / 4) % 1) * 1.1 + 0.05;
      lines.push(mapLines([ring(r, 60)], p => rotX(p, Math.PI / 2))[0]);
    }
    const wave = [];
    for (let i = 0; i <= 120; i++) { const x = -1.1 + i / 120 * 2.2; wave.push([x, Math.sin(x * 9 - t * 6) * 0.22 * Math.exp(-x * x * 1.6), 0]); }
    lines.push(wave);
    lines.push(...cylinder(0.04, 0.5, 6, 2, "y", [0, -0.6, 0]));
    return lines;
  },
};
MODELS.gasgiant = () => sphere(0.75, 10, 16);

/* --- Lookalikes of the game's own console holograms (originally pre-rendered
   video / a flat image), rebuilt as real wireframes so they can be dragged. --- */

/* Parabolic dish along +z: concentric rings + radial ribs, plus focus point. */
function dish(radius, focal, rings = 5, ribs = 16) {
  const lines = [];
  const depth = r => r * r / (4 * focal);
  for (let i = 1; i <= rings; i++) {
    const r = radius * i / rings, pts = [];
    for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; pts.push([Math.cos(a) * r, Math.sin(a) * r, depth(r)]); }
    lines.push(pts);
  }
  for (let k = 0; k < ribs; k++) {
    const a = k / ribs * Math.PI * 2, pts = [];
    for (let i = 0; i <= 8; i++) { const r = radius * i / 8; pts.push([Math.cos(a) * r, Math.sin(a) * r, depth(r)]); }
    lines.push(pts);
  }
  return lines;
}
const rimPoint = (radius, focal, a) => [Math.cos(a) * radius, Math.sin(a) * radius, radius * radius / (4 * focal)];

const scaleLines = (lines, k) => lines.map(line => line.map(([x, y, z]) => [x * k, y * k, z * k]));

MODELS.antenna = () => {
  const R = 0.72, F = 0.42;
  const build = tilt => {
    // dish assembly built facing +z, then tilted up and mounted on the yoke
    const assembly = [...dish(R, F, 8, 24)];
    for (let k = 0; k < 4; k++) {               // feed support struts to the focus
      assembly.push([rimPoint(R, F, k * Math.PI / 2 + Math.PI / 4), [0, 0, F]]);
    }
    assembly.push(...box(0.1, 0.1, 0.12, [0, 0, F]));
    for (let k = 0; k < 12; k++) {              // back truss to a hub behind the dish
      const a = k * Math.PI / 6;
      assembly.push([rimPoint(R * 0.85, F, a), [0, 0, -0.22]]);
      assembly.push([[Math.cos(a) * 0.25, Math.sin(a) * 0.25, 0.02], [0, 0, -0.22]]);
    }
    assembly.push(...cylinder(0.16, 0.14, 10, 2, "z", [0, 0, -0.26]));
    const placed = mapLines(assembly, p => add(rotX(p, tilt), [0, 0.18, 0]));
    const lines = [...placed];
    // yoke arms from the turntable to the elevation axis
    for (const side of [-1, 1]) lines.push([[side * 0.2, -0.22, 0], [side * 0.24, 0.1, 0]], [[side * 0.24, 0.1, 0], add(rotX([side * 0.24, 0, -0.2], tilt), [0, 0.18, 0])]);
    lines.push(...cylinder(0.24, 0.06, 12, 1, "y", [0, -0.22, 0]));     // turntable
    lines.push(...cylinder(0.11, 0.34, 10, 3, "y", [0, -0.42, 0]));     // pedestal
    lines.push(...box(0.95, 0.06, 0.95, [0, -0.62, 0]));                // base frame
    lines.push([[-0.47, -0.62, -0.47], [0.47, -0.62, 0.47]], [[-0.47, -0.62, 0.47], [0.47, -0.62, -0.47]]);
    for (const x of [-0.47, 0.47]) for (const z of [-0.47, 0.47]) lines.push(...box(0.1, 0.12, 0.1, [x, -0.72, z]));
    return lines;
  };
  // slow elevation "nod", like the rotator tracking
  return t => scaleLines(build(-0.55 + 0.12 * Math.sin(t * 0.35)), 1.3);
};

MODELS.planet = () => sphere(1.0, 16, 24);

MODELS.unknown = () => {
  // centre-line of a question mark: hook arc, then a short straight stem
  const path = [];
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI * 1.05 - i / 14 * Math.PI * 1.45;      // from left, over the top, round to lower right
    path.push([Math.cos(a) * 0.34, 0.42 + Math.sin(a) * 0.34, 0]);
  }
  const last = path[path.length - 1];
  for (let i = 1; i <= 3; i++) path.push([last[0] * (1 - i / 3), last[1] - i * 0.09, 0]);
  const half = 0.07, lines = [], sections = [];
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const tx = next[0] - prev[0], ty = next[1] - prev[1], len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;                       // in-plane normal
    const p = path[i];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [p[0] + nx * u * half, p[1] + ny * u * half, v * half]);
    sections.push(corners);
    lines.push([...corners, corners[0]]);                      // segment outline
  }
  for (let c = 0; c < 4; c++) lines.push(sections.map(s => s[c]));   // longitudinal edges
  lines.push(...box(0.16, 0.16, 0.16, [0, -0.42, 0]));          // the dot
  return scaleLines(lines.map(l => l.map(([x, y, z]) => [x, y - 0.12, z])), 1.55);
};

MODELS.satellite = () => {
  // dish on a mast over a four-legged base, after the game's satellite hologram
  const R = 0.6, F = 0.36;
  const assembly = [...dish(R, F, 7, 20)];
  for (let k = 0; k < 4; k++) assembly.push([rimPoint(R, F, k * Math.PI / 2 + Math.PI / 4), [0, 0, F]]);
  assembly.push(...box(0.09, 0.09, 0.12, [0, 0, F]));
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; assembly.push([rimPoint(R * 0.8, F, a), [0, 0, -0.16]]); }
  assembly.push(...cylinder(0.08, 0.12, 8, 2, "z", [0, 0, -0.2]));
  const lines = mapLines(assembly, p => add(rotX(p, -0.75), [0, 0.38, 0]));
  lines.push(...cylinder(0.07, 0.62, 8, 4, "y", [0, -0.12, 0]));            // mast
  lines.push(...cylinder(0.13, 0.08, 10, 1, "y", [0, 0.2, 0]));             // head bearing
  const feet = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => [x, -0.78, z]);
  for (const foot of feet) {
    lines.push([[foot[0] * 0.15, -0.3, foot[2] * 0.15], foot]);              // leg
    lines.push(...box(0.12, 0.08, 0.12, add(foot, [0, -0.04, 0])));          // foot pad
  }
  lines.push([...feet, feet[0]]);                                            // base ring
  lines.push([feet[0], feet[2]], [feet[1], feet[3]]);                        // cross braces
  return scaleLines(lines, 1.2);
};

/* ---------- speed (Options > Display > Hologram spin speed) ---------- */
function holoSpeed() {
  const base = Math.max(0.1, Math.min(2, +prefs.get("display.spinSpeed") || 0.5));
  return document.body.classList.contains("reduce-motion") ? base * 0.5 : base;
}

/* ---------- renderer ---------- */
const activeCanvases = new Set();
let rafRunning = false;
let lastFrame = 0;
function frame(now) {
  rafRunning = activeCanvases.size > 0;
  if (!rafRunning) return;
  // Slow-spinning wireframes look identical at 30 fps and cost half the work.
  if (!document.hidden && now - lastFrame >= 32) {
    lastFrame = now;
    for (const holo of activeCanvases) holo.draw(now / 1000);
  }
  requestAnimationFrame(frame);
}

class Holo {
  constructor(container) {
    this.container = container;
    container.innerHTML = "";
    container.style.isolation = "isolate";
    this.box = document.createElement("div");
    this.box.className = "glowbox";
    this.staticVideo = document.createElement("canvas");   // synthesised TV static for target changes
    this.staticVideo.width = 160; this.staticVideo.height = 120;
    this.staticVideo.className = "static";
    this.tint = document.createElement("div");
    this.tint.className = "tint";
    const sweep = document.createElement("div");
    sweep.className = "sweep";
    container.append(this.box, this.staticVideo, this.tint, sweep);
    this.key = null;
    this.media = null;
    this.mesh = null;
    allHolos.add(this);
  }

  show(model, name = "") {
    const key = `${model}|${name}`;
    if (key === this.key) return;
    this.key = key;
    this.model = model;
    this.name = name;
    this.flashStatic();
    setTimeout(() => this.mount(model, name), 180);
  }

  flashStatic() {
    const canvas = this.staticVideo, ctx = canvas.getContext("2d");
    const image = ctx.createImageData(canvas.width, canvas.height);
    const until = performance.now() + 420;
    canvas.classList.add("on");
    const draw = () => {
      for (let i = 0; i < image.data.length; i += 4) {
        const v = Math.random() * 255;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = v; image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      if (performance.now() < until) requestAnimationFrame(draw); else canvas.classList.remove("on");
    };
    requestAnimationFrame(draw);
  }

  mount(model, name) {
    activeCanvases.delete(this);
    this.box.innerHTML = "";
    this.mesh = null;
    this.container.classList.remove("canvas-holo");
    {
      const canvas = document.createElement("canvas");
      this.media = canvas;
      const builder = MODELS[model] || MODELS.asteroid;
      this.mesh = builder(hashString(name || model));
      this.spin = 0.35 + (hashString(name) % 100) / 400;
      this.enableDrag(canvas);
      this.container.classList.add("canvas-holo");
      activeCanvases.add(this);
      if (!rafRunning) { rafRunning = true; requestAnimationFrame(frame); }
    }
    this.box.append(this.media);
  }

  /* Click-and-drag rotation. While dragging, auto-spin pauses; on release the model eases back to the angle
     it had and resumes spinning from there. */
  enableDrag(canvas) {
    this.drag = { yaw: 0, pitch: 0, active: false, returning: false, x: 0, y: 0 };
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
    canvas.title = "Drag to rotate";
    canvas.addEventListener("pointerdown", e => {
      this.drag.active = true; this.drag.returning = false;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", e => {
      if (!this.drag.active) return;
      this.drag.yaw += (e.clientX - this.drag.x) * 0.012;
      this.drag.pitch = Math.max(-1.4, Math.min(1.4, this.drag.pitch - (e.clientY - this.drag.y) * 0.012));
      this.drag.x = e.clientX; this.drag.y = e.clientY;
    });
    const release = () => {
      if (!this.drag.active) return;
      this.drag.active = false; this.drag.returning = true;
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  draw(t) {
    const canvas = this.media;
    if (!canvas || !canvas.isConnected) { activeCanvases.delete(this); return; }
    if (canvas.offsetParent === null) { this.lastT = null; return; }   // hidden tab: skip without layout reads
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 4) return;
    // VOTV skins: render at low resolution and let CSS scale it up pixelated.
    const ratio = document.body.classList.contains("skin-votv") ? 0.32 : Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(rect.width * ratio), h = Math.round(rect.height * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    // scan sweep band (replaces the CSS animation; this canvas is redrawn anyway)
    if (!document.body.classList.contains("reduce-motion") && !document.body.classList.contains("skin-votv")) {
      const band = h * 0.18, y = ((t % 5) / 5) * (h + band * 2) - band;
      const sweep = ctx.createLinearGradient(0, y, 0, y + band);
      sweep.addColorStop(0, "rgba(255,255,255,0)"); sweep.addColorStop(0.5, "rgba(255,255,255,0.07)"); sweep.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sweep; ctx.fillRect(0, y, w, band);
    }
    // Accumulate a model clock so speed changes apply smoothly (no jump in angle).
    const dt = this.lastT == null ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    const drag = this.drag || { yaw: 0, pitch: 0 };
    if (drag.returning) {
      const k = Math.exp(-dt * 5);
      drag.yaw *= k; drag.pitch *= k;
      if (Math.abs(drag.yaw) < 0.002 && Math.abs(drag.pitch) < 0.002) { drag.yaw = drag.pitch = 0; drag.returning = false; }
    }
    if (!drag.active && !drag.returning) this.clock = (this.clock || 0) + dt * holoSpeed();
    const lines = typeof this.mesh === "function" ? this.mesh(this.clock || 0) : this.mesh;
    const yaw = (this.clock || 0) * this.spin + drag.yaw, pitch = -0.28 + drag.pitch;
    const scale = Math.min(w, h) * 0.36, cx = w / 2, cy = h / 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        let p = rotY(line[i], yaw);
        p = rotX(p, pitch);
        const depth = 3.4 / (3.4 + p[2]);
        const x = cx + p[0] * scale * depth, y = cy - p[1] * scale * depth;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    const width = Math.max(1, 1.25 * Math.max(ratio, 0.8));
    if (document.body.classList.contains("fx-glow") && !document.body.classList.contains("skin-votv")) {
      ctx.strokeStyle = "rgba(255,255,255,0.22)";        // soft halo: one wide faint pass instead of a CSS filter
      ctx.lineWidth = width * 4;
      ctx.stroke();
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = width;
    ctx.stroke();
  }

  destroy() {
    activeCanvases.delete(this);
    this.container.innerHTML = "";
  }
}
