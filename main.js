(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const TAU = Math.PI * 2;
  const PALETTE = [
    [94, 241, 255], // cyan
    [139, 92, 255], // violet
    [255, 94, 200], // pink
  ];
  const STEPS = 24; // colour steps baked into sprites
  const CAM = 6; // camera distance, in sphere radii
  const BASE_SPIN = 0.16; // rad/s
  const RING_SEGS = 140;
  const TRAIL = 1.1; // satellite trail length, rad
  const RINGS = [
    { r: 1.32, rx: 0.22, rz: 0.38, speed: 0.55, sats: 2, color: '94,241,255', alpha: 0.42 },
    { r: 1.55, rx: -0.35, rz: -0.52, speed: -0.32, sats: 1, color: '139,92,255', alpha: 0.36 },
    { r: 1.8, rx: 0.08, rz: 0.12, speed: 0.18, sats: 3, color: '255,94,200', alpha: 0.24 },
  ];

  let W = 0;
  let H = 0;
  let DPR = 1;
  let cx = 0;
  let cy = 0;
  let R = 0;
  let points = [];
  let stars = [];
  let sprites = [];
  let flare = null;
  let time = 0;
  let last = performance.now();
  let pulse = null;

  const view = { spin: 0, vel: 0, mx: 0, my: 0, tmx: 0, tmy: 0 };
  const drag = { active: false, moved: false, x: 0, y: 0, lastX: 0, lastT: 0, v: 0 };

  // current rotation (spin about Y, tilt about X, roll about Z)
  let cS = 1;
  let sS = 0;
  let cT = 1;
  let sT = 0;
  let cR = 1;
  let sR = 0;
  const P = { x: 0, y: 0, z: 0, s: 1, r2: 0 };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function paletteAt(t) {
    const s = clamp(t, 0, 1) * (PALETTE.length - 1);
    const i = Math.min(Math.floor(s), PALETTE.length - 2);
    const f = s - i;
    const a = PALETTE[i];
    const b = PALETTE[i + 1];
    return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
  }

  function glowSprite([r, g, b], size = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const h = size / 2;
    const grad = x.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.12, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.34, `rgba(${r},${g},${b},0.32)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grad;
    x.fillRect(0, 0, size, size);
    return c;
  }

  // ---------- scene setup

  function buildSprites() {
    sprites = [];
    for (let i = 0; i < STEPS; i++) sprites.push(glowSprite(paletteAt(i / (STEPS - 1))));
    flare = glowSprite([215, 245, 255]);
  }

  // evenly spread points on a unit sphere (Fibonacci lattice)
  function buildSphere(n) {
    points = new Array(n);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      const c = clamp((1 - y) / 2 + (Math.random() - 0.5) * 0.18, 0, 1);
      points[i] = {
        x: Math.cos(th) * r,
        y,
        z: Math.sin(th) * r,
        c: Math.round(c * (STEPS - 1)),
        ph: Math.random() * TAU,
        sz: 0.7 + Math.random() * 0.6,
      };
    }
  }

  function buildStars(n) {
    stars = new Array(n);
    for (let i = 0; i < n; i++) {
      stars[i] = {
        x: Math.random(),
        y: Math.random(),
        z: Math.random() ** 2,
        r: Math.random() < 0.9 ? 1 : 1.6,
        a: 0.25 + Math.random() * 0.55,
        sp: 0.6 + Math.random() * 1.8,
        tw: Math.random() * TAU,
      };
    }
  }

  // ring points are static in the ring's own frame, so bake them once
  function buildRings() {
    for (const ring of RINGS) {
      ring.cx = Math.cos(ring.rx);
      ring.sx = Math.sin(ring.rx);
      ring.cz = Math.cos(ring.rz);
      ring.sz = Math.sin(ring.rz);
      ring.pts = new Float32Array((RING_SEGS + 1) * 3);
      const out = { x: 0, y: 0, z: 0 };
      for (let i = 0; i <= RING_SEGS; i++) {
        ringLocal(ring, (i / RING_SEGS) * TAU, out);
        ring.pts[i * 3] = out.x;
        ring.pts[i * 3 + 1] = out.y;
        ring.pts[i * 3 + 2] = out.z;
      }
      ring.phases = Array.from({ length: ring.sats }, (_, k) => (k / ring.sats) * TAU + Math.random());
    }
  }

  function ringLocal(ring, a, out) {
    const x = Math.cos(a) * ring.r;
    const z = Math.sin(a) * ring.r;
    const y1 = -z * ring.sx; // rotate about X (y = 0)
    const z1 = z * ring.cx;
    out.x = x * ring.cz - y1 * ring.sz; // rotate about Z
    out.y = x * ring.sz + y1 * ring.cz;
    out.z = z1;
    return out;
  }

  function layout() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const mobile = W < 720;
    cx = W / 2;
    cy = mobile ? H * 0.34 : H * 0.45;
    R = mobile ? Math.min(W * 0.32, H * 0.19) : Math.min(W * 0.24, H * 0.27);

    const n = mobile ? 900 : W < 1280 ? 1300 : 1700;
    if (n !== points.length) buildSphere(n);
    buildStars(Math.round((W * H) / 9000));
  }

  // ---------- projection

  function project(x, y, z, withSpin) {
    let x1 = x;
    let z1 = z;
    if (withSpin) {
      x1 = x * cS + z * sS;
      z1 = -x * sS + z * cS;
    }
    const y2 = y * cT - z1 * sT;
    const z2 = y * sT + z1 * cT;
    const x3 = x1 * cR - y2 * sR;
    const y3 = x1 * sR + y2 * cR;
    const s = CAM / (CAM - z2);
    P.x = cx + x3 * R * s;
    P.y = cy - y3 * R * s;
    P.z = z2;
    P.s = s;
    P.r2 = x3 * x3 + y3 * y3;
    return P;
  }

  // true when a point sits behind the globe's silhouette
  const occluded = (p) => p.z < 0 && Math.sqrt(p.r2) * p.s < 1;

  // ---------- drawing

  function drawStars() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#cfd8ff';
    for (const s of stars) {
      const x = s.x * W - view.mx * s.z * 26;
      let y = (s.y * H - time * (2 + s.z * 6) - view.my * s.z * 26) % H;
      if (y < 0) y += H;
      ctx.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(time * s.sp + s.tw));
      ctx.fillRect(x, y, s.r, s.r);
    }
  }

  function drawCore() {
    const breathe = 0.85 + 0.15 * Math.sin(time * 1.2);
    ctx.globalAlpha = 1;

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
    g.addColorStop(0, `rgba(139,92,255,${0.24 * breathe})`);
    g.addColorStop(0.35, `rgba(94,120,255,${0.11 * breathe})`);
    g.addColorStop(0.7, 'rgba(94,241,255,0.03)');
    g.addColorStop(1, 'rgba(94,241,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);

    const rim = ctx.createRadialGradient(cx, cy, R * 0.86, cx, cy, R * 1.14);
    rim.addColorStop(0, 'rgba(94,241,255,0)');
    rim.addColorStop(0.55, `rgba(94,241,255,${0.1 * breathe})`);
    rim.addColorStop(1, 'rgba(94,241,255,0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.14, 0, TAU);
    ctx.fill();
  }

  function drawRings() {
    const out = { x: 0, y: 0, z: 0 };
    ctx.lineWidth = 1;

    for (const ring of RINGS) {
      const sats = ring.phases.map((p) => (((p + time * ring.speed) % TAU) + TAU) % TAU);
      ctx.strokeStyle = `rgb(${ring.color})`;

      let lx = 0;
      let ly = 0;
      for (let i = 0; i <= RING_SEGS; i++) {
        const k = i * 3;
        const p = project(ring.pts[k], ring.pts[k + 1], ring.pts[k + 2], false);
        if (i > 0) {
          const ai = (i / RING_SEGS) * TAU;
          let boost = 0;
          for (const sa of sats) {
            let d = ring.speed > 0 ? sa - ai : ai - sa;
            d = ((d % TAU) + TAU) % TAU;
            if (d < TRAIL) boost += (1 - d / TRAIL) ** 2;
          }
          const depth = (p.z / ring.r + 1) / 2;
          const occ = occluded(p) ? 0.1 : 1;
          ctx.globalAlpha = Math.min(1, (ring.alpha * (0.2 + 0.8 * depth) + boost * 0.85) * occ);
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        lx = p.x;
        ly = p.y;
      }

      // satellite heads
      for (const sa of sats) {
        ringLocal(ring, sa, out);
        const p = project(out.x, out.y, out.z, false);
        if (occluded(p)) continue;
        const size = Math.max(10, R * 0.09) * p.s;
        ctx.globalAlpha = 0.95;
        ctx.drawImage(flare, p.x - size / 2, p.y - size / 2, size, size);
      }
    }
  }

  function drawSphere() {
    const base = Math.max(1.1, R / 105);
    const scanY = Math.sin(time * 0.55) * 1.05;
    const pAge = pulse ? time - pulse.t : 0;
    const pE = pulse ? Math.exp(-pAge * 2.4) : 0;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];

      const x1 = pt.x * cS + pt.z * sS;
      const z1 = -pt.x * sS + pt.z * cS;
      const y2 = pt.y * cT - z1 * sT;
      const z2 = pt.y * sT + z1 * cT;
      const x3 = x1 * cR - y2 * sR;
      const y3 = x1 * sR + y2 * cR;

      // surface "breathing" + click ripple travelling from front to back
      let d =
        1 +
        0.032 * Math.sin(pt.y * 6 + time * 1.3 + pt.ph * 0.25) +
        0.018 * Math.sin(pt.x * 5 - time * 0.9);
      if (pE > 0.002) d += pE * 0.1 * Math.sin(pAge * 10 - (1 - z2) * 4);

      const s = CAM / (CAM - z2 * d);
      const sx = cx + x3 * d * R * s;
      const sy = cy - y3 * d * R * s;
      const depth = (z2 + 1) * 0.5;
      const size = base * pt.sz * s * (2.6 + 3.4 * depth);

      ctx.globalAlpha = (0.08 + 0.92 * depth * depth) * (0.78 + 0.22 * Math.sin(time * 2.1 + pt.ph));
      ctx.drawImage(sprites[pt.c], sx - size / 2, sy - size / 2, size, size);

      // scan band sweeping across latitudes
      const sd = (pt.y - scanY) / 0.045;
      if (sd > -2.2 && sd < 2.2) {
        const b = Math.exp(-sd * sd) * (0.25 + 0.75 * depth);
        if (b > 0.04) {
          const fs = size * 1.6;
          ctx.globalAlpha = b * 0.85;
          ctx.drawImage(flare, sx - fs / 2, sy - fs / 2, fs, fs);
        }
      }
    }
  }

  function drawHud() {
    const r1 = R * 1.12;
    const r2 = R * 1.2;

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(160,180,255,0.12)';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    const a0 = time * 0.25;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(94,241,255,0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, r1, a0, a0 + 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r1, a0 + Math.PI, a0 + Math.PI + 0.35);
    ctx.stroke();

    const b0 = -time * 0.12 + 0.6;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(200,210,255,0.22)';
    ctx.beginPath();
    for (let i = 0; i < 40; i++) {
      const a = b0 + i * 0.035;
      const len = i % 5 === 0 ? 8 : 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.moveTo(cx + ca * r2, cy + sa * r2);
      ctx.lineTo(cx + ca * (r2 + len), cy + sa * (r2 + len));
    }
    ctx.stroke();
  }

  function drawPulse() {
    if (!pulse) return;
    const age = time - pulse.t;
    if (age > 2.2) {
      pulse = null;
      return;
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgb(94,241,255)';
    for (const delay of [0, 0.25]) {
      const k = (age - delay) / 1.8;
      if (k <= 0 || k >= 1) continue;
      ctx.globalAlpha = (1 - k) ** 2 * 0.55;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1.02 + k * 2.2), 0, TAU);
      ctx.stroke();
    }
  }

  // ---------- loop

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const motion = reduceMotion.matches ? 0.25 : 1;
    time += dt * motion;

    const ease = Math.min(1, dt * 3);
    view.mx += (view.tmx - view.mx) * ease;
    view.my += (view.tmy - view.my) * ease;
    if (!drag.active) {
      view.spin += (BASE_SPIN * motion + view.vel) * dt;
      view.vel *= Math.exp(-dt * 1.6);
    }

    const tilt = 0.36 + view.my * 0.22;
    const roll = -0.08 - view.mx * 0.12;
    cS = Math.cos(view.spin);
    sS = Math.sin(view.spin);
    cT = Math.cos(tilt);
    sT = Math.sin(tilt);
    cR = Math.cos(roll);
    sR = Math.sin(roll);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    drawStars();
    ctx.globalCompositeOperation = 'lighter';
    drawCore();
    drawRings();
    drawSphere();
    drawHud();
    drawPulse();

    requestAnimationFrame(frame);
  }

  // ---------- interaction

  window.addEventListener('pointerdown', (e) => {
    // footer links (Privacy / Terms) should just navigate, not start a drag
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('a'))) return;
    drag.active = true;
    drag.moved = false;
    drag.x = drag.lastX = e.clientX;
    drag.y = e.clientY;
    drag.lastT = performance.now();
    drag.v = 0;
    view.vel = 0;
    document.body.classList.add('is-dragging');
  });

  window.addEventListener(
    'pointermove',
    (e) => {
      view.tmx = clamp((e.clientX / W) * 2 - 1, -1, 1);
      view.tmy = clamp((e.clientY / H) * 2 - 1, -1, 1);
      if (!drag.active) return;

      const now = performance.now();
      const da = (e.clientX - drag.lastX) * 0.006;
      const dts = Math.max(8, now - drag.lastT) / 1000;
      view.spin += da;
      drag.v = drag.v * 0.6 + (da / dts) * 0.4;
      drag.lastX = e.clientX;
      drag.lastT = now;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
    },
    { passive: true }
  );

  const endDrag = (e) => {
    if (!drag.active) return;
    drag.active = false;
    document.body.classList.remove('is-dragging');
    if (drag.moved) {
      // keep the throw only if the pointer was still moving on release
      const idle = performance.now() - drag.lastT > 90;
      view.vel = idle ? 0 : clamp(drag.v, -7, 7);
    } else if (e.type === 'pointerup') {
      pulse = { t: time };
    }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  window.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) {
      view.tmx = 0;
      view.tmy = 0;
    }
  });

  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      layout();
    });
  });

  // ---------- fake telemetry in the footer

  const tSync = document.getElementById('t-sync');
  const tNodes = document.getElementById('t-nodes');
  const tLat = document.getElementById('t-lat');
  let nodes = 12480;
  setInterval(() => {
    if (document.hidden) return;
    nodes += Math.floor(Math.random() * 7);
    tSync.textContent = `${(99.7 + Math.random() * 0.25).toFixed(2)}%`;
    tNodes.textContent = nodes.toLocaleString('en-US');
    tLat.textContent = `${3 + Math.floor(Math.random() * 4)}ms`;
  }, 1400);

  // ---------- start

  buildSprites();
  buildRings();
  layout();
  requestAnimationFrame((now) => {
    last = now;
    canvas.classList.add('ready');
    frame(now);
  });
})();
