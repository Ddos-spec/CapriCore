// SPDX-License-Identifier: GPL-3.0-only
import {
  CHANNELS,
  createRenderer,
  resolvePose,
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

let actorSize = 320;
const CANVAS_EXTENT = 1254;
const MAX_CACHED_SPRITES = 10;
const PINNED_SPRITES = new Set([
  'neutral',
  'smirk',
  'attentive',
  'thinking',
  'surprised',
  'pose-sit-edge',
]);

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
let headpat = null;
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
const spriteLru = [];
const pendingLoads = new Map();
let introImages = [];

// Stage position & spring physics
const stage = {
  x: Math.max(0, (window.innerWidth || 1920) - actorSize - 24),
  y: Math.max(0, (window.innerHeight || 1080) - actorSize - 48),
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
let prevAudioLevel = 0;
let speechNod = 0;
let inFlightRequest = false;
let introPlaying = true;
let dragActive = false;
let teleporting = false;
let breachInFlight = false;
let stuntCycleIndex = 0;

let activeClip = null;
let glitchUntil = 0;
let impactUntil = 0;
let musicActive = false;
let musicStartedAt = 0;
let musicFrameId = 'music-floor';

// Live cursor, whip & curiosity tease physics
let cursorPos = {
  x: stage.x,
  y: stage.y,
  lastX: stage.x,
  lastY: stage.y,
  lastAt: performance.now(),
  stillSince: performance.now(),
};
let lastWhipAt = 0;
let lastTeaseAt = 0;
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

const SELF_ACTION_INTENT_RE =
  /\b(diam|mute|unmute|bisu|tutup|keluar|matiin|udahan|sembunyi|hilang|tidur|bangun|pindah|nemplok|duduk|gelantungan|atap|atas|kiri|kanan|pojok|bawah|keytar|gitar|joget|dance|sandevistan|teleport|keluyuran|roam|suara|efek|fx|radio|hologram|cyber|ekspresi|senyum|marah)\b/i;

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

function touchSpriteLru(id) {
  const idx = spriteLru.indexOf(id);
  if (idx >= 0) spriteLru.splice(idx, 1);
  spriteLru.push(id);
  while (spriteImgs.size > MAX_CACHED_SPRITES) {
    const evictIdx = spriteLru.findIndex((cand) => !PINNED_SPRITES.has(cand) && cand !== currentBaseMood && cand !== overrideMood);
    if (evictIdx < 0) break;
    const evictedId = spriteLru.splice(evictIdx, 1)[0];
    spriteImgs.delete(evictedId);
  }
}

function ensureSpriteLoaded(id) {
  const targetId = spriteUrls.has(id) ? id : 'neutral';
  if (spriteImgs.has(targetId)) {
    touchSpriteLru(targetId);
    return Promise.resolve(spriteImgs.get(targetId));
  }
  if (pendingLoads.has(targetId)) {
    return pendingLoads.get(targetId);
  }
  const url = spriteUrls.get(targetId);
  if (!url) return Promise.resolve(null);
  const p = preloadImage(url).then((img) => {
    pendingLoads.delete(targetId);
    if (img) {
      spriteImgs.set(targetId, img);
      touchSpriteLru(targetId);
    }
    return img;
  });
  pendingLoads.set(targetId, p);
  return p;
}

function getSpriteImg(id) {
  if (spriteImgs.has(id)) {
    touchSpriteLru(id);
    return spriteImgs.get(id);
  }
  void ensureSpriteLoaded(id);
  return spriteImgs.get('neutral') || null;
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
  const target = spriteUrls.has(mood) ? mood : 'neutral';
  currentBaseMood = target;
  void ensureSpriteLoaded(target);
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

function setActorScaleSize(newSize) {
  actorSize = Math.round(Math.max(220, Math.min(420, newSize)));
  elActor.style.width = `${actorSize}px`;
  elActor.style.height = `${actorSize}px`;
  const c = clampActorPos(stage.x, stage.y);
  stage.x = c.x;
  stage.y = c.y;
  triggerSquish(1.06, 0.94);
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
  const maxX = Math.max(0, (config.screenWidth || window.innerWidth) - actorSize + 52);
  const maxY = Math.max(0, (config.screenHeight || window.innerHeight) - actorSize + 12);
  return {
    x: Math.max(-52, Math.min(maxX, x)),
    y: Math.max(-28, Math.min(maxY, y)),
  };
}

function startClip(id, { frameId, side = 'left', onEnd } = {}) {
  wave.stop();
  const cel = registeredCelClip(id);
  const targetFrame = frameId || cel?.frameId || 'pose-sit-edge';
  void ensureSpriteLoaded(targetFrame);
  if (cel) {
    void prepareRegisteredCel(id);
    activeClip = {
      id,
      frameId: targetFrame,
      side,
      startedAt: performance.now(),
      durationMs: cel.durationMs,
      onEnd,
    };
    return;
  }
  const sample0 = sampleScreenInteraction(id, 1, { frameId: targetFrame, side });
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
    frameId: targetFrame,
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

  headpat = new AvatarHeadpat(elActor);
  headpat.ensureFaceSrc();

  musicNoteImgs = getMusicNoteAssets(base).map(({ url }) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = url;
    return im;
  });

  const v1List = (config.manifest && config.manifest.sprites) || [];
  for (const item of v1List) {
    spriteUrls.set(item.id, `${base}/capri/sprites/v1/${item.file}`);
  }
  if (!spriteUrls.has('neutral')) {
    spriteUrls.set('neutral', `${base}/capri/sprites/v1/capri-neutral.png`);
  }

  const poseList = (config.poses && config.poses.sprites) || [];
  for (const p of poseList) {
    spriteUrls.set(p.id, `${base}/capri/sprites/poses-v2/PNG/${p.file}`);
  }

  spriteUrls.set('music-floor', `${base}/default/capri-music-v1/capri-music-floor.png`);
  spriteUrls.set('music-window', `${base}/default/capri-music-v1/capri-music-window.png`);

  // RAM Diet: Preload only 6 pinned core sprites + 7 intro frames + prime main keytar sheet
  const introMeta = (config.intro && config.intro.frames) || [];
  const introPromise = Promise.all(
    introMeta.map((f) => preloadImage(`${base}/capri/intro-v1/${f.file}`)),
  );
  const corePromise = Promise.all(Array.from(PINNED_SPRITES).map((id) => ensureSpriteLoaded(id)));
  const celPromise = prepareRegisteredCel('ledge-keytar');

  [introImages] = await Promise.all([introPromise, corePromise, celPromise]);

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
    x: (config.screenWidth || 1920) - actorSize - 24,
    y: (config.screenHeight || 1080) - actorSize - 48,
  }));
  stage.x = br.x;
  stage.y = br.y;
  updateActorDomPosition();
  syncSourceImg('neutral');

  await setupTauriEvents();
  startHitRectSyncLoop();
  requestAnimationFrame(renderFrameLoop);

  introPlaying = true;
  elGlCanvas.style.opacity = '0';
  breachFx.playStartupIntroFx({
    rect: { x: stage.x, y: stage.y, width: actorSize, height: actorSize },
    introImages: introImages.filter(Boolean),
    onDone: () => {
      introImages = [];
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
    const distMoved = Math.hypot(dx, dy);
    const speed = (distMoved / dt) * 1000;

    if (distMoved > 4) {
      cursorPos.stillSince = now;
    }

    cursorPos.x = p.x;
    cursorPos.y = p.y;
    cursorPos.lastX = p.x;
    cursorPos.lastY = p.y;
    cursorPos.lastAt = now;
    if (p.screenW) config.screenWidth = p.screenW;
    if (p.screenH) config.screenHeight = p.screenH;

    const cx = stage.x + actorSize * 0.5;
    const cy = stage.y + actorSize * 0.44;
    const curDist = Math.hypot(p.x - cx, p.y - cy);

    // Fast cursor whip near Capri -> 2-frame TRIGGER impact flinch!
    if (
      !hiddenStandby &&
      !dragActive &&
      !introPlaying &&
      speed > 2600 &&
      curDist < 140 &&
      now - lastWhipAt > 3600
    ) {
      lastWhipAt = now;
      triggerImpact(130, 260);
      triggerSquish(0.91, 1.09);
      breachFx.triggerImpactStar(cx, cy, actorSize * 0.44);
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
  void ensureSpriteLoaded(id);
  overrideMood = id;
  setTimeout(() => {
    if (overrideMood === id) overrideMood = null;
  }, ms);
}

function renderFrameLoop(now) {
  requestAnimationFrame(renderFrameLoop);
  if (hiddenStandby || introPlaying || teleporting || breachInFlight) return;

  updateActorDomPosition();

  // Curiosity cursor tease when pointer idles 60-220px away for >4.5s
  const cxCur = stage.x + actorSize * 0.5;
  const cyCur = stage.y + actorSize * 0.44;
  const curDist = Math.hypot(cursorPos.x - cxCur, cursorPos.y - cyCur);
  if (
    !dragActive &&
    !speaking &&
    !thinking &&
    !sleepingAfk &&
    !muted &&
    !activeClip &&
    curDist >= 60 &&
    curDist <= 220 &&
    now - cursorPos.stillSince > 4500 &&
    now - lastTeaseAt > 14000
  ) {
    lastTeaseAt = now;
    cursorPos.stillSince = now;
    const sideLean = cursorPos.x < cxCur ? -4.2 : 4.2;
    stage.tiltDeg = sideLean;
    flashOverrideMood('skeptical', 1100);
    breachFx.spawnMicroSlash(cursorPos.x, cursorPos.y, Math.atan2(cursorPos.y - cyCur, cursorPos.x - cxCur), '#ff003d');
    breachFx.spawnImpactBurst(cursorPos.x, cursorPos.y, { color: '#ff003d', count: 6, radius: 36 });
  }

  // Ambient blinking when standing
  if (!speaking && !thinking && !activeClip && !musicActive && !muted && !sleepingAfk && !overrideMood) {
    if (now - lastBlinkAt > nextBlinkDelay && !currentBaseMood.startsWith('pose-')) {
      lastBlinkAt = now;
      nextBlinkDelay = 2600 + Math.random() * 3400;
      blinkPhaseUntil = now + 150;
      void ensureSpriteLoaded('idle-blink_half');
      void ensureSpriteLoaded('idle-blink_closed');
    }
  }
  if (now < blinkPhaseUntil) {
    const rem = blinkPhaseUntil - now;
    blinkFrame = rem > 90 ? 'idle-blink_half' : rem > 28 ? 'idle-blink_closed' : 'idle-blink_half';
  } else {
    blinkFrame = null;
  }

  // Audio-reactive amplitude + syllable nod + plosive micro-glitch
  if (speaking && analyser && freqData) {
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    const bins = Math.min(28, freqData.length);
    for (let i = 1; i < bins; i++) sum += freqData[i];
    prevAudioLevel = audioLevel;
    audioLevel = Math.min(1, sum / (bins - 1) / 135);
    if (audioLevel - prevAudioLevel > 0.12) {
      speechNod += (Math.random() < 0.5 ? 1 : -1) * 3.8;
    }
    if (audioLevel > 0.58 && now >= glitchUntil) {
      glitchUntil = now + 38;
    }
  } else if (!speaking) {
    audioLevel *= 0.8;
  }
  speechNod *= 0.78;

  if (wave.image) {
    elGlCanvas.style.opacity = '0';
    elOverlayCanvas.style.opacity = '0';
    return;
  }

  const targetId = activeClip ? activeClip.frameId : activeSpriteId();
  const baseImg = syncSourceImg(targetId);
  if (!baseImg || !baseImg.complete) return;

  const poseKey = resolvePose(targetId);
  const tSec = now / 1000;
  let channels = {
    ...CHANNELS,
    pose: poseKey,
    breath: 0.5 + 0.5 * Math.sin(tSec * (sleepingAfk || muted ? 1.5 : 2.3)),
    lean: Math.sin(tSec * 1.15) * 1.1 + stage.tiltDeg * 0.25,
    lift: Math.sin(tSec * 2.3) * 3.2,
    head: Math.sin(tSec * 0.9) * 1.4 + speechNod + (speaking ? Math.sin(tSec * 8.5) * audioLevel * 3.2 : 0),
    headY: Math.sin(tSec * 2.3 + 0.5) * 2.2,
  };

  const cx = stage.x + actorSize * 0.5;
  const cy = stage.y + actorSize * 0.36;
  const gx = Math.max(-1, Math.min(1, (cursorPos.x - cx) / 380));
  const gy = Math.max(-1, Math.min(1, (cursorPos.y - cy) / 280));
  const activeGaze = { x: gx, y: gy };

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

  elGlCanvas.style.opacity = '1';
  elOverlayCanvas.style.opacity = '1';

  // Cap ambient WebGL mesh deformation at Studio TRIGGER 24fps unless speaking/glitching/dragging
  if (!speaking && now >= glitchUntil && now >= impactUntil && !dragActive && now - lastGlTickAt < 40) {
    return;
  }
  lastGlTickAt = now;

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
    } else {
      void ensureSpriteLoaded(gazeSprite);
    }
  }

  const shape = visemes.sample(now, speaking, audioLevel);
  const headpatActive = Boolean(headpat && headpat.image(elSourceImg) !== elSourceImg);
  let composited = headpatActive ? headpat.image(elSourceImg) : renderImg;
  if (elSourceImg.complete && elSourceImg.naturalWidth === 1254 && !headpatActive) {
    mouthLayer.update(composited, shape, renderBaseId);
    composited = mouthLayer.image(composited);
  }

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

  elOverlayCtx.clearRect(0, 0, CANVAS_EXTENT, CANVAS_EXTENT);
  if (!glRenderer && renderImg) {
    elOverlayCtx.drawImage(renderImg, 0, 0, CANVAS_EXTENT, CANVAS_EXTENT);
  }
  if (!muted && !sleepingAfk && !blinkFrame && !headpatActive && !overrideMood) {
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
  wave.stop();
  await ensureSpriteLoaded(pose);
  const clamped = clampActorPos(targetBox.x, targetBox.y);
  const fromBox = { x: stage.x, y: stage.y, size: actorSize };
  const toBox = { x: clamped.x, y: clamped.y, size: actorSize };

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
  breachInFlight = true;
  wave.stop();
  screenRig?.clear();
  elActor.classList.remove('hidden-standby');
  playBreachSummonSound(audioCtx);

  const w = config.screenWidth || window.innerWidth || 1920;
  const h = config.screenHeight || window.innerHeight || 1080;

  let tx;
  let ty;
  if (Number.isFinite(curX) && Number.isFinite(curY)) {
    const onLeft = curX > w * 0.5;
    tx = onLeft ? curX - actorSize - 44 : curX + 44;
    ty = curY - actorSize * 0.55;
  } else {
    tx = w - actorSize - 28;
    ty = h - actorSize - 52;
  }
  const dest = clampActorPos(tx, ty);
  const fromBox = {
    x: dest.x + (dest.x > w * 0.5 ? 240 : -240),
    y: Math.max(0, dest.y - 260),
    size: actorSize,
  };
  const toBox = { x: dest.x, y: dest.y, size: actorSize };

  elGlCanvas.style.opacity = '0';
  elOverlayCanvas.style.opacity = '0';

  breachFx.playRedBreachSummon({
    from: fromBox,
    to: toBox,
    spriteImg: getSpriteImg('smirk'),
    arrivalImg: getSpriteImg('smirk'),
    style: source === 'debug' ? 'lightning' : Math.random() < 0.35 ? 'sandevistan' : 'lightning',
    onArrive: () => {
      breachInFlight = false;
      stage.x = toBox.x;
      stage.y = toBox.y;
      setMood('smirk');
      triggerImpact(130, 320);
      triggerSquish(1.1, 0.89);
      elGlCanvas.style.opacity = '1';
      elOverlayCanvas.style.opacity = '1';
      if (source !== 'debug') void wave.play();
      if (source === 'hotkey') {
        const lines = [
          'Yo Bos! Ada apaan manggil mendadak?',
          'Hadir Bos. Sistem aman, ada yang mau diberesin?',
          'Dipanggil langsung nongol nih, mau ngapain kita?',
        ];
        speakText(lines[Math.floor(Math.random() * lines.length)]);
      } else if (source === 'voice') {
        speakText('Gue di sini Bos, ngomong aja.');
      }
    },
  });
}

function handleLaptopActivityUpdate(wasIdle) {
  const now = performance.now();

  if (laptopState.batteryPct > 0 && laptopState.batteryPct < 20 && !laptopState.onAc) {
    if (!batteryWarnedInCycle && !muted && !hiddenStandby && !speaking && !inFlightRequest) {
      batteryWarnedInCycle = true;
      breachFx.spawnImpactBurst(stage.x + actorSize * 0.5, stage.y + actorSize * 0.4, {
        color: '#ff003d',
        count: 16,
        radius: 130,
      });
      triggerImpact(150, 420);
      flashOverrideMood('concerned', 3200);
      speakText(
        `Eh Bos, baterai laptop tinggal ${laptopState.batteryPct} persen tuh! Colok charger dulu gih sebelum jeglek.`,
      );
    }
  } else if (laptopState.onAc || laptopState.batteryPct >= 30) {
    batteryWarnedInCycle = false;
  }

  if (laptopState.idleMs > 300_000 && !sleepingAfk && !muted && !hiddenStandby && !speaking && !dragActive) {
    sleepingAfk = true;
    musicActive = false;
    activeClip = null;
    const brX = Math.max(20, (config.screenWidth || 1920) - actorSize - 26);
    const brY = Math.max(0, (config.screenHeight || 1080) - actorSize - 48);
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

  if (musicActive && laptopState.activityMode !== 'music' && now - lastActivityReactAt > 12000) {
    musicActive = false;
    setMood('neutral');
  }

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
    void ensureSpriteLoaded(musicFrameId);
    return;
  }

  if (laptopState.fgFullscreen || laptopState.activityMode === 'video_game') {
    const cornerX = (config.screenWidth || 1920) - actorSize + 44;
    if (Math.abs(stage.x - cornerX) > 90) {
      lastActivityReactAt = now;
      teleportTo(
        { x: cornerX, y: (config.screenHeight || 1080) - actorSize - 48 },
        { pose: 'pose-dock-right', style: 'sandevistan' },
      );
    }
    return;
  }

  if (laptopState.activityMode === 'coding' && laptopState.fgRect?.w > 360) {
    const r = laptopState.fgRect;
    const tx = Math.max(0, Math.min((config.screenWidth || 1920) - actorSize, r.x + r.w - actorSize - 14));
    const ty = Math.max(-18, Math.min((config.screenHeight || 1080) - actorSize, r.y - actorSize * 0.56));
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

// Dragging with official SVG AvatarDragTether + velocity fling wall-slam + smart snap
let dragStartMouse = null;
let dragStartStage = null;
let dragAnchorCenter = null;
let dragLastMouse = null;
let dragLastAt = 0;
let dragVx = 0;
let dragVy = 0;
let dragSeed = 1337;
let pokeTimestamps = [];

elActor.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  ensureAudioCtx();
  dragStartMouse = { x: e.clientX, y: e.clientY };
  dragLastMouse = { x: e.clientX, y: e.clientY };
  dragLastAt = performance.now();
  dragStartStage = { x: stage.x, y: stage.y };
  dragAnchorCenter = { x: stage.x + actorSize * 0.5, y: stage.y + actorSize * 0.55 };
  dragVx = 0;
  dragVy = 0;
  dragSeed = (Date.now() & 0xffffff) >>> 0;
  dragActive = false;
});

window.addEventListener('mousemove', (e) => {
  if (!dragStartMouse) return;
  const dx = e.clientX - dragStartMouse.x;
  const dy = e.clientY - dragStartMouse.y;
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
  const instVx = ((e.clientX - dragLastMouse.x) / dt) * 16;
  const instVy = ((e.clientY - dragLastMouse.y) / dt) * 16;
  dragVx = dragVx * 0.45 + instVx * 0.55;
  dragVy = dragVy * 0.45 + instVy * 0.55;
  dragLastMouse = { x: e.clientX, y: e.clientY };
  dragLastAt = now;
  stage.tiltDeg = Math.max(-16, Math.min(16, dragVx * 1.1));

  dragTether.draw({
    from: dragAnchorCenter,
    to: { x: stage.x + actorSize * 0.5, y: stage.y + actorSize * 0.55 },
    intensity: 88,
    chaos: 64,
    seed: dragSeed,
  });
});

window.addEventListener('mouseup', () => {
  if (!dragStartMouse) return;
  const wasDragging = dragActive;
  const flingVx = dragVx;
  const flingVy = dragVy;
  dragStartMouse = null;
  dragActive = false;
  if (!wasDragging) return;

  dragTether.clear();
  invoke('set_dragging', { active: false }).catch(() => {});
  lastAutoRoamAt = performance.now();

  const w = config.screenWidth || window.innerWidth || 1920;
  const h = config.screenHeight || window.innerHeight || 1080;

  // High-velocity Drag Fling -> Sandevistan Wall-Slam!
  if (Math.hypot(flingVx, flingVy) > 20) {
    const projX = Math.max(-46, Math.min(w - actorSize + 46, stage.x + flingVx * 18));
    const projY = Math.max(-18, Math.min(h - actorSize - 42, stage.y + flingVy * 18));
    if (projY < 90) {
      teleportTo(
        { x: projX, y: -18 },
        {
          pose: 'pose-ceiling',
          style: 'sandevistan',
          clip: { id: 'hang-catch', frameId: 'pose-ceiling' },
          onArrive: () => breachFx.triggerImpactStar(projX + actorSize * 0.5, 48, 170),
        },
      );
    } else if (projX < 70) {
      teleportTo(
        { x: -46, y: projY },
        {
          pose: 'pose-dock-left',
          style: 'sandevistan',
          clip: { id: 'edge-lean', frameId: 'pose-dock-left', side: 'left' },
          onArrive: () => breachFx.triggerImpactStar(36, projY + actorSize * 0.5, 165),
        },
      );
    } else if (projX > w - actorSize - 70) {
      teleportTo(
        { x: w - actorSize + 46, y: projY },
        {
          pose: 'pose-dock-right',
          style: 'sandevistan',
          clip: { id: 'edge-lean', frameId: 'pose-dock-right', side: 'right' },
          onArrive: () => breachFx.triggerImpactStar(w - 36, projY + actorSize * 0.5, 165),
        },
      );
    } else {
      teleportTo(
        { x: projX, y: h - actorSize - 48 },
        {
          pose: 'pose-sit-floor',
          style: 'sandevistan',
          onArrive: () => breachFx.triggerImpactStar(projX + actorSize * 0.5, h - 64, 175),
        },
      );
    }
    return;
  }

  if (stage.y < 85) {
    stage.y = -18;
    setMood('pose-ceiling');
    startClip('hang-catch', { frameId: 'pose-ceiling' });
    triggerSquish(0.92, 1.1);
  } else if (stage.x < 75) {
    stage.x = -46;
    setMood('pose-dock-left');
    startClip('edge-lean', { frameId: 'pose-dock-left', side: 'left' });
  } else if (stage.x > w - actorSize - 75) {
    stage.x = w - actorSize + 46;
    setMood('pose-dock-right');
    startClip('edge-lean', { frameId: 'pose-dock-right', side: 'right' });
  } else if (
    laptopState.fgRect?.w > 300 &&
    Math.abs(stage.y + actorSize * 0.58 - laptopState.fgRect.y) < 75
  ) {
    stage.y = laptopState.fgRect.y - actorSize * 0.56;
    setMood('pose-sit-edge');
    startClip('bar-perch', { frameId: 'pose-sit-edge', side: 'left' });
    triggerSquish(1.09, 0.9);
  } else {
    breachFx.triggerImpactStar(stage.x + actorSize * 0.5, stage.y + actorSize * 0.85, 130);
    breachFx.spawnImpactBurst(stage.x + actorSize * 0.5, stage.y + actorSize * 0.85, {
      color: '#ff003d',
      count: 12,
      radius: 92,
    });
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

// Double-click -> instant flashy stunt cycle
elActor.addEventListener('dblclick', (e) => {
  if (dragActive) return;
  e.preventDefault();
  ensureAudioCtx();
  const mode = stuntCycleIndex++ % 4;
  if (mode === 0) {
    executeSelfControl({ action: 'sandevistan' });
  } else if (mode === 1) {
    startClip('ledge-keytar', { frameId: 'pose-sit-edge' });
  } else if (mode === 2) {
    void wave.play();
  } else {
    executeSelfControl({ action: 'ceiling' });
  }
});

// Wheel zoom -> spring resize 220..420 px
elActor.addEventListener(
  'wheel',
  (e) => {
    setActorScaleSize(actorSize + (e.deltaY < 0 ? 22 : -22));
  },
  { passive: true },
);

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
    breachFx.triggerImpactStar(stage.x + actorSize * 0.5, stage.y + actorSize * 0.42, 130);
    breachFx.spawnMicroSlash(stage.x + actorSize * 0.5, stage.y + actorSize * 0.4, -0.5, '#ff003d');
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

function fireHeadpat(clientX, clientY, quiet = false) {
  const now = performance.now();
  if (!quiet && now - lastPatFireAt < 750) return;
  lastPatFireAt = now;
  ensureAudioCtx();
  playHeadpatChime(audioCtx);
  triggerSquish(1.06, 0.93);
  wave.stop();
  activeClip = null;
  screenRig?.clear();
  const fid = activeSpriteId();
  syncSourceImg(fid);
  headpat?.ensureFaceSrc();
  headpat?.play(
    elSourceImg,
    { x: clientX, y: clientY },
    { x: 0, y: 0, width: actorSize, height: actorSize },
    true,
    fid,
  );
  if (!quiet && !muted && !speaking && !inFlightRequest && Math.random() < 0.7) {
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

    wave.stop();
    activeClip = null;
    screenRig?.clear();
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
    breachFx.spawnImpactBurst(stage.x + actorSize * 0.5, stage.y + actorSize * 0.5, {
      color: '#ff003d',
      count: 14,
      radius: 110,
    });
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
    breachFx.spawnImpactBurst(stage.x + actorSize * 0.5, stage.y + actorSize * 0.5, {
      color: '#ff003d',
      count: 22,
      radius: 170,
    });
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
    void ensureSpriteLoaded('music-floor');
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
  const wantsSelfTool = SELF_ACTION_INTENT_RE.test(userText);
  const toolsForTurn = wantsDesktopTool
    ? [SELF_CONTROL_TOOL, DESKTOP_CONTROL_TOOL]
    : wantsSelfTool
      ? [SELF_CONTROL_TOOL]
      : [];

  const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const ctxMsg = {
    role: 'system',
    content: `[Konteks laptop: mode=${laptopState.activityMode}, app=${laptopState.fgExe || 'desktop'}, baterai=${laptopState.batteryPct}%, jam=${timeStr}]`,
  };

  try {
    let finalReply = '';
    let handledTerminalSelf = false;

    for (let step = 0; step < 5; step++) {
      const reqBody = {
        model: 'capri-gemini-flash',
        stream: false,
        messages: [ctxMsg, ...history],
      };
      if (toolsForTurn.length > 0) {
        reqBody.tools = toolsForTurn;
      }

      const resp = await fetch(`${config.brainUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
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

// Deterministic debug & verification hooks
window.__CAPRI_DEBUG__ = {
  triggerSummon: (cx, cy) => triggerRedBreachSummon('debug', cx, cy),
  triggerHeadpat: () => {
    const r = elActor.getBoundingClientRect();
    fireHeadpat(r.left + r.width * 0.5, r.top + r.height * 0.18, true);
  },
  triggerCel: async (id = 'ledge-keytar') => {
    wave.stop();
    activeClip = null;
    const fid = id === 'ledge-keytar' ? 'pose-sit-edge' : 'pose-ceiling';
    await ensureSpriteLoaded(fid);
    await prepareRegisteredCel(id);
    setMood(fid);
    syncSourceImg(fid);
    startClip(id, { frameId: fid });
  },
  triggerDragTether: () => {
    dragActive = true;
    const fx = stage.x - 220;
    const fy = stage.y - 140;
    dragTether.draw({
      from: { x: fx, y: fy },
      to: { x: stage.x + actorSize * 0.5, y: stage.y + actorSize * 0.55 },
      intensity: 95,
      chaos: 70,
      seed: 90210,
    });
  },
  clearDragTether: () => {
    dragActive = false;
    dragTether.clear();
  },
  triggerImpact: () => {
    triggerImpact(450, 450);
    breachFx.triggerImpactStar(stage.x + actorSize * 0.5, stage.y + actorSize * 0.45, 185);
    breachFx.spawnImpactBurst(stage.x + actorSize * 0.5, stage.y + actorSize * 0.45, {
      color: '#ff003d',
      count: 16,
      radius: 140,
    });
  },
  getState: () => ({
    x: stage.x,
    y: stage.y,
    actorSize,
    mood: currentBaseMood,
    cachedSprites: spriteImgs.size,
    introPlaying,
    activeClip: activeClip?.id || null,
  }),
};

init().catch((e) => console.error('Capri init error:', e));
