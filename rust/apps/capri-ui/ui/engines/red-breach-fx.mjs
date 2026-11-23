// SPDX-License-Identifier: GPL-3.0-only
// Avant-garde demoscene + Studio TRIGGER Edgerunners compositor for Capri-RS.
// Zero idle overhead: requestAnimationFrame spins up only while effects are active and clears 100% transparent afterwards.
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

export class RedBreachCompositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.activeJobs = [];
    this.particles = [];
    this.raf = 0;
    this.boundTick = this.tick.bind(this);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.width = w;
    this.height = h;
    if (this.canvas.width !== Math.floor(w * this.dpr)) {
      this.canvas.width = Math.floor(w * this.dpr);
    }
    if (this.canvas.height !== Math.floor(h * this.dpr)) {
      this.canvas.height = Math.floor(h * this.dpr);
    }
  }

  ensureRunning() {
    if (!this.raf) {
      this.resize();
      this.raf = requestAnimationFrame(this.boundTick);
    }
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
      duration: 380,
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
      len: 150 + Math.random() * 70,
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
        effects: { sandevistanCopies: 14, sandevistanHoldMs: 420, sandevistanHue: 345, sandevistanHueStep: 14, sandevistanTint: 62 },
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
    const job = {
      start,
      duration: 740,
      render: (ctx, now) => {
        const elapsed = now - start;
        const w = this.width;
        const h = this.height;

        // 0-120ms: Studio TRIGGER Breach Flash + diagonal screen fracture + kinetic stamp
        if (elapsed < 210) {
          // Exposure on twos (approx 41.6ms steps)
          const stepIdx = Math.floor(elapsed / 42);
          const flashAlpha = stepIdx === 0 ? 0.36 : stepIdx === 1 ? 0.22 : stepIdx === 2 ? 0.14 : 0.05;
          ctx.save();
          // Radial crimson vignette edge flash
          const grad = ctx.createRadialGradient(
            targetCenter.x,
            targetCenter.y,
            h * 0.14,
            targetCenter.x,
            targetCenter.y,
            Math.max(w, h) * 0.82,
          );
          grad.addColorStop(0, `rgba(255, 0, 51, ${(flashAlpha * 0.42).toFixed(3)})`);
          grad.addColorStop(0.6, `rgba(210, 0, 42, ${(flashAlpha * 0.72).toFixed(3)})`);
          grad.addColorStop(1, `rgba(120, 0, 26, ${(flashAlpha * 1.1).toFixed(3)})`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);

          // Razor diagonal screen fracture through summon target
          const riftP = easeOutExpo(elapsed / 120);
          const x1 = targetCenter.x - w * 0.65 * riftP;
          const y1 = targetCenter.y + h * 0.28 * riftP;
          const x2 = targetCenter.x + w * 0.65 * riftP;
          const y2 = targetCenter.y - h * 0.28 * riftP;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(targetCenter.x - 24, targetCenter.y + 18);
          ctx.lineTo(x2, y2);
          ctx.lineTo(targetCenter.x + 28, targetCenter.y - 4);
          ctx.closePath();
          ctx.fillStyle = stepIdx % 2 === 0 ? 'rgba(255, 245, 248, 0.92)' : 'rgba(255, 0, 61, 0.88)';
          ctx.fill();

          // Horizontal chromatic scanline cuts
          for (let b = 0; b < 5; b++) {
            const by = ((seed * (b + 3)) % Math.max(200, h - 80)) + 20;
            const bh = 2 + ((seed >> b) % 5);
            const bw = w * (0.28 + ((b * 17) % 50) / 100);
            const bx = ((b % 2 === 0 ? 1 : -1) * elapsed * 1.4 + w * 0.3) % w;
            ctx.fillStyle = b % 2 === 0 ? 'rgba(255, 0, 61, 0.72)' : 'rgba(0, 240, 255, 0.55)';
            ctx.fillRect(bx, by, bw, bh);
          }

          // Fleeting kinetic stamp "BREACH // CAPRI" along fracture (shatters cleanly before 200ms)
          if (elapsed < 185) {
            ctx.translate(targetCenter.x, targetCenter.y - 110);
            ctx.rotate(-0.22);
            ctx.font = '900 18px "Consolas", "Courier New", monospace';
            ctx.textAlign = 'center';
            const fade = clamp(1 - elapsed / 185);
            ctx.fillStyle = `rgba(0, 240, 255, ${(fade * 0.85).toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', -3, -2);
            ctx.fillStyle = `rgba(255, 0, 61, ${(fade * 0.95).toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', 3, 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${fade.toFixed(2)})`;
            ctx.fillText('BREACH // CAPRI', 0, 0);
          }
          ctx.restore();
        }

        // Anisotropic speed-lines converging onto target
        if (elapsed >= 60 && elapsed <= 460) {
          const p = (elapsed - 60) / 400;
          const alpha = Math.sin(p * Math.PI) * 0.58;
          ctx.save();
          ctx.strokeStyle = `rgba(255, 0, 61, ${alpha.toFixed(2)})`;
          ctx.lineWidth = 2;
          for (let i = 0; i < 16; i++) {
            const ang = ((seed + i * 97) % 360) * (Math.PI / 180);
            const inner = 70 + (1 - p) * 260;
            const outer = inner + 140 + (i % 3) * 80;
            ctx.beginPath();
            ctx.moveTo(targetCenter.x + Math.cos(ang) * inner, targetCenter.y + Math.sin(ang) * inner);
            ctx.lineTo(targetCenter.x + Math.cos(ang) * outer, targetCenter.y + Math.sin(ang) * outer);
            ctx.stroke();
          }
          ctx.restore();
        }

        // 75-620ms: Official Red Lightning or Sandevistan flight
        if (elapsed >= 75) {
          const flightElapsed = elapsed - 75;
          if (style === 'sandevistan' && sandi && sandiStamps) {
            drawSandevistan(ctx, sandi, flightElapsed * 1.15, sandiStamps, arrivalImg || spriteImg);
          } else if (motion) {
            const frame = Math.min(teleportTotalFrames - 1, (flightElapsed / 560) * (teleportTotalFrames - 1));
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
          this.spawnImpactBurst(targetCenter.x, targetCenter.y + 30, {
            color: '#ff003d',
            count: 18,
            radius: 145,
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
        effects: { sandevistanCopies: 12, sandevistanHoldMs: 420, sandevistanHue: 170, sandevistanHueStep: 12, sandevistanTint: 58 },
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
          this.spawnImpactBurst(targetCenter.x, targetCenter.y + 40, {
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
    const duration = 2600;
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
        // Brief TRIGGER screen crimson blink at t < 240ms
        if (elapsed < 240) {
          const a = (1 - elapsed / 240) * 0.24;
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

        // Official 24fps startup intro into dedicated scratch region
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
      if (p.kind === 'ring') {
        const r = 14 + easeOutExpo(age) * p.radius;
        ctx.globalAlpha = (1 - age) * 0.85;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, (1 - age) * 4.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
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
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
