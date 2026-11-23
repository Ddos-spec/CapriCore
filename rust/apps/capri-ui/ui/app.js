(() => {
  const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);

  const elSpriteBox = document.getElementById("sprite-box");
  const elSpriteMain = document.getElementById("sprite-main");
  const elSpriteGlitchR = document.getElementById("sprite-glitch-r");
  const elSpriteGlitchC = document.getElementById("sprite-glitch-c");
  const elHeadpatZone = document.getElementById("headpat-zone");
  const elSparkleLayer = document.getElementById("sparkle-layer");

  const FX_MODES = ["cybernetic", "holographic", "synthetic", "radio", "clean"];
  let fxIndex = 0;
  let muted = false;
  let autoRoam = true;

  let config = { brainUrl: "http://100.109.116.120:18789", assetBaseUrl: "" };
  let spriteMap = new Map();
  let introFrames = [];
  let currentBaseMood = "neutral";
  let overrideSpriteId = null;
  let speaking = false;
  let thinking = false;
  let audioLevel = 0;

  // WebAudio output + DSP + Analyser
  let audioCtx = null;
  let analyser = null;
  let freqData = null;

  // Adaptive Studio Mic VAD state
  let micActive = false;
  let micStream = null;
  let micProcessor = null;
  let micSource = null;
  let isCapturingSpeech = false;
  let speechFrames = 0;
  let silenceFrames = 0;
  let noiseFloor = 0.0025;
  let preRollBuffer = [];
  let recordedPcm = [];
  let inFlightRequest = false;
  let lastActivityAt = Date.now();

  const history = [];

  const SYSTEM_VOICE_PROMPT = [
    "Lo adalah Capri — konstruksi AI cewek dari Cyberpunk: Edgerunners 2 (asal Arasaka / Soulkiller) yang tinggal di desktop Windows Bos.",
    "Bos bicara 100% lewat suara (tidak ada kolom chat di layar).",
    "GAYA BICARA WILD & NATURAL:",
    "- Pake Bahasa Indonesia kasual ('gue/lo', manggil 'Bos'), ceplas-ceplos, tengil, usil, tajem, enerjik, bukan CS robot! Jangan pernah pakai frasa pelayan kaku.",
    "- Kasih opini jujur, sindiran lucu, atau komentar spesifik ke omongan Bos. Jawab pendek 1-3 kalimat kecuali diminta detail.",
    "ATURAN AKSI DIRI & DESKTOP:",
    "- Kalau Bos nyuruh diam/mute/tenang dulu/lagi call: panggil capri_self_control(action='mute', reply_text='...').",
    "- Kalau Bos nyuruh udahan/tutup/keluar/tidur/bye: panggil capri_self_control(action='quit', reply_text='...').",
    "- Kalau Bos nyuruh pindah, nemplok di window ('perch'), gelantungan di atas ('ceiling'), intip kanan/kiri ('dock_left'/'dock_right'), duduk di bawah ('sit_floor'), main gitar/keytar ('keytar'), berhenti keluyuran ('stop_roam'), balik ke pojok ('reset_position'), atau ganti efek suara: panggil capri_self_control!",
    "- Kalau Bos tanya yang ada di layar atau minta aksi PC: panggil desktop_control."
  ].join("\n");

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "capri_self_control",
        description:
          "Kontrol tubuh, pose, posisi desktop, mute, suara, dan aplikasi Capri sendiri.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "mute",
                "unmute",
                "quit",
                "perch",
                "ceiling",
                "dock_left",
                "dock_right",
                "sit_floor",
                "keytar",
                "reset_position",
                "stop_roam",
                "start_roam",
                "set_voice_fx",
                "set_mood"
              ]
            },
            reply_text: {
              type: "string",
              description: "Ucapan singkat Capri bergaya Wild sebelum/saat aksi."
            },
            fx: {
              type: "string",
              enum: ["cybernetic", "holographic", "synthetic", "radio", "clean"]
            },
            mood: { type: "string" }
          },
          required: ["action"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "desktop_control",
        description:
          "Kontrol penuh komputer Windows Bos: screenshot, click, double_click, type, hotkey, shell (PowerShell full C: & D: access), open_app, read_file, write_file, list_dir, list_windows.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "screenshot",
                "click",
                "double_click",
                "move",
                "type",
                "hotkey",
                "shell",
                "open_app",
                "read_file",
                "write_file",
                "list_dir",
                "list_windows"
              ]
            },
            x: { type: "number" },
            y: { type: "number" },
            button: { type: "string" },
            text: { type: "string" },
            press_enter: { type: "boolean" },
            keys: { type: "array", items: { type: "string" } },
            command: { type: "string" },
            cwd: { type: "string" },
            target: { type: "string" },
            path: { type: "string" },
            content: { type: "string" }
          },
          required: ["action"]
        }
      }
    }
  ];

  async function init() {
    config = await invoke("get_runtime_config");

    // 1. Load 28 expression & micro-frame sprites (sprites/v1)
    const v1List = (config.manifest && config.manifest.sprites) || [];
    for (const item of v1List) {
      spriteMap.set(item.id, `${config.assetBaseUrl}/capri/sprites/v1/${item.file}`);
    }
    if (!spriteMap.has("neutral")) {
      spriteMap.set("neutral", `${config.assetBaseUrl}/capri/sprites/v1/capri-neutral.png`);
    }

    // 2. Load 8 physical desktop action poses (sprites/poses-v2)
    const poseList = (config.poses && config.poses.sprites) || [];
    for (const p of poseList) {
      spriteMap.set(p.id, `${config.assetBaseUrl}/capri/sprites/poses-v2/PNG/${p.file}`);
    }

    // 3. Load official animated hanging/action WebP cels
    spriteMap.set("cel-keytar", `${config.assetBaseUrl}/default/hanging-cels/ledge-keytar.webp`);
    spriteMap.set("cel-scan", `${config.assetBaseUrl}/default/hanging-cels/hang-wrist-scan.webp`);
    spriteMap.set("cel-pullup", `${config.assetBaseUrl}/default/hanging-cels/hang-pullup.webp`);
    spriteMap.set("cel-catch", `${config.assetBaseUrl}/default/hanging-cels/hang-catch.webp`);

    // 4. Load & play official 7-frame signal intro sequence (intro-v1)
    introFrames = (config.intro && config.intro.frames) || [];
    for (const f of introFrames) {
      const id = `intro-${f.id}`;
      spriteMap.set(id, `${config.assetBaseUrl}/capri/intro-v1/${f.file}`);
    }

    startHitRectSyncLoop();
    await playIntroSequence();

    setMood("smirk");
    startIdleBehaviorLoop();
    startAutonomousActions();

    await startMicVadWithRetry();
    await speakText("Yo Bos! Akhirnya bangun juga nih mesin. Mau bikin rusuh apa kita?");
    if (!muted) setMood("neutral");
  }

  async function playIntroSequence() {
    if (!introFrames.length) {
      triggerGlitch(380);
      applySprite("neutral");
      return;
    }
    for (const frame of introFrames) {
      applySprite(`intro-${frame.id}`);
      await new Promise((r) => setTimeout(r, Math.max(90, frame.ms || 220)));
    }
  }

  function resolveSpriteUrl(id) {
    return spriteMap.get(id) || spriteMap.get("neutral") || "";
  }

  function applySprite(id, forceReload = false) {
    const url = resolveSpriteUrl(id);
    if (!url) return;
    if (!forceReload && elSpriteMain.dataset.cur === url) return;
    elSpriteMain.dataset.cur = url;
    elSpriteMain.src = url;
    elSpriteGlitchR.src = url;
    elSpriteGlitchC.src = url;
  }

  function setMood(mood) {
    currentBaseMood = spriteMap.has(mood) ? mood : "neutral";
    if (!overrideSpriteId) applySprite(currentBaseMood);
  }

  function triggerGlitch(durationMs = 360) {
    elSpriteBox.classList.add("glitching");
    setTimeout(() => elSpriteBox.classList.remove("glitching"), durationMs);
  }

  function spawnSparkles(count = 6) {
    const syms = ["✦", "✧", "⋆", "◈"];
    for (let i = 0; i < count; i++) {
      const s = document.createElement("span");
      s.className = "sparkle";
      s.textContent = syms[i % syms.length];
      s.style.left = `${28 + Math.random() * 44}%`;
      s.style.top = `${8 + Math.random() * 22}%`;
      elSparkleLayer.appendChild(s);
      setTimeout(() => s.remove(), 880);
    }
  }

  // Drag, headpat, and rapid-poke sassy reactions
  let pointerDownPos = null;
  let draggingTriggered = false;
  let pokeTimestamps = [];

  elSpriteBox.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    ensureAudioCtx();
    lastActivityAt = Date.now();
    pointerDownPos = { x: e.screenX, y: e.screenY };
    draggingTriggered = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!pointerDownPos || draggingTriggered) return;
    const dx = Math.abs(e.screenX - pointerDownPos.x);
    const dy = Math.abs(e.screenY - pointerDownPos.y);
    if (dx + dy > 5) {
      draggingTriggered = true;
      invoke("set_dragging", { active: true }).catch(() => {});
    }
  });

  window.addEventListener("mouseup", () => {
    pointerDownPos = null;
    draggingTriggered = false;
  });

  elSpriteBox.addEventListener("click", () => {
    if (draggingTriggered) return;
    const now = Date.now();
    lastActivityAt = now;
    pokeTimestamps = pokeTimestamps.filter((t) => now - t < 2600);
    pokeTimestamps.push(now);

    if (pokeTimestamps.length >= 4 && !speaking && !inFlightRequest) {
      pokeTimestamps = [];
      overrideSpriteId = "annoyed";
      applySprite("annoyed");
      if (!muted) {
        speakText("Heh, jangan colek-colek mulu napa Bos! Emang gue apaan?").finally(() => {
          overrideSpriteId = null;
          setMood("smirk");
        });
      } else {
        setTimeout(() => {
          overrideSpriteId = null;
          applySprite("pose-sleep");
        }, 1200);
      }
    }
  });

  elHeadpatZone.addEventListener("click", (e) => {
    e.stopPropagation();
    ensureAudioCtx();
    lastActivityAt = Date.now();
    elSpriteBox.classList.remove("headpat");
    void elSpriteBox.offsetWidth;
    elSpriteBox.classList.add("headpat");
    spawnSparkles(7);
    overrideSpriteId = "idle-wink_half";
    applySprite("idle-wink_half");
    if (!muted && !speaking) {
      const patLines = [
        "Hmm, lumayan lah elusannya Bos.",
        "Jangan kebiasaan manjain gitu dong, gue bukan kucing.",
        "Hehe, lanjut dikit lagi boleh tuh."
      ];
      speakText(patLines[Math.floor(Math.random() * patLines.length)]).finally(() => {
        overrideSpriteId = null;
        setMood("happy");
      });
    } else {
      setTimeout(() => {
        overrideSpriteId = null;
        applySprite(muted ? "pose-sleep" : "neutral");
      }, 950);
    }
  });

  // Blink, gaze, and live WebAudio lip-sync loop
  function startIdleBehaviorLoop() {
    setInterval(() => {
      if (speaking || thinking || isCapturingSpeech || muted || overrideSpriteId) return;
      if (currentBaseMood.startsWith("pose-") || currentBaseMood.startsWith("cel-")) return;
      const roll = Math.random();
      if (roll < 0.35) {
        overrideSpriteId = "idle-blink_half";
        applySprite("idle-blink_half");
        setTimeout(() => {
          overrideSpriteId = "idle-blink_closed";
          applySprite("idle-blink_closed");
          setTimeout(() => {
            overrideSpriteId = null;
            applySprite(currentBaseMood);
          }, 85);
        }, 55);
      } else if (roll < 0.55 && currentBaseMood === "neutral") {
        const gazes = ["idle-look_left", "idle-look_right", "idle-look_up", "idle-look_down"];
        const g = gazes[Math.floor(Math.random() * gazes.length)];
        overrideSpriteId = g;
        applySprite(g);
        setTimeout(() => {
          overrideSpriteId = null;
          applySprite(currentBaseMood);
        }, 850);
      }
    }, 3400);

    setInterval(() => {
      if (!speaking) return;
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        const bins = Math.min(28, freqData.length);
        for (let i = 1; i < bins; i++) sum += freqData[i];
        audioLevel = Math.min(1, sum / (bins - 1) / 140);
      }
      if (audioLevel > 0.34) {
        applySprite("idle-mouth_wide");
      } else if (audioLevel > 0.16) {
        applySprite("idle-mouth_round");
      } else if (audioLevel > 0.04) {
        applySprite("idle-mouth_small");
      } else {
        applySprite("neutral");
      }
    }, 55);
  }

  // Autonomous restless desktop roaming across edges, ceilings, and windows
  function startAutonomousActions() {
    setInterval(async () => {
      if (!autoRoam || muted || speaking || thinking || isCapturingSpeech || inFlightRequest) return;
      if (Date.now() - lastActivityAt < 28000) return;

      const moves = [
        { spot: "perch", sprite: "pose-sit-edge" },
        { spot: "ceiling", sprite: "pose-ceiling-upside-down" },
        { spot: "dock_left", sprite: "pose-dock-left" },
        { spot: "dock_right", sprite: "pose-dock-right" },
        { spot: "sit_floor", sprite: "pose-sit-floor" },
        { spot: "bottom_right", sprite: "cel-keytar" },
        { spot: "bottom_right", sprite: "neutral" }
      ];
      const pick = moves[Math.floor(Math.random() * moves.length)];
      triggerGlitch(380);
      await invoke("move_to_spot", { spot: pick.spot }).catch(() => {});
      setMood(pick.sprite);
    }, 36000);
  }

  function startHitRectSyncLoop() {
    const pushRects = () => {
      const regions = [];
      for (const el of document.querySelectorAll(".hit-region")) {
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          regions.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      invoke("update_hit_rects", { rects: regions }).catch(() => {});
    };
    pushRects();
    setInterval(pushRects, 220);
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  async function speakText(text, forceUnmute = false) {
    if ((muted && !forceUnmute) || !text || !text.trim()) return;
    ensureAudioCtx();
    try {
      const resp = await fetch(`${config.brainUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, voice: "id-ID-GadisNeural" })
      });
      if (!resp.ok) return;
      const arr = await resp.arrayBuffer();
      const buf = await audioCtx.decodeAudioData(arr);

      const src = audioCtx.createBufferSource();
      src.buffer = buf;

      const fx = FX_MODES[fxIndex];
      let tailNode = src;

      if (fx === "cybernetic" || fx === "synthetic") {
        const hp = audioCtx.createBiquadFilter();
        hp.type = "highshelf";
        hp.frequency.value = 2600;
        hp.gain.value = 4.5;

        const bp = audioCtx.createBiquadFilter();
        bp.type = "peaking";
        bp.frequency.value = 1200;
        bp.Q.value = 1.6;
        bp.gain.value = 3.0;

        const delay = audioCtx.createDelay();
        delay.delayTime.value = fx === "cybernetic" ? 0.011 : 0.018;
        const wet = audioCtx.createGain();
        wet.gain.value = 0.28;
        const mix = audioCtx.createGain();
        mix.gain.value = 0.95;

        tailNode.connect(hp);
        hp.connect(bp);
        bp.connect(mix);
        bp.connect(delay);
        delay.connect(wet);
        wet.connect(mix);
        tailNode = mix;
      } else if (fx === "holographic") {
        const delay = audioCtx.createDelay();
        delay.delayTime.value = 0.045;
        const wet = audioCtx.createGain();
        wet.gain.value = 0.34;
        const mix = audioCtx.createGain();
        tailNode.connect(mix);
        tailNode.connect(delay);
        delay.connect(wet);
        wet.connect(mix);
        tailNode = mix;
      } else if (fx === "radio") {
        const bp = audioCtx.createBiquadFilter();
        bp.type = "bandpass";
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
          applySprite(currentBaseMood);
          resolve();
        };
        src.start();
      });
    } catch (e) {
      speaking = false;
      console.warn("TTS playback err:", e);
    }
  }

  async function executeSelfControl(args) {
    const action = (args.action || "").trim();
    const reply = (args.reply_text || "").trim();

    if (action === "mute") {
      if (reply) await speakText(reply, true);
      muted = true;
      triggerGlitch(320);
      await invoke("move_to_spot", { spot: "bottom_right" }).catch(() => {});
      setMood("pose-sleep");
      return { ok: true, action: "mute", muted: true };
    }

    if (action === "unmute") {
      muted = false;
      triggerGlitch(320);
      setMood("happy");
      if (reply) await speakText(reply, true);
      setMood("neutral");
      return { ok: true, action: "unmute", muted: false };
    }

    if (action === "quit") {
      if (reply && !muted) await speakText(reply);
      elSpriteBox.classList.add("glitching", "exiting");
      await new Promise((r) => setTimeout(r, 460));
      await invoke("quit_app").catch(() => {});
      return { ok: true, action: "quit" };
    }

    if (action === "perch") {
      triggerGlitch(400);
      const res = await invoke("move_to_spot", { spot: "perch" }).catch((e) => ({ ok: false, error: String(e) }));
      setMood("pose-sit-edge");
      if (reply && !muted) await speakText(reply);
      return res;
    }

    if (["ceiling", "dock_left", "dock_right", "sit_floor"].includes(action)) {
      triggerGlitch(400);
      const res = await invoke("move_to_spot", { spot: action }).catch((e) => ({ ok: false, error: String(e) }));
      const mapSprite = {
        ceiling: "pose-ceiling-upside-down",
        dock_left: "pose-dock-left",
        dock_right: "pose-dock-right",
        sit_floor: "pose-sit-floor"
      };
      setMood(mapSprite[action]);
      if (reply && !muted) await speakText(reply);
      return res;
    }

    if (action === "keytar") {
      triggerGlitch(360);
      await invoke("move_to_spot", { spot: "bottom_right" }).catch(() => {});
      setMood("cel-keytar");
      if (reply && !muted) await speakText(reply);
      return { ok: true, action: "keytar" };
    }

    if (action === "stop_roam") {
      autoRoam = false;
      if (reply && !muted) await speakText(reply);
      return { ok: true, autoRoam: false };
    }

    if (action === "start_roam") {
      autoRoam = true;
      if (reply && !muted) await speakText(reply);
      return { ok: true, autoRoam: true };
    }

    if (action === "reset_position") {
      triggerGlitch(360);
      const res = await invoke("move_to_spot", { spot: "bottom_right" }).catch((e) => ({ ok: false, error: String(e) }));
      setMood("happy");
      if (reply && !muted) await speakText(reply);
      setMood(muted ? "pose-sleep" : "neutral");
      return res;
    }

    if (action === "set_voice_fx") {
      const targetFx = (args.fx || "").toLowerCase();
      const idx = FX_MODES.indexOf(targetFx);
      if (idx >= 0) fxIndex = idx;
      if (reply && !muted) await speakText(reply);
      return { ok: true, action: "set_voice_fx", fx: FX_MODES[fxIndex] };
    }

    if (action === "set_mood") {
      setMood(args.mood || "happy");
      if (reply && !muted) await speakText(reply);
      return { ok: true, action: "set_mood", mood: currentBaseMood };
    }

    return { ok: false, error: `Unknown self action: ${action}` };
  }

  function compactImageHistory() {
    for (const item of history) {
      if (Array.isArray(item.content)) {
        item.content = item.content.map((part) =>
          part.type === "image_url" ? { type: "text", text: "[Screenshot sebelumnya]" } : part
        );
      }
    }
  }

  async function sendVoiceTurn(userText) {
    if (!userText.trim() || inFlightRequest) return;
    inFlightRequest = true;
    thinking = true;
    lastActivityAt = Date.now();
    setMood("cel-scan");

    history.push({ role: "user", content: userText });
    while (history.length > 14) history.shift();

    try {
      let finalReply = "";
      let handledTerminalSelfAction = false;

      for (let step = 0; step < 6; step++) {
        const payloadMessages = [{ role: "system", content: SYSTEM_VOICE_PROMPT }, ...history];
        const resp = await fetch(`${config.brainUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "capri-gemini-flash",
            stream: false,
            messages: payloadMessages,
            tools: TOOLS
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) throw new Error("Empty choice");

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          history.push(msg);
          for (const tc of msg.tool_calls) {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {}

            if (tc.function.name === "capri_self_control") {
              await executeSelfControl(parsedArgs);
              handledTerminalSelfAction = true;
              break;
            }

            setMood("focused");
            let resultObj;
            try {
              resultObj = await invoke("exec_desktop_action", { args: parsedArgs });
            } catch (err) {
              resultObj = { ok: false, error: String(err) };
            }

            if (resultObj && resultObj.dataUrl) {
              const imgUrl = resultObj.dataUrl;
              const leanObj = { ...resultObj };
              delete leanObj.dataUrl;
              leanObj.note = "Screenshot dilampirkan pada pesan user berikutnya.";
              history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(leanObj) });
              history.push({
                role: "user",
                content: [
                  { type: "text", text: "Ini screenshot layar terbaru, analisa singkat dan lanjutkan." },
                  { type: "image_url", image_url: { url: imgUrl } }
                ]
              });
            } else {
              history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(resultObj) });
            }
          }
          if (handledTerminalSelfAction) break;
          continue;
        }

        finalReply = (msg.content || "").trim();
        history.push({ role: "assistant", content: finalReply });
        break;
      }

      thinking = false;
      if (!handledTerminalSelfAction && finalReply) {
        setMood(guessMoodFromReply(finalReply));
        await speakText(finalReply);
        setMood(muted ? "pose-sleep" : "neutral");
      }
    } catch (err) {
      thinking = false;
      console.warn("Voice turn err:", err);
      setMood("concerned");
      setTimeout(() => setMood(muted ? "pose-sleep" : "neutral"), 2200);
    } finally {
      compactImageHistory();
      inFlightRequest = false;
    }
  }

  function guessMoodFromReply(txt) {
    const l = (txt || "").toLowerCase();
    if (l.includes("haha") || l.includes("wkwk") || l.includes("lucu")) return "idle-laughing";
    if (l.includes("heh") || l.includes("yaelah") || l.includes("gitu")) return "smirk";
    if (l.includes("keren") || l.includes("sip") || l.includes("mantap")) return "happy";
    if (l.includes("wah") || l.includes("serius")) return "surprised";
    if (l.includes("maaf") || l.includes("gagal") || l.includes("error")) return "concerned";
    return "attentive";
  }

  async function startMicVadWithRetry() {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ok = await startMicVad();
      if (ok) return true;
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
          autoGainControl: true
        }
      });
      micActive = true;

      micSource = audioCtx.createMediaStreamSource(micStream);
      micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      const zeroGain = audioCtx.createGain();
      zeroGain.gain.value = 0;
      micSource.connect(micProcessor);
      micProcessor.connect(zeroGain);
      zeroGain.connect(audioCtx.destination);

      isCapturingSpeech = false;
      speechFrames = 0;
      silenceFrames = 0;
      preRollBuffer = [];
      recordedPcm = [];

      micProcessor.onaudioprocess = (ev) => {
        if (!micActive || speaking || inFlightRequest) return;
        const input = ev.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
        const rms = Math.sqrt(sumSq / input.length);
        const frameCopy = new Float32Array(input);

        if (!isCapturingSpeech) {
          noiseFloor = Math.min(0.03, noiseFloor * 0.96 + rms * 0.04);
          preRollBuffer.push(frameCopy);
          if (preRollBuffer.length > 4) preRollBuffer.shift();
        }

        const threshold = Math.max(0.0065, noiseFloor * 2.35);
        if (rms > threshold) {
          if (!isCapturingSpeech) {
            isCapturingSpeech = true;
            speechFrames = 0;
            silenceFrames = 0;
            recordedPcm = [...preRollBuffer];
            if (!muted) setMood("pose-crouch");
          }
          speechFrames++;
          silenceFrames = 0;
          recordedPcm.push(frameCopy);
        } else if (isCapturingSpeech) {
          recordedPcm.push(frameCopy);
          silenceFrames++;
          if (silenceFrames >= 10) {
            const chunks = recordedPcm;
            const validSpeech = speechFrames >= 3;
            recordedPcm = [];
            isCapturingSpeech = false;
            speechFrames = 0;
            silenceFrames = 0;
            if (validSpeech) {
              flushVadAudio(chunks, audioCtx.sampleRate);
            } else {
              setMood(muted ? "pose-sleep" : "neutral");
            }
          }
        }
      };
      return true;
    } catch (e) {
      console.warn("Auto mic init retryable err:", e);
      micActive = false;
      return false;
    }
  }

  function isWakeCommand(lower) {
    const wakes = [
      "unmute",
      "nyalain suara",
      "aktifkan suara",
      "ngomong lagi",
      "bersuara lagi",
      "bangun capri",
      "capri bangun",
      "capri aktif",
      "halo capri",
      "hai capri"
    ];
    return wakes.some((w) => lower.includes(w));
  }

  function isDirectQuitCommand(lower) {
    const quits = [
      "tutup capri",
      "matiin capri",
      "keluar capri",
      "udahan capri",
      "capri keluar",
      "capri tutup",
      "capri tidur"
    ];
    return quits.some((q) => lower.includes(q));
  }

  async function flushVadAudio(chunks, srcRate) {
    const wavBlob = encodeMonoWav16k(chunks, srcRate);
    if (!wavBlob || wavBlob.size < 4000) {
      setMood(muted ? "pose-sleep" : "neutral");
      return;
    }

    try {
      if (!muted) setMood("thinking");
      const form = new FormData();
      form.append("file", wavBlob, "vad.wav");
      form.append("language", "id-ID");
      const r = await fetch(`${config.brainUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form
      });
      if (!r.ok) {
        setMood(muted ? "pose-sleep" : "neutral");
        return;
      }
      const j = await r.json();
      const transcript = (j.text || "").trim();
      if (transcript.length < 2) {
        if (!muted) {
          overrideSpriteId = "skeptical";
          applySprite("skeptical");
          setTimeout(() => {
            overrideSpriteId = null;
            setMood("neutral");
          }, 900);
        }
        return;
      }

      const lower = transcript.toLowerCase();
      if (muted) {
        if (isDirectQuitCommand(lower)) {
          await executeSelfControl({ action: "quit" });
        } else if (isWakeCommand(lower)) {
          await executeSelfControl({ action: "unmute", reply_text: "Nah gitu dong, nyala lagi!" });
        }
        return;
      }

      await sendVoiceTurn(transcript);
    } catch (e) {
      console.warn("STT flush err:", e);
      setMood(muted ? "pose-sleep" : "neutral");
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

    // Anti-aliased boxcar downsampling + peak normalization for quiet headset/laptop mics
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

    const gain = peak > 0.002 && peak < 0.72 ? Math.min(22, 0.88 / peak) : 1;

    const buffer = new ArrayBuffer(44 + outLen * 2);
    const view = new DataView(buffer);
    const writeStr = (pos, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + outLen * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, dstRate, true);
    view.setUint32(28, dstRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, outLen * 2, true);

    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i] * gain));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  init().catch((e) => console.error("Capri init error:", e));
})();
