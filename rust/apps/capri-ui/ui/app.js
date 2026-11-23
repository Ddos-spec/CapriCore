// SPDX-License-Identifier: GPL-3.0-only
import {
  CHANNELS,
  createRenderer,
  resolvePose,
  sampleCustomGesture,
} from './engines/idle-gesture-rig.mjs';
import { AvatarDragTether } from './engines/avatar-drag-tether.mjs';
import {
  playTeleportSound,
  playBreachSummonSound,
  playHeadpatChime,
} from './engines/avatar-teleport-sound.mjs';
import {
  setCelAssetBase,
  prepareRegisteredCel,
  registeredCelClip,
} from './engines/hanging-cels.mjs';
import {
  createScreenInteractionRenderer,
  sampleScreenInteraction,
  usesSurfacePerformance,
} from './engines/screen-interaction-motion.mjs';
import { AvatarVisemes, AvatarMouthLayer } from './engines/avatar-mouth.mjs';
import { AvatarHeadpat, setHeadpatAssetBase } from './engines/avatar-headpat.mjs';
import { AvatarWave, setWaveAssetBase } from './engines/avatar-wave.mjs';
import { drawSurfaceGaze } from './engines/surface-gaze.mjs';
import {
  MusicAnimation,
  MusicPoseLayer,
  drawMusicNotes,
  getMusicNoteAssets,
} from './engines/music-animation.mjs';
import { RedBreachCompositor } from './engines/red-breach-fx.mjs';

const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);
const listen = (ev, cb) => window.__TAURI__.event.listen(ev, cb);

const ACTOR_SIZE = 320;
const CANVAS_EXTENT = 1254;

const elFxCanvas = document.getElementById('fx-canvas');
const elActor = document.getElementById('capri-actor');
const elSourceImg = document.getElementById('capri-source');
const elGlCanvas = document.getElementById('capri-gl');
const elOverlayCanvas = document.getElementById('capri-overlay');
const elHeadpatZone = document.getElementById('headpat-zone');
const elOverlayCtx = elOverlayCanvas.getContext('2d');

const breachFx = new RedBreachCompositor(elFxCanvas);
const dragTether = new AvatarDragTether();
const visemes = new AvatarVisemes();
const mouthLayer = new AvatarMouthLayer(elSourceImg);
const headpat = new AvatarHeadpat(elActor);
const wave = new AvatarWave(elActor, { canPlay: () => !muted && !hiddenStandby });
const musicAnim = new MusicAnimation();
const musicPose = new MusicPoseLayer();

let glRenderer = null;
let screenRig = null;
let musicNoteImgs = [];
let lastGlTickAt = 0;

let config = {
  brainUrl: 'http://100.109.116.120:18789',
  assetBaseUrl: '',
  screenWidth: window.innerWidth || 1920,
  screenHeight: window.innerHeight || 1080,
};

const spriteUrls = new Map();
const spriteImgs = new Map();
let introImages = [];

// Stage position & spring physics
const stage = {
  x: Math.max(0, (window.innerWidth || 1920) - ACTOR_SIZE - 24),
  y: Math.max(0, (window.innerHeight || 1080) - ACTOR_SIZE - 48),
  squishX: 1,
  squishY: 1,
  squishVx: 0,
  squishVy: 0,
  tiltDeg: 0,
  tiltVel: 0,
};

// Interactive state
let currentBaseMood = 'neutral';
let overrideMood = null;
let muted = false;
let hiddenStandby = false;
let autoRoam = true;
let speaking = false;
let thinking = false;
let audioLevel = 0;
let inFlightRequest = false;
let introPlaying = true;
let dragActive = false;
let teleporting = false;

let activeClip = null; // { id, frameId, side, startedAt, durationMs, onEnd }
let glitchUntil = 0;
let impactUntil = 0;
let musicActive = false;
let musicStartedAt = 0;
let musicFrameId = 'music-floor';

// Live cursor & whip physics
let cursorPos = { x: stage.x, y: stage.y, lastX: stage.x, lastY: stage.y, lastAt: performance.now() };
let lastWhipAt = 0;
let lastBlinkAt = performance.now();
let nextBlinkDelay = 3600;
let blinkPhaseUntil = 0;
let blinkFrame = null;

// Human laptop telemetry
const laptopState = {
  activityMode: 'desktop',
  fgTitle: '',
  fgExe: '',
  fgRect: { x: 0, y: 0, w: 0, h: 0 },
  fgFullscreen: false,
  idleMs: 0,
  batteryPct: 100,
  onAc: true,
};
let lastAutoRoamAt = performance.now();
let lastActivityReactAt = 0;
let prevIdleMs = 0;
let sleepingAfk = false;
let batteryWarnedInCycle = false;

// Audio output + DSP + VAD
let audioCtx = null;
let analyser = null;
let freqData = null;
const FX_MODES = ['cybernetic', 'holographic', 'synthetic', 'radio', 'clean'];
let fxIndex = 0;

let micActive = false;
let micStream = null;
let micSource = null;
let vadAnalyser = null;
let vadTimeBuf = null;
let micProcessor = null;
let isCapturingSpeech = false;
let speechFrames = 0;
let silenceFrames = 0;
let peakRawRms = 0;
let noiseFloor = 0.004;
let preRollBuffer = [];
let recordedPcm = [];

const history = [];

const SELF_CONTROL_TOOL = {
  type: 'function',
  function: {
    name: 'capri_self_control',
    description: 'Kontrol tubuh, pose, posisi desktop, mute, sembunyi, suara, dan aksi Capri sendiri.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'mute',
            'unmute',
            'quit',
            'perch',
            'ceiling',
            'dock_left',
            'dock_right',
            'sit_floor',
            'keytar',
            'sandevistan',
            'dance',
            'reset_position',
            'stop_roam',
            'start_roam',
            'set_voice_fx',
            'set_mood',
          ],
        },
        reply_text: { type: 'string', description: 'Ucapan lisan singkat Capri (1-2 kalimat).' },
        fx: { type: 'string', enum: ['cybernetic', 'holographic', 'synthetic', 'radio', 'clean'] },
        mood: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

const DESKTOP_CONTROL_TOOL = {
  type: 'function',
  function: {
    name: 'desktop_control',
    description: 'Kontrol Windows Bos: screenshot, click, double_click, type, hotkey, shell, open_app, read_file, write_file, list_dir, list_windows.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'screenshot',
            'click',
            'double_click',
            'move',
            'type',
            'hotkey',
            'shell',
            'open_app',
            'read_file',
            'write_file',
            'list_dir',
            'list_windows',
          ],
        },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string' },
        text: { type: 'string' },
        press_enter: { type: 'boolean' },
        keys: { type: 'array', items: { type: 'string' } },
        command: { type: 'string' },
        cwd: { type: 'string' },
        target: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

const DESKTOP_INTENT_RE =
  /\b(layar|screen|liat|lihat|buka|tutup|klik|ketik|file|folder|cek|jalanin|run|terminal|cmd|powershell|cari|google|youtube|spotify|code|vscode|screenshot|bantu|error|bug|install|window|aplikasi)\b/i;

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function getSpriteImg(id) {
  return spriteImgs.get(id) || spriteImgs.get('neutral') || null;
}

function activeSpriteId() {
  if (overrideMood && spriteUrls.has(overrideMood)) return overrideMood;
  if (musicActive) return musicFrameId;
  if (blinkFrame && spriteUrls.has(blinkFrame)) return blinkFrame;
  return spriteUrls.has(currentBaseMood) ? currentBaseMood : 'neutral';
}

function syncSourceImg(id) {
  const url = spriteUrls.get(id) || spriteUrls.get('neutral');
  if (url && elSourceImg.dataset.cur !== url) {
    elSourceImg.dataset.cur = url;
    elSourceImg.src = url;
  }
  return getSpriteImg(id);
}

function setMood(mood) {
  currentBaseMood = spriteUrls.has(mood) ? mood : 'neutral';
}

function triggerImpact(ms = 110, glitchMs = 260) {
  const now = performance.now();
  impactUntil = Math.max(impactUntil, now + ms);
  glitchUntil = Math.max(glitchUntil, now + glitchMs);
}

function triggerSquish(sx = 1.07, sy = 0.92) {
  stage.squishX = sx;
  stage.squishY = sy;
}

function updateActorDomPosition() {
  if (stage.squishX !== 1 || stage.squishY !== 1 || Math.abs(stage.squishVx) > 0.001) {
    const k = 0.22;
    const damp = 0.72;
    stage.squishVx = (stage.squishVx + (1 - stage.squishX) * k) * damp;
    stage.squishVy = (stage.squishVy + (1 - stage.squishY) * k) * damp;
    stage.squishX += stage.squishVx;
    stage.squishY += stage.squishVy;
  }
  if (Math.abs(stage.tiltDeg) > 0.05 || Math.abs(stage.tiltVel) > 0.01) {
    stage.tiltVel = (stage.tiltVel + (0 - stage.tiltDeg) * 0.24) * 0.74;
    stage.tiltDeg += stage.tiltVel;
  }
  elActor.style.transform = `translate3d(${stage.x.toFixed(1)}px, ${stage.y.toFixed(1)}px, 0) scale(${stage.squishX.toFixed(3)}, ${stage.squishY.toFixed(3)}) rotate(${stage.tiltDeg.toFixed(2)}deg)`;
}

function clampActorPos(x, y) {
  const maxX = Math.max(0, (config.screenWidth || window.innerWidth) - ACTOR_SIZE + 52);
  const maxY = Math.max(0, (config.screenHeight || window.innerHeight) - ACTOR_SIZE + 12);
  return {
    x: Math.max(-52, Math.min(maxX, x)),
    y: Math.max(-28, Math.min(maxY, y)),
  };
}

function startClip(id, { frameId, side = 'left', onEnd } = {}) {
  if (registeredCelClip(id)) {
    const cel = registeredCelClip(id);
    activeClip = {
      id,
      frameId: frameId || cel.frameId,
      side,
      startedAt: performance.now(),
      durationMs: cel.durationMs,
      onEnd,
    };
    return;
  }
  const sample0 = sampleScreenInteraction(id, 1, { frameId, side });
  if (!sample0) return;
  const durations = {
    'ledge-lean': 4800,
    'edge-lean': 5200,
    'edge-hang': 4400,
    'bar-perch': 5200,
    'bar-search': 6200,
    'bar-search-below': 6000,
    'bar-present': 4300,
    'bar-read': 5800,
    'bar-read-below': 5800,
    'bar-tap': 5600,
    'bar-tap-below': 5600,
    'ledge-peek': 4650,
    'ledge-peek-below': 4650,
  };
  activeClip = {
    id,
    frameId: frameId || 'pose-sit-edge',
    side,
    startedAt: performance.now(),
    durationMs: durations[id] || 4800,
    onEnd,
  };
}

async function init() {
  config = await invoke('get_runtime_config');
  const base = String(config.assetBaseUrl || '').replace(/\/+$/, '');
  setCelAssetBase(base);
  setHeadpatAssetBase(base);
  setWaveAssetBase(base);
  musicNoteImgs = getMusicNoteAssets(base).map(({ url }) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = url;
    return im;
  });

  // Register official v1 standing sprites
  const v1List = (config.manifest && config.manifest.sprites) || [];
  for (const item of v1List) {
    spriteUrls.set(item.id, `${base}/capri/sprites/v1/${item.file}`);
  }
  if (!spriteUrls.has('neutral')) {
    spriteUrls.set('neutral', `${base}/capri/sprites/v1/capri-neutral.png`);
  }

  // Register official poses-v2 sprites
  const poseList = (config.poses && config.poses.sprites) || [];
  for (const p of poseList) {
    spriteUrls.set(p.id, `${base}/capri/sprites/poses-v2/PNG/${p.file}`);
  }

  // Register official music poses
  spriteUrls.set('music-floor', `${base}/default/capri-music-v1/capri-music-floor.png`);
  spriteUrls.set('music-window', `${base}/default/capri-music-v1/capri-music-window.png`);

  // Preload core sprites + intro sequence + cels in parallel
  const introMeta = (config.intro && config.intro.frames) || [];
  const introPromise = Promise.all(
    introMeta.map((f) => preloadImage(`${base}/capri/intro-v1/${f.file}`)),
  );
  const spriteEntries = Array.from(spriteUrls.entries());
  const spritePromise = Promise.all(
    spriteEntries.map(async ([id, url]) => {
      const im = await preloadImage(url);
      if (im) spriteImgs.set(id, im);
    }),
  );
  const celPromise = Promise.all(
    ['hang-pullup', 'hang-catch', 'hang-wrist-scan', 'ledge-keytar'].map((c) =>
      prepareRegisteredCel(c),
    ),
  );

  [introImages] = await Promise.all([introPromise, spritePromise, celPromise]);

  try {
    glRenderer = createRenderer(elGlCanvas, {}, { grid: 96 });
  } catch (e) {
    console.warn('WebGL rig fallback to 2D:', e);
    glRenderer = null;
  }
  try {
    screenRig = createScreenInteractionRenderer(elOverlayCanvas);
  } catch (e) {
    console.warn('ScreenRig init warn:', e);
    screenRig = null;
  }

  const br = await invoke('move_to_spot', { spot: 'bottom_right' }).catch(() => ({
    x: (config.screenWidth || 1920) - ACTOR_SIZE - 24,
    y: (config.screenHeight || 1080) - ACTOR_SIZE - 48,
  }));
  stage.x = br.x;
  stage.y = br.y;
  updateActorDomPosition();
  syncSourceImg('neutral');

  await setupTauriEvents();
  startHitRectSyncLoop();
  requestAnimationFrame(renderFrameLoop);

  // Play official 24fps startup intro + TRIGGER red ribbons right on stage!
  introPlaying = true;
  elGlCanvas.style.opacity = '0';
  breachFx.playStartupIntroFx({
    rect: { x: stage.x, y: stage.y, width: ACTOR_SIZE, height: ACTOR_SIZE },
    introImages: introImages.filter(Boolean),
    onDone: () => {
      introPlaying = false;
      elGlCanvas.style.opacity = '1';
      triggerSquish(1.06, 0.93);
      setMood('smirk');
    },
  });

  setTimeout(() => startAutonomousLoop(), 4000);
  await startMicVadWithRetry();
  speakText('Yo Bos! Akhirnya melek juga nih mesin. Mau ngapain kita sekarang?');
}

async function setupTauriEvents() {
  await listen('capri-cursor', (ev) => {
    const p = ev.payload;
    if (!p) return;
    const now = performance.now();
    const dt = Math.max(8, now - cursorPos.lastAt);
    const dx = p.x - cursorPos.lastX;
    const dy = p.y - cursorPos.lastY;
    const speed = (Math.hypot(dx, dy) / dt) * 1000;

    cursorPos.x = p.x;
    cursorPos.y = p.y;
    cursorPos.lastX = p.x;
    cursorPos.lastY = p.y;
    cursorPos.lastAt = now;
    if (p.screenW) config.screenWidth = p.screenW;
    if (p.screenH) config.screenHeight = p.screenH;

    // Fast cursor whip near Capri -> 2-frame TRIGGER impact flinch!
    const cx = stage.x + ACTOR_SIZE * 0.5;
    const cy = stage.y + ACTOR_SIZE * 0.44;
    if (
      !hiddenStandby &&
      !dragActive &&
      !introPlaying &&
      speed > 2600 &&
      Math.hypot(p.x - cx, p.y - cy) < 135 &&
      now - lastWhipAt > 3600
    ) {
      lastWhipAt = now;
      triggerImpact(120, 260);
      triggerSquish(0.92, 1.09);
      breachFx.spawnMicroSlash(cx, cy - 18, Math.atan2(dy, dx), '#ff003d');
      flashOverrideMood('surprised', 950);
    }
  });

  await listen('capri-summon', (ev) => {
    const p = ev.payload || {};
    triggerRedBreachSummon(p.source || 'hotkey', p.cursorX, p.cursorY);
  });

  await listen('capri-activity', (ev) => {
    const p = ev.payload;
    if (!p) return;
    const wasIdle = prevIdleMs;
    prevIdleMs = p.idleMs ?? 0;
    Object.assign(laptopState, p);
    handleLaptopActivityUpdate(wasIdle);
  });
}

function flashOverrideMood(id, ms = 1100) {
  overrideMood = id;
  setTimeout(() => {
    if (overrideMood === id) overrideMood = null;
  }, ms);
}

function renderFrameLoop(now) {
  requestAnimationFrame(renderFrameLoop);
  if (hiddenStandby || introPlaying) return;

  updateActorDomPosition();

  // Ambient blinking when standing
  if (!speaking && !thinking && !activeClip && !musicActive && !muted && !sleepingAfk && !overrideMood) {
    if (now - lastBlinkAt > nextBlinkDelay && !currentBaseMood.startsWith('pose-')) {
      lastBlinkAt = now;
      nextBlinkDelay = 2600 + Math.random() * 3400;
      blinkPhaseUntil = now + 150;
    }
  }
  if (now < blinkPhaseUntil) {
    const rem = blinkPhaseUntil - now;
    blinkFrame = rem > 90 ? 'idle-blink_half' : rem > 28 ? 'idle-blink_closed' : 'idle-blink_half';
  } else {
    blinkFrame = null;
  }

  // Live audio FFT amplitude while speaking
  if (speaking && analyser && freqData) {
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    const bins = Math.min(28, freqData.length);
    for (let i = 1; i < bins; i++) sum += freqData[i];
    audioLevel = Math.min(1, sum / (bins - 1) / 135);
  } else if (!speaking) {
    audioLevel *= 0.8;
  }

  // Wave WebP override
  if (wave.image) {
    elGlCanvas.style.opacity = '0';
    elOverlayCanvas.style.opacity = '0';
    return;
  }

  const targetId = activeClip ? activeClip.frameId : activeSpriteId();
  const baseImg = syncSourceImg(targetId);
  if (!baseImg || !baseImg.complete) return;

  // Build deformation channels
  const poseKey = resolvePose(targetId);
  const tSec = now / 1000;
  let channels = {
    ...CHANNELS,
    pose: poseKey,
    breath: 0.5 + 0.5 * Math.sin(tSec * (sleepingAfk || muted ? 1.5 : 2.3)),
    lean: Math.sin(tSec * 1.15) * 1.1 + stage.tiltDeg * 0.25,
    lift: Math.sin(tSec * 2.3) * 3.2,
    head: Math.sin(tSec * 0.9) * 1.4 + (speaking ? Math.sin(tSec * 8.5) * audioLevel * 3.2 : 0),
    headY: Math.sin(tSec * 2.3 + 0.5) * 2.2,
  };

  // Compute cursor gaze normalized [-1, 1] relative to Capri eyes
  const cx = stage.x + ACTOR_SIZE * 0.5;
  const cy = stage.y + ACTOR_SIZE * 0.36;
  const gx = Math.max(-1, Math.min(1, (cursorPos.x - cx) / 380));
  const gy = Math.max(-1, Math.min(1, (cursorPos.y - cy) / 280));
  let activeGaze = { x: gx, y: gy };

  // Check active Screen Interaction clip or 12-frame Registered Cel
  if (activeClip) {
    const elapsed = now - activeClip.startedAt;
    if (elapsed >= activeClip.durationMs) {
      const doneCb = activeClip.onEnd;
      activeClip = null;
      screenRig?.clear();
      doneCb?.();
    } else if (screenRig && usesSurfacePerformance(activeClip.id)) {
      elGlCanvas.style.opacity = '0';
      elOverlayCanvas.style.opacity = '1';
      const clipCh = sampleScreenInteraction(activeClip.id, elapsed, {
        frameId: activeClip.frameId,
        side: activeClip.side,
      });
      if (clipCh) channels = { ...channels, ...clipCh };
      screenRig.setAction(activeClip.id, elapsed, {
        frameId: activeClip.frameId,
        side: activeClip.side,
      });
      screenRig.draw(baseImg, channels);
      return;
    } else if (registeredCelClip(activeClip.id) && screenRig) {
      elGlCanvas.style.opacity = '0';
      elOverlayCanvas.style.opacity = '1';
      screenRig.setAction(activeClip.id, elapsed, { frameId: activeClip.frameId });
      screenRig.draw(baseImg, channels);
      return;
    } else {
      const clipCh = sampleScreenInteraction(activeClip.id, elapsed, {
        frameId: activeClip.frameId,
        side: activeClip.side,
      });
      if (clipCh) channels = { ...channels, ...clipCh };
    }
  }

  // Standard & Posed WebGL Rendering + LipSync + Headpat + Optical Gaze + Music Notes
  elGlCanvas.style.opacity = '1';
  elOverlayCanvas.style.opacity = '1';

  // Cap ambient WebGL mesh updates at Studio TRIGGER 24fps unless speaking/glitching
  if (!speaking && now >= glitchUntil && now >= impactUntil && !dragActive && now - lastGlTickAt < 40) {
    return;
  }
  lastGlTickAt = now;

  // Subtle standing gaze sprite when idle & neutral
  let renderBaseId = targetId;
  let renderImg = baseImg;
  if (
    targetId === 'neutral' &&
    !speaking &&
    !thinking &&
    !blinkFrame &&
    !overrideMood &&
    Math.hypot(gx, gy) > 0.48
  ) {
    const gazeSprite =
      Math.abs(gx) > Math.abs(gy)
        ? gx < 0
          ? 'idle-look_left'
          : 'idle-look_right'
        : gy < -0.2
          ? 'idle-look_up'
          : 'idle-look_down';
    if (spriteImgs.has(gazeSprite)) {
      renderBaseId = gazeSprite;
      renderImg = spriteImgs.get(gazeSprite);
      syncSourceImg(gazeSprite);
    }
  }

  // Official cross-pose mouth shape
  const shape = visemes.sample(now, speaking, audioLevel);
  let composited = headpat.image(elSourceImg);
  if (composited === elSourceImg) composited = renderImg;
  mouthLayer.update(composited, shape, renderBaseId);
  composited = mouthLayer.image(composited);

  // Official Music BPM choreography
  let musicState = null;
  if (musicActive) {
    musicState = musicAnim.sample(now, {
      active: true,
      strength: 0.72,
      autoBpm: true,
      tempo: 112,
      tempoConfidence: 0.9,
      beatAt: musicStartedAt,
      frameId: musicFrameId,
    });
    composited = musicPose.image(composited, musicState);
  } else {
    musicAnim.sample(now, { active: false, frameId: musicFrameId });
  }

  const glitchPow = now < glitchUntil ? 0.92 : thinking ? 0.25 : 0;
  const impactPow = now < impactUntil ? 0.85 : 0;
  const rimPow = speaking ? 0.35 + audioLevel * 0.6 : thinking ? 0.45 : dragActive ? 0.55 : 0;

  if (glRenderer) {
    glRenderer.draw(composited, channels, {
      fx: {
        time: tSec,
        glitch: glitchPow,
        impact: impactPow,
        rimPower: rimPow,
        rimColor: thinking ? [0.0, 0.94, 1.0] : [1.0, 0.0, 0.24],
        audio: audioLevel,
      },
    });
  }

  // Paint optical gaze + floating music notes on 1254px overlay canvas
  elOverlayCtx.clearRect(0, 0, CANVAS_EXTENT, CANVAS_EXTENT);
  if (!glRenderer && renderImg) {
    elOverlayCtx.drawImage(renderImg, 0, 0, CANVAS_EXTENT, CANVAS_EXTENT);
  }
  if (!muted && !sleepingAfk && !blinkFrame) {
    drawSurfaceGaze(elOverlayCtx, renderImg, renderBaseId, activeGaze, glRenderer?.channels || channels);
  }
  if (musicState?.notes?.length) {
    drawMusicNotes(elOverlayCtx, musicState.notes, musicNoteImgs, {
      x: 0,
      y: 0,
      width: CANVAS_EXTENT,
      height: CANVAS_EXTENT,
    });
  }
}

async function teleportTo(targetBox, { pose = 'neutral', style = 'lightning', clip = null, onArrive } = {}) {
  if (teleporting) return;
  teleporting = true;
  const clamped = clampActorPos(targetBox.x, targetBox.y);
  const fromBox = { x: stage.x, y: stage.y, size: ACTOR_SIZE };
  const toBox = { x: clamped.x, y: clamped.y, size: ACTOR_SIZE };

  const fromImg = getSpriteImg(activeSpriteId());
  const toImg = getSpriteImg(pose);
  ensureAudioCtx();
  playTeleportSound(audioCtx, style === 'sandevistan' ? 'pulse' : 'spark');

  activeClip = null;
  screenRig?.clear();
  elGlCanvas.style.opacity = '0';
  elOverlayCanvas.style.opacity = '0';

  breachFx.playTeleportFlight({
    from: fromBox,
    to: toBox,
    spriteImg: fromImg,
    arrivalImg: toImg,
    style,
    onArrive: () => {
      stage.x = toBox.x;
      stage.y = toBox.y;
      setMood(pose);
      triggerImpact(95, 220);
      triggerSquish(1.08, 0.91);
      elGlCanvas.style.opacity = '1';
      elOverlayCanvas.style.opacity = '1';
      teleporting = false;
      if (clip) startClip(clip.id, clip);
      onArrive?.();
    },
  });
}

function triggerRedBreachSummon(source = 'hotkey', curX, curY) {
  ensureAudioCtx();
  muted = false;
  hiddenStandby = false;
  sleepingAfk = false;
  musicActive = false;
  activeClip = null;
  screenRig?.clear();
  elActor.classList.remove('hidden-standby');
  playBreachSummonSound(audioCtx);

  const w = config.screenWidth || window.innerWidth || 1920;
  const h = config.screenHeight || window.innerHeight || 1080;

  let tx;
  let ty;
  if (Number.isFinite(curX) && Number.isFinite(curY)) {
    const onLeft = curX > w * 0.5;
    tx = onLeft ? curX - ACTOR_SIZE - 44 : curX + 44;
    ty = curY - ACTOR_SIZE * 0.55;
  } else {
    tx = w - ACTOR_SIZE - 28;
    ty = h - ACTOR_SIZE - 52;
  }
  const dest = clampActorPos(tx, ty);
  const fromBox = {
    x: dest.x + (dest.x > w * 0.5 ? 240 : -240),
    y: Math.max(0, dest.y - 260),
    size: ACTOR_SIZE,
  };
  const toBox = { x: dest.x, y: dest.y, size: ACTOR_SIZE };

  elGlCanvas.style.opacity = '0';
  elOverlayCanvas.style.opacity = '0';

  breachFx.playRedBreachSummon({
    from: fromBox,
    to: toBox,
    spriteImg: getSpriteImg('smirk'),
    arrivalImg: getSpriteImg('smirk'),
    style: Math.random() < 0.35 ? 'sandevistan' : 'lightning',
    onArrive: () => {
      stage.x = toBox.x;
      stage.y = toBox.y;
      setMood('smirk');
      triggerImpact(130, 320);
      triggerSquish(1.1, 0.89);
      elGlCanvas.style.opacity = '1';
      elOverlayCanvas.style.opacity = '1';
      void wave.play();
      if (source === 'hotkey') {
        const lines = [
          'Yo Bos! Ada apaan manggil mendadak?',
          'Hadir Bos. Sistem aman, ada yang mau diberesin?',
          'Dipanggil langsung nongol nih, mau ngapain kita?',
        ];
        speakText(lines[Math.floor(Math.random() * lines.length)]);
      } else {
        speakText('Gue di sini Bos, ngomong aja.');
      }
    },
  });
}

function handleLaptopActivityUpdate(wasIdle) {
  const now = performance.now();

  // Battery low warning (< 20% unplugged, once per discharge cycle)
  if (laptopState.batteryPct > 0 && laptopState.batteryPct < 20 && !laptopState.onAc) {
    if (!batteryWarnedInCycle && !muted && !hiddenStandby && !speaking && !inFlightRequest) {
      batteryWarnedInCycle = true;
      breachFx.spawnImpactBurst(stage.x + 160, stage.y + 120, { color: '#ff003d', count: 16, radius: 130 });
      triggerImpact(150, 420);
      flashOverrideMood('concerned', 3200);
      speakText(`Eh Bos, baterai laptop tinggal ${laptopState.batteryPct} persen tuh! Colok charger dulu gih sebelum jeglek.`);
    }
  } else if (laptopState.onAc || laptopState.batteryPct >= 30) {
    batteryWarnedInCycle = false;
  }

  // AFK Sleep & Wake-Up
  if (laptopState.idleMs > 300_000 && !sleepingAfk && !muted && !hiddenStandby && !speaking && !dragActive) {
    sleepingAfk = true;
    musicActive = false;
    activeClip = null;
    const brX = Math.max(20, (config.screenWidth || 1920) - ACTOR_SIZE - 26);
    const brY = Math.max(0, (config.screenHeight || 1080) - ACTOR_SIZE - 48);
    teleportTo({ x: brX, y: brY }, { pose: 'pose-sleep', style: 'lightning' });
    return;
  }

  if (sleepingAfk && wasIdle > 60_000 && laptopState.idleMs < 2500) {
    sleepingAfk = false;
    triggerImpact(120, 280);
    triggerSquish(1.06, 0.93);
    setMood('surprised');
    setTimeout(() => setMood('smirk'), 850);
    return;
  }

  // Stop background music choreography cleanly when leaving music mode
  if (musicActive && laptopState.activityMode !== 'music' && now - lastActivityReactAt > 12000) {
    musicActive = false;
    setMood('neutral');
  }

  // Adaptive per-activity reaction (minimum 38s cooldown between autonomous moves)
  if (
    !autoRoam ||
    muted ||
    hiddenStandby ||
    sleepingAfk ||
    speaking ||
    thinking ||
    dragActive ||
    teleporting ||
    inFlightRequest ||
    activeClip
  ) {
    return;
  }
  if (now - lastActivityReactAt < 38_000) return;

  if (laptopState.activityMode === 'music' && !musicActive) {
    lastActivityReactAt = now;
    musicActive = true;
    musicStartedAt = now;
    musicFrameId = laptopState.fgRect?.w > 300 && !laptopState.fgFullscreen ? 'music-window' : 'music-floor';
    return;
  }

  if (laptopState.fgFullscreen || laptopState.activityMode === 'video_game') {
    const cornerX = (config.screenWidth || 1920) - ACTOR_SIZE + 44;
    if (Math.abs(stage.x - cornerX) > 90) {
      lastActivityReactAt = now;
      teleportTo(
        { x: cornerX, y: (config.screenHeight || 1080) - ACTOR_SIZE - 48 },
        { pose: 'pose-dock-right', style: 'sandevistan' },
      );
    }
    return;
  }

  if (laptopState.activityMode === 'coding' && laptopState.fgRect?.w > 360) {
    const r = laptopState.fgRect;
    const tx = Math.max(0, Math.min((config.screenWidth || 1920) - ACTOR_SIZE, r.x + r.w - ACTOR_SIZE - 14));
    const ty = Math.max(-18, Math.min((config.screenHeight || 1080) - ACTOR_SIZE, r.y - ACTOR_SIZE * 0.56));
    if (Math.hypot(stage.x - tx, stage.y - ty) > 75 || currentBaseMood !== 'pose-sit-edge') {
      lastActivityReactAt = now;
      const clips = ['bar-read', 'bar-perch', 'ledge-peek'];
      const pick = clips[Math.floor(Math.random() * clips.length)];
      teleportTo(
        { x: tx, y: ty },
        { pose: 'pose-sit-edge', style: 'sandevistan', clip: { id: pick, frameId: 'pose-sit-edge', side: 'left' } },
      );
    }
  }
}

function startAutonomousLoop() {
  setInterval(async () => {
    const now = performance.now();
    if (
      !autoRoam ||
      muted ||
      hiddenStandby ||
      sleepingAfk ||
      musicActive ||
      speaking ||
      thinking ||
      dragActive ||
      teleporting ||
      inFlightRequest ||
      activeClip ||
      laptopState.fgFullscreen ||
      laptopState.activityMode === 'video_game'
    ) {
      return;
    }
    if (now - lastAutoRoamAt < 34_000) return;
    lastAutoRoamAt = now;

    // Restless cels after 90s AFK
    if (laptopState.idleMs > 90_000) {
      const res = await invoke('move_to_spot', { spot: 'ceiling' }).catch(() => null);
      if (res?.ok) {
        const cel = Math.random() < 0.5 ? 'hang-pullup' : 'hang-wrist-scan';
        teleportTo(res, {
          pose: 'pose-ceiling',
          style: 'lightning',
          clip: { id: cel, frameId: 'pose-ceiling' },
        });
      }
      return;
    }

    const roll = Math.random();
    if (roll < 0.34 && laptopState.fgRect?.w > 340) {
      const perch = await invoke('move_to_spot', { spot: 'perch' }).catch(() => null);
      if (perch?.ok) {
        const clips = ['bar-perch', 'bar-search', 'bar-tap', 'ledge-keytar'];
        const pick = clips[Math.floor(Math.random() * clips.length)];
        teleportTo(perch, {
          pose: 'pose-sit-edge',
          style: Math.random() < 0.4 ? 'sandevistan' : 'lightning',
          clip: { id: pick, frameId: 'pose-sit-edge', side: 'left' },
        });
      }
    } else if (roll < 0.62) {
      const ceil = await invoke('move_to_spot', { spot: 'ceiling' }).catch(() => null);
      if (ceil?.ok) {
        const clips = ['hang-pullup', 'hang-catch', 'hang-wrist-scan', 'edge-hang'];
        const pick = clips[Math.floor(Math.random() * clips.length)];
        teleportTo(ceil, {
          pose: 'pose-ceiling',
          style: 'lightning',
          clip: { id: pick, frameId: 'pose-ceiling' },
        });
      }
    } else if (roll < 0.82) {
      const side = Math.random() < 0.5 ? 'dock_left' : 'dock_right';
      const dock = await invoke('move_to_spot', { spot: side }).catch(() => null);
      if (dock?.ok) {
        const pose = side === 'dock_left' ? 'pose-dock-left' : 'pose-dock-right';
        teleportTo(dock, {
          pose,
          style: 'sandevistan',
          clip: { id: 'edge-lean', frameId: pose, side: side === 'dock_left' ? 'left' : 'right' },
        });
      }
    } else {
      const br = await invoke('move_to_spot', { spot: 'bottom_right' }).catch(() => null);
      if (br?.ok) {
        teleportTo(br, {
          pose: 'neutral',
          style: 'lightning',
          clip: { id: 'bar-present', frameId: 'neutral', side: 'left' },
        });
      }
    }
  }, 6000);
}

// Dragging with official SVG AvatarDragTether + spring velocity tilt + smart edge landing!
let dragStartMouse = null;
let dragStartStage = null;
let dragAnchorCenter = null;
let dragLastMouse = null;
let dragLastAt = 0;
let dragSeed = 1337;
let pokeTimestamps = [];

elActor.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  ensureAudioCtx();
  dragStartMouse = { x: e.screenX, y: e.screenY };
  dragLastMouse = { x: e.screenX, y: e.screenY };
  dragLastAt = performance.now();
  dragStartStage = { x: stage.x, y: stage.y };
  dragAnchorCenter = { x: stage.x + ACTOR_SIZE * 0.5, y: stage.y + ACTOR_SIZE * 0.55 };
  dragSeed = (Date.now() & 0xffffff) >>> 0;
  dragActive = false;
});

window.addEventListener('mousemove', (e) => {
  if (!dragStartMouse) return;
  const dx = e.screenX - dragStartMouse.x;
  const dy = e.screenY - dragStartMouse.y;
  if (!dragActive && Math.hypot(dx, dy) > 5) {
    dragActive = true;
    activeClip = null;
    musicActive = false;
    screenRig?.clear();
    setMood('surprised');
    invoke('set_dragging', { active: true }).catch(() => {});
  }
  if (!dragActive) return;

  const next = clampActorPos(dragStartStage.x + dx, dragStartStage.y + dy);
  stage.x = next.x;
  stage.y = next.y;

  const now = performance.now();
  const dt = Math.max(8, now - dragLastAt);
  const vx = ((e.screenX - dragLastMouse.x) / dt) * 16;
  dragLastMouse = { x: e.screenX, y: e.screenY };
  dragLastAt = now;
  stage.tiltDeg = Math.max(-16, Math.min(16, vx * 1.1));

  dragTether.draw({
    from: dragAnchorCenter,
    to: { x: stage.x + ACTOR_SIZE * 0.5, y: stage.y + ACTOR_SIZE * 0.55 },
    intensity: 88,
    chaos: 64,
    seed: dragSeed,
  });
});

window.addEventListener('mouseup', () => {
  if (!dragStartMouse) return;
  const wasDragging = dragActive;
  dragStartMouse = null;
  dragActive = false;
  if (!wasDragging) return;

  dragTether.clear();
  invoke('set_dragging', { active: false }).catch(() => {});
  lastAutoRoamAt = performance.now();

  const w = config.screenWidth || window.innerWidth || 1920;
  const h = config.screenHeight || window.innerHeight || 1080;

  if (stage.y < 85) {
    stage.y = -18;
    setMood('pose-ceiling');
    startClip('hang-catch', { frameId: 'pose-ceiling' });
    triggerSquish(0.92, 1.1);
  } else if (stage.x < 75) {
    stage.x = -46;
    setMood('pose-dock-left');
    startClip('edge-lean', { frameId: 'pose-dock-left', side: 'left' });
  } else if (stage.x > w - ACTOR_SIZE - 75) {
    stage.x = w - ACTOR_SIZE + 46;
    setMood('pose-dock-right');
    startClip('edge-lean', { frameId: 'pose-dock-right', side: 'right' });
  } else if (
    laptopState.fgRect?.w > 300 &&
    Math.abs(stage.y + ACTOR_SIZE * 0.58 - laptopState.fgRect.y) < 75
  ) {
    stage.y = laptopState.fgRect.y - ACTOR_SIZE * 0.56;
    setMood('pose-sit-edge');
    startClip('bar-perch', { frameId: 'pose-sit-edge', side: 'left' });
    triggerSquish(1.09, 0.9);
  } else {
    breachFx.spawnImpactBurst(stage.x + 160, stage.y + 280, { color: '#ff003d', count: 12, radius: 92 });
    triggerImpact(80, 180);
    triggerSquish(1.11, 0.88);
    setMood(stage.y > h - 420 ? 'pose-sit-floor' : 'neutral');
    if (stage.y > h - 420) {
      setTimeout(() => {
        if (!dragActive && !speaking) setMood('neutral');
      }, 2800);
    }
  }
});

// Rapid-poke reaction
elActor.addEventListener('click', () => {
  if (dragActive) return;
  const now = performance.now();
  pokeTimestamps = pokeTimestamps.filter((t) => now - t < 2400);
  pokeTimestamps.push(now);

  if (pokeTimestamps.length >= 4 && !speaking && !inFlightRequest) {
    pokeTimestamps = [];
    triggerImpact(130, 320);
    triggerSquish(1.08, 0.91);
    breachFx.spawnMicroSlash(stage.x + 160, stage.y + 130, -0.5, '#ff003d');
    flashOverrideMood('annoyed', 2600);
    if (!muted) {
      speakText('Heh, jangan colek-colek mulu napa Bos! Emang gue tombol lift?');
    }
  }
});

// Real Headpat Rub + Click using official AvatarHeadpat
let lastPatPoint = null;
let patAccum = 0;
let lastPatFireAt = 0;

function fireHeadpat(clientX, clientY) {
  const now = performance.now();
  if (now - lastPatFireAt < 750) return;
  lastPatFireAt = now;
  ensureAudioCtx();
  playHeadpatChime(audioCtx);
  triggerSquish(1.06, 0.93);
  activeClip = null;
  screenRig?.clear();
  const fid = syncSourceImg(activeSpriteId()) ? activeSpriteId() : 'neutral';
  headpat.play(elSourceImg, { x: clientX, y: clientY }, { x: 0, y: 0, width: ACTOR_SIZE, height: ACTOR_SIZE }, true, fid);
  if (!muted && !speaking && !inFlightRequest && Math.random() < 0.7) {
    const lines = [
      'Hmm, lumayan lah elusannya Bos.',
      'Jangan kebiasaan manjain gitu dong, gue bukan kucing.',
      'Eh, tangan lo anget juga. Lanjut dikit boleh tuh.',
    ];
    speakText(lines[Math.floor(Math.random() * lines.length)]);
  }
}

elHeadpatZone.addEventListener('mousemove', (e) => {
  if (dragActive) return;
  if (lastPatPoint) {
    patAccum += Math.hypot(e.clientX - lastPatPoint.x, e.clientY - lastPatPoint.y);
  }
  lastPatPoint = { x: e.clientX, y: e.clientY };
  if (patAccum > 42) {
    patAccum = 0;
    fireHeadpat(e.clientX, e.clientY);
  }
});

elHeadpatZone.addEventListener('mouseleave', () => {
  lastPatPoint = null;
  patAccum = 0;
});

elHeadpatZone.addEventListener('click', (e) => {
  e.stopPropagation();
  fireHeadpat(e.clientX, e.clientY);
});

function startHitRectSyncLoop() {
  const pushRects = () => {
    if (hiddenStandby) {
      invoke('update_hit_rects', { rects: [] }).catch(() => {});
      return;
    }
    const regions = [];
    for (const el of document.querySelectorAll('.hit-region')) {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        regions.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    invoke('update_hit_rects', { rects: regions }).catch(() => {});
  };
  pushRects();
  setInterval(pushRects, 180);
}

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

async function speakText(text, forceUnmute = false) {
  if ((muted && !forceUnmute) || !text || !text.trim()) return;
  ensureAudioCtx();
  try {
    const resp = await fetch(`${config.brainUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice: 'id-ID-GadisNeural' }),
    });
    if (!resp.ok) return;
    const arr = await resp.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    const fx = FX_MODES[fxIndex];
    let tailNode = src;
    if (fx === 'cybernetic' || fx === 'synthetic') {
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highshelf';
      hp.frequency.value = 2600;
      hp.gain.value = 4.0;

      const bp = audioCtx.createBiquadFilter();
      bp.type = 'peaking';
      bp.frequency.value = 1250;
      bp.Q.value = 1.5;
      bp.gain.value = 2.8;

      const delay = audioCtx.createDelay();
      delay.delayTime.value = fx === 'cybernetic' ? 0.011 : 0.017;
      const wet = audioCtx.createGain();
      wet.gain.value = 0.24;
      const mix = audioCtx.createGain();
      mix.gain.value = 0.96;

      tailNode.connect(hp);
      hp.connect(bp);
      bp.connect(mix);
      bp.connect(delay);
      delay.connect(wet);
      wet.connect(mix);
      tailNode = mix;
    } else if (fx === 'holographic') {
      const delay = audioCtx.createDelay();
      delay.delayTime.value = 0.042;
      const wet = audioCtx.createGain();
      wet.gain.value = 0.3;
      const mix = audioCtx.createGain();
      tailNode.connect(mix);
      tailNode.connect(delay);
      delay.connect(wet);
      wet.connect(mix);
      tailNode = mix;
    } else if (fx === 'radio') {
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1350;
      bp.Q.value = 1.1;
      tailNode.connect(bp);
      tailNode = bp;
    }

    tailNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    speaking = true;
    await new Promise((resolve) => {
      src.onended = () => {
        speaking = false;
        audioLevel = 0;
        resolve();
      };
      src.start();
    });
  } catch (e) {
    speaking = false;
    console.warn('TTS playback err:', e);
  }
}

async function executeSelfControl(args) {
  const action = (args.action || '').trim();
  const reply = (args.reply_text || '').trim();

  if (action === 'mute') {
    if (reply) await speakText(reply, true);
    muted = true;
    hiddenStandby = true;
    musicActive = false;
    activeClip = null;
    screenRig?.clear();
    breachFx.spawnImpactBurst(stage.x + 160, stage.y + 160, { color: '#ff003d', count: 14, radius: 110 });
    elActor.classList.add('hidden-standby');
    invoke('update_hit_rects', { rects: [] }).catch(() => {});
    return { ok: true, action: 'mute' };
  }

  if (action === 'unmute') {
    triggerRedBreachSummon('voice', cursorPos.x, cursorPos.y);
    if (reply) setTimeout(() => speakText(reply, true), 560);
    return { ok: true, action: 'unmute' };
  }

  if (action === 'quit') {
    if (reply && !muted) await speakText(reply);
    breachFx.spawnImpactBurst(stage.x + 160, stage.y + 160, { color: '#ff003d', count: 22, radius: 170 });
    elActor.classList.add('hidden-standby');
    await new Promise((r) => setTimeout(r, 420));
    await invoke('quit_app').catch(() => {});
    return { ok: true, action: 'quit' };
  }

  if (action === 'perch') {
    const res = await invoke('move_to_spot', { spot: 'perch' }).catch(() => null);
    if (res?.ok) {
      teleportTo(res, {
        pose: 'pose-sit-edge',
        style: 'sandevistan',
        clip: { id: 'bar-perch', frameId: 'pose-sit-edge', side: 'left' },
      });
    }
    if (reply && !muted) await speakText(reply);
    return { ok: true, action: 'perch' };
  }

  if (['ceiling', 'dock_left', 'dock_right', 'sit_floor'].includes(action)) {
    const res = await invoke('move_to_spot', { spot: action }).catch(() => null);
    const mapPose = {
      ceiling: 'pose-ceiling',
      dock_left: 'pose-dock-left',
      dock_right: 'pose-dock-right',
      sit_floor: 'pose-sit-floor',
    };
    const pose = mapPose[action];
    if (res?.ok) {
      teleportTo(res, {
        pose,
        style: 'lightning',
        clip: action === 'ceiling' ? { id: 'hang-pullup', frameId: 'pose-ceiling' } : null,
      });
    }
    if (reply && !muted) await speakText(reply);
    return { ok: true, action };
  }

  if (action === 'keytar') {
    const res = await invoke('move_to_spot', { spot: 'perch' }).catch(() => null);
    const dest = res?.ok ? res : { x: stage.x, y: stage.y };
    teleportTo(dest, {
      pose: 'pose-sit-edge',
      style: 'sandevistan',
      clip: { id: 'ledge-keytar', frameId: 'pose-sit-edge' },
    });
    if (reply && !muted) await speakText(reply);
    return { ok: true, action: 'keytar' };
  }

  if (action === 'sandevistan') {
    const res = await invoke('move_to_spot', { spot: Math.random() < 0.5 ? 'dock_left' : 'perch' }).catch(
      () => null,
    );
    if (res?.ok) teleportTo(res, { pose: 'smirk', style: 'sandevistan' });
    if (reply && !muted) await speakText(reply);
    return { ok: true, action: 'sandevistan' };
  }

  if (action === 'dance') {
    musicActive = true;
    musicStartedAt = performance.now();
    musicFrameId = 'music-floor';
    if (reply && !muted) await speakText(reply);
    return { ok: true, action: 'dance' };
  }

  if (action === 'stop_roam') {
    autoRoam = false;
    if (reply && !muted) await speakText(reply);
    return { ok: true, autoRoam: false };
  }

  if (action === 'start_roam') {
    autoRoam = true;
    if (reply && !muted) await speakText(reply);
    return { ok: true, autoRoam: true };
  }

  if (action === 'reset_position') {
    const br = await invoke('move_to_spot', { spot: 'bottom_right' }).catch(() => null);
    if (br?.ok) teleportTo(br, { pose: 'neutral', style: 'lightning' });
    if (reply && !muted) await speakText(reply);
    return { ok: true, action: 'reset_position' };
  }

  if (action === 'set_voice_fx') {
    const idx = FX_MODES.indexOf((args.fx || '').toLowerCase());
    if (idx >= 0) fxIndex = idx;
    if (reply && !muted) await speakText(reply);
    return { ok: true, fx: FX_MODES[fxIndex] };
  }

  if (action === 'set_mood') {
    setMood(args.mood || 'happy');
    if (reply && !muted) await speakText(reply);
    return { ok: true, mood: currentBaseMood };
  }

  return { ok: false, error: `Unknown self action: ${action}` };
}

function tryInstantVoiceFastPath(transcript) {
  const lower = transcript.toLowerCase().trim();

  if (
    ['tutup capri', 'keluar capri', 'matiin capri', 'udahan capri', 'capri tutup', 'capri keluar'].some(
      (q) => lower.includes(q),
    )
  ) {
    executeSelfControl({ action: 'quit', reply_text: 'Sip Bos, cabut dulu!' });
    return true;
  }

  if (hiddenStandby || muted) {
    if (
      ['capri', 'woi capri', 'halo capri', 'hai capri', 'bangun', 'unmute', 'sini capri', 'nyalain suara', 'ngomong lagi'].some(
        (w) => lower.includes(w),
      )
    ) {
      executeSelfControl({ action: 'unmute', reply_text: 'Yo Bos! Udah melek nih.' });
      return true;
    }
    return true;
  }

  if (
    ['diam capri', 'capri diam', 'mute capri', 'sembunyi', 'hilang dulu', 'tidur dulu', 'jangan berisik'].some(
      (m) => lower.includes(m),
    )
  ) {
    executeSelfControl({ action: 'mute', reply_text: 'Oke gue ngumpet. Panggil aja kalau butuh!' });
    return true;
  }

  if (lower.includes('sandevistan')) {
    executeSelfControl({ action: 'sandevistan', reply_text: 'Sandevistan aktif, Bos!' });
    return true;
  }
  if (lower.includes('keytar') || lower.includes('main gitar')) {
    executeSelfControl({ action: 'keytar', reply_text: 'Gas nge-jam sebentar!' });
    return true;
  }
  if (lower.includes('joget') || lower.includes('dance')) {
    executeSelfControl({ action: 'dance', reply_text: 'Oke goyang dulu!' });
    return true;
  }
  if (lower.includes('gelantungan')) {
    executeSelfControl({ action: 'ceiling', reply_text: 'Naik atap dulu nih.' });
    return true;
  }
  if (lower.includes('duduk di window') || lower.includes('nemplok')) {
    executeSelfControl({ action: 'perch', reply_text: 'Nongkrong di atas window bentar ya.' });
    return true;
  }
  if (lower === 'pojok' || lower.includes('ke pojok') || lower.includes('balik pojok')) {
    executeSelfControl({ action: 'reset_position', reply_text: 'Balik pojok dulu, Bos.' });
    return true;
  }

  return false;
}

function compactImageHistory() {
  for (const item of history) {
    if (Array.isArray(item.content)) {
      item.content = item.content.map((part) =>
        part.type === 'image_url' ? { type: 'text', text: '[Screenshot sebelumnya]' } : part,
      );
    }
  }
}

async function sendVoiceTurn(userText) {
  if (!userText.trim() || inFlightRequest) return;
  inFlightRequest = true;
  thinking = true;
  activeClip = null;
  screenRig?.clear();
  setMood('thinking');

  history.push({ role: 'user', content: userText });
  while (history.length > 10) history.shift();

  const wantsDesktopTool = DESKTOP_INTENT_RE.test(userText);
  const toolsForTurn = wantsDesktopTool ? [SELF_CONTROL_TOOL, DESKTOP_CONTROL_TOOL] : [SELF_CONTROL_TOOL];
  const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const ctxMsg = {
    role: 'system',
    content: `[Konteks laptop: mode=${laptopState.activityMode}, app=${laptopState.fgExe || 'desktop'}, baterai=${laptopState.batteryPct}%, jam=${timeStr}]`,
  };

  try {
    let finalReply = '';
    let handledTerminalSelf = false;

    for (let step = 0; step < 5; step++) {
      const resp = await fetch(`${config.brainUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'capri-gemini-flash',
          stream: false,
          messages: [ctxMsg, ...history],
          tools: toolsForTurn,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Empty choice');

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        history.push(msg);
        for (const tc of msg.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}');
          } catch {}

          if (tc.function.name === 'capri_self_control') {
            await executeSelfControl(parsedArgs);
            handledTerminalSelf = true;
            break;
          }

          setMood('focused');
          let resultObj;
          try {
            resultObj = await invoke('exec_desktop_action', { args: parsedArgs });
          } catch (err) {
            resultObj = { ok: false, error: String(err) };
          }

          if (resultObj?.dataUrl) {
            const imgUrl = resultObj.dataUrl;
            const lean = { ...resultObj };
            delete lean.dataUrl;
            lean.note = 'Screenshot dilampirkan pada pesan user berikutnya.';
            history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(lean) });
            history.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Ini screenshot layar terbaru, analisa singkat dan lanjutkan.' },
                { type: 'image_url', image_url: { url: imgUrl } },
              ],
            });
          } else {
            history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(resultObj) });
          }
        }
        if (handledTerminalSelf) break;
        continue;
      }

      finalReply = (msg.content || '').trim();
      history.push({ role: 'assistant', content: finalReply });
      break;
    }

    thinking = false;
    if (!handledTerminalSelf && finalReply) {
      setMood(guessMoodFromReply(finalReply));
      await speakText(finalReply);
      setMood('neutral');
    }
  } catch (err) {
    thinking = false;
    console.warn('Voice turn err:', err);
    flashOverrideMood('concerned', 1800);
    setMood('neutral');
  } finally {
    compactImageHistory();
    inFlightRequest = false;
  }
}

function guessMoodFromReply(txt) {
  const l = (txt || '').toLowerCase();
  if (l.includes('haha') || l.includes('wkwk') || l.includes('lucu')) return 'idle-laughing';
  if (l.includes('heh') || l.includes('yaelah') || l.includes('gitu')) return 'smirk';
  if (l.includes('keren') || l.includes('sip') || l.includes('mantap')) return 'happy';
  if (l.includes('wah') || l.includes('serius')) return 'surprised';
  if (l.includes('maaf') || l.includes('gagal') || l.includes('error')) return 'concerned';
  return 'attentive';
}

async function startMicVadWithRetry() {
  for (let i = 0; i < 6; i++) {
    if (await startMicVad()) return true;
    await new Promise((r) => setTimeout(r, 1400));
  }
  return false;
}

async function startMicVad() {
  if (micActive) return true;
  try {
    ensureAudioCtx();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    micActive = true;

    micSource = audioCtx.createMediaStreamSource(micStream);

    // Bandpass branch (300-3200Hz) purely for fan/keyboard noise rejection in VAD
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    vadAnalyser = audioCtx.createAnalyser();
    vadAnalyser.fftSize = 2048;
    vadTimeBuf = new Float32Array(vadAnalyser.fftSize);
    micSource.connect(hp);
    hp.connect(lp);
    lp.connect(vadAnalyser);

    // Raw PCM capture branch -> zeroGain
    micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    const zeroGain = audioCtx.createGain();
    zeroGain.gain.value = 0;
    micSource.connect(micProcessor);
    micProcessor.connect(zeroGain);
    zeroGain.connect(audioCtx.destination);

    isCapturingSpeech = false;
    speechFrames = 0;
    silenceFrames = 0;
    peakRawRms = 0;
    preRollBuffer = [];
    recordedPcm = [];

    micProcessor.onaudioprocess = (ev) => {
      if (!micActive || speaking || inFlightRequest) return;
      const input = ev.inputBuffer.getChannelData(0);

      let rawSum = 0;
      for (let i = 0; i < input.length; i++) rawSum += input[i] * input[i];
      const rawRms = Math.sqrt(rawSum / input.length);

      vadAnalyser.getFloatTimeDomainData(vadTimeBuf);
      let bpSum = 0;
      for (let i = 0; i < vadTimeBuf.length; i++) bpSum += vadTimeBuf[i] * vadTimeBuf[i];
      const filteredRms = Math.sqrt(bpSum / vadTimeBuf.length);

      const frameCopy = new Float32Array(input);
      if (!isCapturingSpeech) {
        noiseFloor = Math.min(0.025, noiseFloor * 0.96 + filteredRms * 0.04);
        preRollBuffer.push(frameCopy);
        if (preRollBuffer.length > 3) preRollBuffer.shift();
      }

      const threshold = Math.max(0.014, noiseFloor * 3.2);
      if (filteredRms > threshold) {
        if (!isCapturingSpeech) {
          isCapturingSpeech = true;
          speechFrames = 0;
          silenceFrames = 0;
          peakRawRms = 0;
          recordedPcm = [...preRollBuffer];
          if (!muted && !hiddenStandby) {
            setMood('attentive');
          }
        }
        speechFrames++;
        silenceFrames = 0;
        if (rawRms > peakRawRms) peakRawRms = rawRms;
        recordedPcm.push(frameCopy);
      } else if (isCapturingSpeech) {
        recordedPcm.push(frameCopy);
        silenceFrames++;
        const capturedSec = (recordedPcm.length * 4096) / audioCtx.sampleRate;
        if (silenceFrames >= 9 || capturedSec >= 10.0) {
          const chunks = recordedPcm;
          const validSpeech = speechFrames >= 4 && peakRawRms >= 0.016;
          recordedPcm = [];
          isCapturingSpeech = false;
          speechFrames = 0;
          silenceFrames = 0;
          peakRawRms = 0;
          if (validSpeech) {
            flushVadAudio(chunks, audioCtx.sampleRate);
          } else {
            setMood('neutral');
          }
        }
      }
    };
    return true;
  } catch (e) {
    console.warn('Auto mic init retryable err:', e);
    micActive = false;
    return false;
  }
}

async function flushVadAudio(chunks, srcRate) {
  const wavBlob = encodeMonoWav16k(chunks, srcRate);
  if (!wavBlob || wavBlob.size < 4000) {
    setMood('neutral');
    return;
  }

  try {
    if (!muted && !hiddenStandby) setMood('thinking');
    const form = new FormData();
    form.append('file', wavBlob, 'vad.wav');
    form.append('language', 'id-ID');
    const r = await fetch(`${config.brainUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    });
    if (!r.ok) {
      setMood('neutral');
      return;
    }
    const j = await r.json();
    const transcript = (j.text || '').trim();
    if (transcript.length < 2) {
      setMood('neutral');
      return;
    }

    if (tryInstantVoiceFastPath(transcript)) return;
    await sendVoiceTurn(transcript);
  } catch (e) {
    console.warn('STT flush err:', e);
    setMood('neutral');
  }
}

function encodeMonoWav16k(chunks, srcRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total === 0) return null;

  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const dstRate = 16000;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(merged.length / ratio);
  if (outLen < 2400) return null;

  const downsampled = new Float32Array(outLen);
  let peak = 0;
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += merged[j];
    const val = sum / (end - start);
    downsampled[i] = val;
    const absV = Math.abs(val);
    if (absV > peak) peak = absV;
  }

  if (peak < 0.01) return null;
  const gain = peak < 0.7 ? Math.min(10, 0.85 / peak) : 1;

  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);
  const writeStr = (pos, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, dstRate, true);
  view.setUint32(28, dstRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, outLen * 2, true);

  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, downsampled[i] * gain));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

init().catch((e) => console.error('Capri init error:', e));
