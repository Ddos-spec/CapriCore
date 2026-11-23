// SPDX-License-Identifier: GPL-3.0-only
// Avant-garde demoscene + Studio TRIGGER Edgerunners compositor for Capri-RS.
// Zero idle overhead & zero idle VRAM: frees full-monitor backing store immediately after animations finish.
import {
  draw as drawTeleport,
  prepareTeleportMotion,
  frames as teleportTotalFrames,
} from './avatar-teleport-motion.mjs';
import {
  prepareSandevistan,
  sandevistanStamps,
  drawSandevistan,
} from './sandevistan-motion.mjs';
import { drawStartupIntro } from './startup-intro-motion.mjs';

const DEFAULT_ANCHOR = { x: 0.5, y: 1166 / 1254 };

function clamp(v, a = 0, b = 1) {
  return Math.max(a, Math.min(b, v));
}

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t));
}

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function actorBoxToAnchorPoint(box) {
  const size = box.size ?? 320;
  return {
    x: box.x + size * DEFAULT_ANCHOR.x,
    y: box.y + size * DEFAULT_ANCHOR.y,
    scale: size,
    focus: { x: box.x + size * 0.5, y: box.y + size * 0.45 },
  };
}

function actorBoxCenter(box) {
  const size = box.size ?? 320;
  return { x: box.x + size * 0.5, y: box.y + size * 0.48 };
}

function drawLichtenbergPath(ctx, pts, width, color) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineWidth = width;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'bevel';
  ctx.strokeStyle = color;
  ctx.stroke();
}

function subdivideBolt(x1, y1, x2, y2, depth, jitter, rand) {
  let pts = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  let disp = jitter;
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const offset = (rand() - 0.5) * 2 * disp;
      next.push({ x: mx + nx * offset, y: my + ny * offset });
      next.push(b);
    }
    pts = next;
    disp *= 0.56;
  }
  return pts;
}

/** Recursive midpoint-displacement fractal lightning rift in 3 chromatic passes (#00f0ff / #ff003d / #ffffff). */
export function drawLichtenbergRift(ctx, x1, y1, x2, y2, seed, jitter = 52) {
  const rand = seededRng(seed);
  const main = subdivideBolt(x1, y1, x2, y2, 4, jitter, rand);
  const forks = [];
  for (let f = 0; f < 4; f++) {
    const idx = Math.max(1, Math.min(main.length - 2, Math.floor((0.18 + f * 0.21) * main.length)));
    const p = main[idx];
    const ang = Math.atan2(y2 - y1, x2 - x1) + (f % 2 === 0 ? 1 : -1) * (0.45 + rand() * 0.65);
    const reach = 75 + rand() * 140;
    forks.push(subdivideBolt(p.x, p.y, p.x + Math.cos(ang) * reach, p.y + Math.sin(ang) * reach, 3, jitter * 0.4, rand));
  }

  ctx.save();
  ctx.translate(-4, 0);
  drawLichtenbergPath(ctx, main, 4.5, 'rgba(0, 240, 255, 0.82)');
  for (const fk of forks) drawLichtenbergPath(ctx, fk, 2.0, 'rgba(0, 240, 255, 0.65)');

  ctx.translate(8, 0);
  drawLichtenbergPath(ctx, main, 5.2, 'rgba(255, 0, 61, 0.92)');
  for (const fk of forks) drawLichtenbergPath(ctx, fk, 2.4, 'rgba(255, 0, 61, 0.78)');

  ctx.translate(-4, 0);
  drawLichtenbergPath(ctx, main, 2.1, 'rgba(255, 250, 252, 0.96)');
  for (const fk of forks) drawLichtenbergPath(ctx, fk, 1.1, 'rgba(255, 255, 255, 0.85)');
  ctx.restore();
}

/** Asymmetric Studio TRIGGER graphic anime impact star burst (10 tapered needles + 45deg slash, zero halo). */
export function drawTriggerImpactStar(ctx, cx, cy, radius, age, seed = 77) {
  if (age >= 1) return;
  const rand = seededRng(seed);
  const scale = age < 0.25 ? 0.55 + age * 2.2 : 1.1 - (age - 0.25) * 0.5;
  const alpha = age < 0.35 ? 1 : Math.max(0, 1 - (age - 0.35) / 0.65);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = alpha;

  // Stark 45deg graphic slash needle
  const slashLen = radius * 1.45 * scale;
  ctx.save();
  ctx.rotate(-0.78);
  ctx.beginPath();
  ctx.moveTo(-slashLen, 0);
  ctx.lineTo(0, -radius * 0.08 * (1 - age));
  ctx.lineTo(slashLen, 0);
  ctx.lineTo(0, radius * 0.08 * (1 - age));
  ctx.closePath();
  ctx.fillStyle = age < 0.22 ? '#ffffff' : '#ff003d';
  ctx.fill();
  ctx.restore();

  // 10 sharp tapered asymmetric needles
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + (rand() - 0.5) * 0.28;
    const outer = radius * (0.48 + (i % 3 === 0 ? 0.68 : rand() * 0.42)) * scale;
    const inner = radius * (0.09 + rand() * 0.08);
    const halfBase = radius * (0.032 + rand() * 0.028) * (1 - age * 0.7);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const nx = -sin;
    const ny = cos;

    ctx.beginPath();
    ctx.moveTo(cos * outer, sin * outer);
    ctx.lineTo(cos * inner + nx * halfBase, sin * inner + ny * halfBase);
    ctx.lineTo(cos * inner * 0.4, sin * inner * 0.4);
    ctx.lineTo(cos * inner - nx * halfBase, sin * inner - ny * halfBase);
    ctx.closePath();
    ctx.fillStyle = i % 3 === 0 ? '#ffffff' : i % 3 === 1 ? '#ff003d' : '#120309';
    ctx.fill();
  }
  ctx.restore();
}

export class RedBreachCompositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.activeJobs = [];
    this.particles = [];
    this.raf = 0;
    this.boundTick = this.tick.bind(this);
    this.width = Math.max(1, Math.floor(window.innerWidth));
    this.height = Math.max(1, Math.floor(window.innerHeight));
    this.canvas.width = 1;
    this.canvas.height = 1;
    window.addEventListener('resize', () => {
      if (this.raf) this.resize();
    });
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.width = w;
    this.height = h;
    const targetW = Math.floor(w * this.dpr);
    const targetH = Math.floor(h * this.dpr);
    if (this.canvas.width !== targetW) this.canvas.width = targetW;
    if (this.canvas.height !== targetH) this.canvas.height = targetH;
  }

  ensureRunning() {
    this.resize();
    if (!this.raf) {
      this.raf = requestAnimationFrame(this.boundTick);
    }
  }

  triggerImpactStar(x, y, radius = 150) {
    this.particles.push({
      kind: 'impact_star',
      x,
      y,
      radius,
      seed: (Date.now() ^ Math.floor(Math.random() * 9999)) >>> 0,
      start: performance.now(),
      duration: 145,
    });
    this.ensureRunning();
  }

  spawnGlassShards(cx, cy, count = 12, radius = 280) {
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.45;
      const spd = (0.35 + Math.random() * 0.85) * radius;
      const w = 10 + Math.random() * 20;
      const h = 6 + Math.random() * 14;
      this.particles.push({
        kind: 'glass',
        x: cx + (Math.random() - 0.5) * 90,
        y: cy + (Math.random() - 0.5) * 50,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 4.5,
        w,
        h,
        color: i % 3 === 0 ? 'rgba(255, 255, 255, 0.72)' : i % 2 === 0 ? 'rgba(255, 0, 61, 0.64)' : 'rgba(0, 240, 255, 0.52)',
        start,
        duration: 280 + Math.random() * 180,
      });
    }
    this.ensureRunning();
  }

  spawnImpactBurst(x, y, { color = '#ff003d', count = 14, radius = 96 } = {}) {
    const start = performance.now();
    this.particles.push({
      kind: 'ring',
      x,
      y,
      color,
      radius,
      start,
      duration: 360,
    });
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const spd = (0.45 + Math.random() * 0.75) * radius;
      const size = 5 + Math.random() * 11;
      this.particles.push({
        kind: 'shard',
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        rot: ang,
        len: size * (1.8 + Math.random() * 1.4),
        wid: size * 0.42,
        color: i % 4 === 0 ? '#ffffff' : i % 3 === 0 ? '#00f0ff' : color,
        start,
        duration: 240 + Math.random() * 200,
      });
    }
    this.ensureRunning();
  }

  spawnMicroSlash(x, y, angleRad = -0.42, color = '#ff003d') {
    this.particles.push({
      kind: 'slash',
      x,
      y,
      angle: angleRad,
      color,
      len: 160 + Math.random() * 75,
      start: performance.now(),
      duration: 165,
    });
    this.ensureRunning();
  }

  playRedBreachSummon({ from, to, spriteImg, arrivalImg, style = 'lightning', onArrive } = {}) {
    const start = performance.now();
    const fromPt = actorBoxToAnchorPoint(from || to);
    const toPt = actorBoxToAnchorPoint(to);
    const targetCenter = actorBoxCenter(to);
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xfffffff)) >>> 0;

    let motion = null;
    let sandi = null;
    let sandiStamps = null;
    if (style === 'sandevistan' && spriteImg) {
      sandi = prepareSandevistan({
        from: fromPt,
        to: toPt,
        scale: toPt.scale,
        effects: {
          sandevistanCopies: 14,
          sandevistanHoldMs: 420,
          sandevistanHue: 345,
          sandevistanHueStep: 14,
          sandevistanTint: 62,
        },
      });
      sandiStamps = sandevistanStamps(spriteImg, sandi);
    } else {
      motion = prepareTeleportMotion({
        from: fromPt,
        to: toPt,
        seed,
        scale: toPt.scale,
        bounds: { width: this.width, height: this.height },
      });
    }

    this.spawnGlassShards(targetCenter.x, targetCenter.y, 12, 310);

    let arrived = false;
    const job = {
      start,
      duration: 740,
      render: (ctx, now) => {
        const elapsed = now - start;
        const w = this.width;
        const h = this.height;

        // 0-260ms: Studio TRIGGER Breach Flash + fractal Lichtenberg rift + chromatic bars + kinetic stamp
        if (elapsed < 260) {
          const stepIdx = Math.floor(elapsed / 42);
          const flashAlpha = stepIdx === 0 ? 0.42 : stepIdx === 1 ? 0.28 : stepIdx === 2 ? 0.16 : 0.06;
          ctx.save();
          const grad = ctx.createRadialGradient(
            targetCenter.x,
            targetCenter.y,
            h * 0.12,
            targetCenter.x,
            targetCenter.y,
            Math.max(w, h) * 0.85,
          );
          grad.addColorStop(0, `rgba(255, 0, 51, ${(flashAlpha * 0.48).toFixed(3)})`);
          grad.addColorStop(0.55, `rgba(220, 0, 44, ${(flashAlpha * 0.78).toFixed(3)})`);
          grad.addColorStop(1, `rgba(110, 0, 24, ${(flashAlpha * 1.12).toFixed(3)})`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);

          // Full-screen recursive fractal Lichtenberg rift across target
          const riftP = easeOutExpo(elapsed / 95);
          const rx1 = targetCenter.x - w * 0.62 * riftP;
          const ry1 = targetCenter.y + h * 0.3 * riftP;
          const rx2 = targetCenter.x + w * 0.62 * riftP;
          const ry2 = targetCenter.y - h * 0.3 * riftP;
          drawLichtenbergRift(ctx, rx1, ry1, rx2, ry2, seed + stepIdx * 19, 54);

          // Horizontal chromatic scanline tears
          for (let b = 0; b < 6; b++) {
            const by = ((seed * (b + 3)) % Math.max(200, h - 80)) + 20;
            const bh = 2 + ((seed >> b) % 6);
            const bw = w * (0.28 + ((b * 17) % 50) / 100);
            const bx = ((b % 2 === 0 ? 1 : -1) * elapsed * 1.5 + w * 0.28) % w;
            ctx.fillStyle = b % 2 === 0 ? 'rgba(255, 0, 61, 0.76)' : 'rgba(0, 240, 255, 0.58)';
            ctx.fillRect(bx, by, bw, bh);
          }

          if (elapsed < 225) {
            ctx.translate(targetCenter.x, targetCenter.y - 118);
            ctx.rotate(-0.22);
            ctx.font = '900 20px "Consolas", "Courier New", monospace';
            ctx.textAlign = 'center';
            const fade = clamp(1 - elapsed / 225);
            ctx.fillStyle = `rgba(0, 240, 255, ${(fade * 0.88).toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', -4, -2);
            ctx.fillStyle = `rgba(255, 0, 61, ${(fade * 0.96).toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', 4, 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${fade.toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', 0, 0);
          }
          ctx.restore();
        }

        if (elapsed >= 60 && elapsed <= 460) {
          const p = (elapsed - 60) / 400;
          const alpha = Math.sin(p * Math.PI) * 0.62;
          ctx.save();
          ctx.strokeStyle = `rgba(255, 0, 61, ${alpha.toFixed(2)})`;
          ctx.lineWidth = 2.2;
          for (let i = 0; i < 18; i++) {
            const ang = ((seed + i * 97) % 360) * (Math.PI / 180);
            const inner = 70 + (1 - p) * 260;
            const outer = inner + 150 + (i % 3) * 85;
            ctx.beginPath();
            ctx.moveTo(targetCenter.x + Math.cos(ang) * inner, targetCenter.y + Math.sin(ang) * inner);
            ctx.lineTo(targetCenter.x + Math.cos(ang) * outer, targetCenter.y + Math.sin(ang) * outer);
            ctx.stroke();
          }
          ctx.restore();
        }

        if (elapsed >= 75) {
          const flightElapsed = elapsed - 75;
          if (style === 'sandevistan' && sandi && sandiStamps) {
            drawSandevistan(ctx, sandi, flightElapsed * 1.15, sandiStamps, arrivalImg || spriteImg);
          } else if (motion) {
            const frame = Math.min(teleportTotalFrames - 1, (flightElapsed / 540) * (teleportTotalFrames - 1));
            const drawCapri = (pt, tint = 0) => {
              const img = arrivalImg || spriteImg;
              if (!img) return;
              const s = pt.scale ?? toPt.scale;
              const dx = pt.x - DEFAULT_ANCHOR.x * s;
              const dy = pt.y - DEFAULT_ANCHOR.y * s;
              ctx.save();
              ctx.drawImage(img, dx, dy, s, s);
              if (tint > 0) {
                ctx.globalCompositeOperation = 'source-atop';
                ctx.globalAlpha *= tint;
                ctx.fillStyle = '#ff003d';
                ctx.fillRect(dx, dy, s, s);
              }
              ctx.restore();
            };
            drawTeleport(ctx, {
              frame,
              from: fromPt,
              to: toPt,
              seed,
              scale: toPt.scale,
              bounds: { width: w, height: h },
              motion,
              drawCapri,
            });
          }
        }

        if (!arrived && elapsed >= 520) {
          arrived = true;
          this.triggerImpactStar(targetCenter.x, targetCenter.y, (to.size ?? 320) * 0.56);
          this.spawnImpactBurst(targetCenter.x, targetCenter.y + 26, {
            color: '#ff003d',
            count: 18,
            radius: 150,
          });
          onArrive?.();
        }
      },
    };
    this.activeJobs.push(job);
    this.ensureRunning();
  }

  playTeleportFlight({ from, to, spriteImg, arrivalImg, style = 'lightning', onArrive } = {}) {
    const start = performance.now();
    const fromPt = actorBoxToAnchorPoint(from);
    const toPt = actorBoxToAnchorPoint(to);
    const targetCenter = actorBoxCenter(to);
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xfffffff)) >>> 0;

    let motion = null;
    let sandi = null;
    let sandiStamps = null;
    if (style === 'sandevistan' && spriteImg) {
      sandi = prepareSandevistan({
        from: fromPt,
        to: toPt,
        scale: toPt.scale,
        effects: {
          sandevistanCopies: 12,
          sandevistanHoldMs: 420,
          sandevistanHue: 170,
          sandevistanHueStep: 12,
          sandevistanTint: 58,
        },
      });
      sandiStamps = sandevistanStamps(spriteImg, sandi);
    } else {
      motion = prepareTeleportMotion({
        from: fromPt,
        to: toPt,
        seed,
        scale: toPt.scale,
        bounds: { width: this.width, height: this.height },
      });
    }

    let arrived = false;
    const duration = style === 'sandevistan' ? 680 : 580;
    const job = {
      start,
      duration,
      render: (ctx, now) => {
        const elapsed = now - start;
        if (style === 'sandevistan' && sandi && sandiStamps) {
          drawSandevistan(ctx, sandi, elapsed * 1.15, sandiStamps, arrivalImg || spriteImg);
        } else if (motion) {
          const frame = Math.min(teleportTotalFrames - 1, (elapsed / 500) * (teleportTotalFrames - 1));
          const drawCapri = (pt, tint = 0) => {
            const img = arrivalImg || spriteImg;
            if (!img) return;
            const s = pt.scale ?? toPt.scale;
            const dx = pt.x - DEFAULT_ANCHOR.x * s;
            const dy = pt.y - DEFAULT_ANCHOR.y * s;
            ctx.save();
            ctx.drawImage(img, dx, dy, s, s);
            if (tint > 0) {
              ctx.globalCompositeOperation = 'source-atop';
              ctx.globalAlpha *= tint;
              ctx.fillStyle = '#ff003d';
              ctx.fillRect(dx, dy, s, s);
            }
            ctx.restore();
          };
          drawTeleport(ctx, {
            frame,
            from: fromPt,
            to: toPt,
            seed,
            scale: toPt.scale,
            bounds: { width: this.width, height: this.height },
            motion,
            drawCapri,
          });
        }
        if (!arrived && elapsed >= duration * 0.78) {
          arrived = true;
          this.triggerImpactStar(targetCenter.x, targetCenter.y + 10, (to.size ?? 320) * 0.42);
          this.spawnImpactBurst(targetCenter.x, targetCenter.y + 38, {
            color: style === 'sandevistan' ? '#00f0ff' : '#ff003d',
            count: 10,
            radius: 85,
          });
          onArrive?.();
        }
      },
    };
    this.activeJobs.push(job);
    this.ensureRunning();
  }

  playStartupIntroFx({ rect, introImages, onDone } = {}) {
    const start = performance.now();
    const duration = 2400;
    let doneCalled = false;
    const finish = () => {
      if (!doneCalled) {
        doneCalled = true;
        onDone?.();
      }
    };
    const job = {
      start,
      duration,
      render: (ctx, now) => {
        const elapsed = now - start;
        if (elapsed < 240) {
          const a = (1 - elapsed / 240) * 0.28;
          const grad = ctx.createRadialGradient(
            rect.x + rect.width * 0.5,
            rect.y + rect.height * 0.5,
            this.height * 0.2,
            rect.x + rect.width * 0.5,
            rect.y + rect.height * 0.5,
            Math.max(this.width, this.height) * 0.85,
          );
          grad.addColorStop(0, 'rgba(255, 0, 51, 0)');
          grad.addColorStop(1, `rgba(255, 0, 51, ${a.toFixed(3)})`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, this.width, this.height);
        }

        drawStartupIntro(ctx, {
          time: elapsed,
          width: this.width,
          height: this.height,
          images: introImages,
          rect,
          seed: 1337,
          durationMs: duration,
        });

        if (elapsed >= duration - 32) finish();
      },
      onFinish: finish,
    };
    this.activeJobs.push(job);
    this.ensureRunning();
  }

  tick(now) {
    this.raf = 0;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const nextJobs = [];
    for (const job of this.activeJobs) {
      if (now - job.start < job.duration) {
        job.render(ctx, now);
        nextJobs.push(job);
      } else {
        job.onFinish?.();
      }
    }
    this.activeJobs = nextJobs;

    const nextParticles = [];
    for (const p of this.particles) {
      const age = (now - p.start) / p.duration;
      if (age >= 1) continue;
      nextParticles.push(p);
      ctx.save();
      if (p.kind === 'impact_star') {
        drawTriggerImpactStar(ctx, p.x, p.y, p.radius, age, p.seed);
      } else if (p.kind === 'glass') {
        const dist = easeOutExpo(age);
        const px = p.x + p.vx * dist;
        const py = p.y + p.vy * dist;
        ctx.globalAlpha = 1 - age * age;
        ctx.translate(px, py);
        ctx.rotate(p.rot + p.vrot * age);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-p.w * 0.5, -p.h * 0.4);
        ctx.lineTo(p.w * 0.6, -p.h * 0.15);
        ctx.lineTo(p.w * 0.35, p.h * 0.55);
        ctx.lineTo(-p.w * 0.45, p.h * 0.25);
        ctx.closePath();
        ctx.fill();
      } else if (p.kind === 'ring') {
        const r = 18 + easeOutExpo(age) * p.radius;
        ctx.globalAlpha = (1 - age) * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.2, (1 - age) * 4.5);
        ctx.translate(p.x, p.y);
        ctx.rotate(-0.18 + age * 0.24);
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const ang = (k / 8) * Math.PI * 2;
          const rk = r * (k % 2 === 0 ? 1.12 : 0.78);
          const px = Math.cos(ang) * rk;
          const py = Math.sin(ang) * rk;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      } else if (p.kind === 'shard') {
        const dist = easeOutExpo(age);
        const px = p.x + p.vx * dist;
        const py = p.y + p.vy * dist;
        ctx.globalAlpha = 1 - age * age;
        ctx.translate(px, py);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        const l = p.len * (1 - age * 0.45);
        const w = p.wid * (1 - age * 0.45);
        ctx.beginPath();
        ctx.moveTo(l, 0);
        ctx.lineTo(-l * 0.35, -w);
        ctx.lineTo(-l * 0.7, 0);
        ctx.lineTo(-l * 0.35, w);
        ctx.closePath();
        ctx.fill();
      } else if (p.kind === 'slash') {
        const prog = easeOutExpo(age);
        ctx.globalAlpha = 1 - age;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        const half = p.len * prog * 0.5;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-half, 0);
        ctx.lineTo(0, -(1 - age) * 4.5);
        ctx.lineTo(half, 0);
        ctx.lineTo(0, (1 - age) * 4.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    this.particles = nextParticles;

    if (this.activeJobs.length > 0 || this.particles.length > 0) {
      this.raf = requestAnimationFrame(this.boundTick);
    } else {
      // Zero-VRAM idle release: shrink full-monitor backing canvas until next animation triggers
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
  }
}
