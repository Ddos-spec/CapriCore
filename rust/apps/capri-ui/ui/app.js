(() => {
  const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);

  const elRoot = document.getElementById("capri-root");
  const elBubbleWrap = document.getElementById("bubble-wrap");
  const elBubbleBadge = document.getElementById("bubble-badge");
  const elBubbleText = document.getElementById("bubble-text");
  const btnBubbleClose = document.getElementById("btn-bubble-close");

  const elSpriteBox = document.getElementById("sprite-box");
  const elSpriteMain = document.getElementById("sprite-main");
  const elSpriteGlitchR = document.getElementById("sprite-glitch-r");
  const elSpriteGlitchC = document.getElementById("sprite-glitch-c");
  const elHeadpatZone = document.getElementById("headpat-zone");
  const elSparkleLayer = document.getElementById("sparkle-layer");
  const fftCanvas = document.getElementById("fft-canvas");
  const fftCtx = fftCanvas.getContext("2d");

  const elBrainDot = document.getElementById("brain-dot");
  const elBrainLabel = document.getElementById("brain-label");
  const btnMic = document.getElementById("btn-mic");
  const btnVision = document.getElementById("btn-vision");
  const btnPerch = document.getElementById("btn-perch");
  const btnFx = document.getElementById("btn-fx");
  const fxLabel = document.getElementById("fx-label");
  const btnMute = document.getElementById("btn-mute");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");

  const FX_MODES = ["cybernetic", "holographic", "synthetic", "radio", "clean"];
  let fxIndex = 0;
  let muted = false;

  let config = { brainUrl: "http://100.109.116.120:18789", assetBaseUrl: "", brainMode: "sync" };
  let spriteMap = new Map();
  let currentBaseMood = "neutral";
  let overrideSpriteId = null;
  let speaking = false;
  let thinking = false;
  let audioLevel = 0;
  let micLevel = 0;

  // WebAudio output + DSP chain + AnalyserNode
  let audioCtx = null;
  let analyser = null;
  let freqData = null;

  // Mic VAD state
  let micActive = false;
  let micStream = null;
  let micProcessor = null;
  let micSource = null;
  let isCapturingSpeech = false;
  let silenceFrames = 0;
  let recordedPcm = [];
  let inFlightRequest = false;

  const history = [];

  const DESKTOP_TOOLS = [
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
                "list_windows",
              ],
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
            content: { type: "string" },
          },
          required: ["action"],
        },
      },
    },
  ];

  async function init() {
    config = await invoke("get_runtime_config");
    const list = (config.manifest && config.manifest.sprites) || [];
    for (const item of list) {
      spriteMap.set(item.id, `${config.assetBaseUrl}/capri/sprites/v1/${item.file}`);
    }
    if (spriteMap.size === 0) {
      spriteMap.set("neutral", `${config.assetBaseUrl}/capri/sprites/v1/capri-neutral.png`);
    }

    setMood("happy");
    triggerGlitch(380);
    updateBrainBadge();
    startFftRenderLoop();
    startIdleBehaviorLoop();
    startHitRectSyncLoop();
    pollBrainHealth();
    setInterval(pollBrainHealth, 8000);

    showBubble("CAPRI-RS // ONLINE", "Siap Bos! Suara, mata layar, & full akses aktif.", 5200);
  }

  function updateBrainBadge() {
    if (config.brainMode === "blackarch-remote") {
      elBrainDot.className = "dot online";
      elBrainLabel.textContent = "BA";
    } else if (config.brainMode === "windows-local") {
      elBrainDot.className = "dot online";
      elBrainLabel.textContent = "LOC";
    } else {
      elBrainDot.className = "dot offline";
      elBrainLabel.textContent = "OFF";
    }
  }

  async function pollBrainHealth() {
    try {
      const r = await fetch(`${config.brainUrl}/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const j = await r.json();
        elBrainDot.className = j.wiz_ok ? "dot online" : "dot";
        elBrainLabel.textContent = config.brainUrl.includes("100.109.116.120") ? "BA" : "LOC";
        return;
      }
    } catch {}
    elBrainDot.className = "dot offline";
  }

  function resolveSpriteUrl(id) {
    return spriteMap.get(id) || spriteMap.get("neutral") || "";
  }

  function applySprite(id) {
    const url = resolveSpriteUrl(id);
    if (!url || elSpriteMain.dataset.cur === url) return;
    elSpriteMain.dataset.cur = url;
    elSpriteMain.src = url;
    elSpriteGlitchR.src = url;
    elSpriteGlitchC.src = url;
  }

  function setMood(mood) {
    currentBaseMood = spriteMap.has(mood) ? mood : "neutral";
    if (!overrideSpriteId) applySprite(currentBaseMood);

    const glowMap = {
      neutral: "rgba(20, 184, 166, 0.34)",
      happy: "rgba(245, 158, 11, 0.40)",
      "idle-excited": "rgba(251, 191, 36, 0.48)",
      thinking: "rgba(129, 140, 248, 0.44)",
      focused: "rgba(34, 211, 238, 0.42)",
      flirty: "rgba(244, 114, 182, 0.44)",
      surprised: "rgba(56, 189, 248, 0.45)",
      concerned: "rgba(244, 63, 94, 0.38)",
    };
    document.documentElement.style.setProperty(
      "--mood-glow",
      glowMap[currentBaseMood] || glowMap.neutral
    );
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

  let bubbleTimer = null;
  function showBubble(badge, text, autoHideMs = 0) {
    elBubbleBadge.textContent = badge;
    elBubbleText.textContent = text;
    elBubbleWrap.classList.remove("hidden");
    if (bubbleTimer) clearTimeout(bubbleTimer);
    if (autoHideMs > 0) {
      bubbleTimer = setTimeout(() => elBubbleWrap.classList.add("hidden"), autoHideMs);
    }
  }

  btnBubbleClose.addEventListener("click", () => {
    elBubbleWrap.classList.add("hidden");
  });

  // Dragging & Headpat interaction
  let pointerDownPos = null;
  let draggingTriggered = false;

  elSpriteBox.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
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

  elHeadpatZone.addEventListener("click", (e) => {
    e.stopPropagation();
    elSpriteBox.classList.remove("headpat");
    void elSpriteBox.offsetWidth;
    elSpriteBox.classList.add("headpat");
    spawnSparkles(7);
    overrideSpriteId = "idle-wink_half";
    applySprite("idle-wink_half");
    setMood("happy");
    setTimeout(() => {
      overrideSpriteId = null;
      applySprite(currentBaseMood);
    }, 900);
  });

  // Blinking, gaze & speaking lip-sync cadence
  function startIdleBehaviorLoop() {
    setInterval(() => {
      if (speaking || thinking || overrideSpriteId) return;
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

    // Real-time audio FFT lip-sync timer (~18Hz while speaking)
    setInterval(() => {
      if (!speaking) return;
      if (audioLevel > 0.34) {
        applySprite("idle-mouth_wide");
      } else if (audioLevel > 0.16) {
        applySprite("idle-mouth_round");
      } else if (audioLevel > 0.04) {
        applySprite("idle-mouth_small");
      } else {
        applySprite(currentBaseMood);
      }
    }, 55);
  }

  // 32-Bar Circular Holo FFT Visualizer
  function startFftRenderLoop() {
    const cx = fftCanvas.width / 2;
    const cy = fftCanvas.height / 2 + 12;
    const baseRadius = 152;
    const bars = 32;
    let phase = 0;

    function tick() {
      phase += 0.035;
      fftCtx.clearRect(0, 0, fftCanvas.width, fftCanvas.height);

      let sumAmp = 0;
      if (speaking && analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
      }

      // Outer subtle holo orbit ring
      fftCtx.beginPath();
      fftCtx.arc(cx, cy, baseRadius - 6, 0, Math.PI * 2);
      fftCtx.strokeStyle = thinking
        ? "rgba(129, 140, 248, 0.32)"
        : micActive
        ? "rgba(34, 211, 238, 0.32)"
        : "rgba(45, 212, 191, 0.18)";
      fftCtx.lineWidth = 1.5;
      fftCtx.stroke();

      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        let v = 0.06 + 0.04 * Math.sin(phase * 1.8 + i * 0.45);
        if (speaking && freqData) {
          const bin = Math.min(freqData.length - 1, Math.floor((i * 22) / bars) + 1);
          v = Math.max(v, freqData[bin] / 255);
          sumAmp += freqData[bin] / 255;
        } else if (micActive && micLevel > 0.02) {
          v = Math.max(v, micLevel * (0.65 + 0.4 * Math.sin(phase * 4 + i)));
        } else if (thinking) {
          v = 0.14 + 0.18 * (0.5 + 0.5 * Math.sin(phase * 3.5 - i * 0.4));
        }

        const len = 6 + v * 34;
        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + len);
        const y2 = cy + Math.sin(angle) * (baseRadius + len);

        fftCtx.beginPath();
        fftCtx.moveTo(x1, y1);
        fftCtx.lineTo(x2, y2);
        fftCtx.lineCap = "round";
        fftCtx.lineWidth = 3;
        fftCtx.strokeStyle = speaking
          ? "rgba(245, 158, 11, 0.85)"
          : thinking
          ? "rgba(129, 140, 248, 0.85)"
          : micActive
          ? "rgba(34, 211, 238, 0.85)"
          : "rgba(45, 212, 191, 0.48)";
        fftCtx.stroke();
      }

      audioLevel = speaking ? Math.min(1, (sumAmp / bars) * 2.1) : 0;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Hit-rect syncing for transparent click-through precision
  function startHitRectSyncLoop() {
    const pushRects = () => {
      const regions = [];
      for (const el of document.querySelectorAll(".hit-region")) {
        if (el.classList.contains("hidden")) continue;
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

  // WebAudio DSP Voice FX + Playback
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

  async function speakText(text) {
    if (muted || !text || !text.trim()) return;
    ensureAudioCtx();
    try {
      const resp = await fetch(`${config.brainUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, voice: "id-ID-GadisNeural" }),
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

  // Send prompt to Brain + Multi-Turn Native Desktop Tool Loop
  async function sendChat(userText, imageDataUrl = null) {
    if (!userText.trim() || inFlightRequest) return;
    inFlightRequest = true;
    thinking = true;
    setMood("thinking");
    showBubble("CAPRI // THINKING", "Lagi mikir bentar Bos...", 0);

    const content = imageDataUrl
      ? [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : userText;

    history.push({ role: "user", content });
    while (history.length > 14) history.shift();

    try {
      let finalReply = "";
      for (let step = 0; step < 6; step++) {
        const resp = await fetch(`${config.brainUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "capri-gemini-flash",
            stream: false,
            messages: history,
            tools: DESKTOP_TOOLS,
          }),
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
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
            showBubble(
              "CAPRI // DESKTOP ACTION",
              `Menjalankan ${parsedArgs.action || tc.function.name}...`,
              0
            );
            setMood("focused");
            let resultObj;
            try {
              resultObj = await invoke("exec_desktop_action", { args: parsedArgs });
            } catch (err) {
              resultObj = { ok: false, error: String(err) };
            }
            history.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(resultObj),
            });
          }
          continue;
        }

        finalReply = (msg.content || "").trim();
        history.push({ role: "assistant", content: finalReply });
        break;
      }

      thinking = false;
      setMood(guessMoodFromReply(finalReply));
      showBubble("CAPRI", finalReply || "(Selesai)", 14000);
      await speakText(finalReply);
      setMood("neutral");
    } catch (err) {
      thinking = false;
      setMood("concerned");
      showBubble("CAPRI // ERROR", `Gagal konek ke Brain: ${err.message}`, 7000);
    } finally {
      inFlightRequest = false;
    }
  }

  function guessMoodFromReply(txt) {
    const l = (txt || "").toLowerCase();
    if (l.includes("haha") || l.includes("wkwk") || l.includes("lucu")) return "idle-laughing";
    if (l.includes("keren") || l.includes("siap") || l.includes("beres") || l.includes("mantap")) return "happy";
    if (l.includes("wah") || l.includes("kaget")) return "surprised";
    if (l.includes("maaf") || l.includes("gagal") || l.includes("error")) return "concerned";
    if (l.includes("sayang") || l.includes("bos ganteng")) return "flirty";
    return "attentive";
  }

  // Controls
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const txt = chatInput.value.trim();
    if (!txt) return;
    chatInput.value = "";
    sendChat(txt);
  });

  btnVision.addEventListener("click", async () => {
    try {
      setMood("focused");
      showBubble("CAPRI // VISION", "Mengambil tangkapan layar...", 0);
      const snap = await invoke("capture_screen_b64");
      const q = chatInput.value.trim() || "Lihat layar komputerku sekarang dan jelaskan singkat apa yang lagi terbuka.";
      chatInput.value = "";
      await sendChat(q, snap.dataUrl);
    } catch (e) {
      showBubble("CAPRI // VISION ERR", String(e), 4500);
    }
  });

  btnPerch.addEventListener("click", async () => {
    triggerGlitch(420);
    try {
      const res = await invoke("auto_perch_window");
      if (res.ok) {
        setMood("idle-excited");
        showBubble("CAPRI // TELEPORT", `Nemplok di ${res.targetTitle}`, 3200);
      } else {
        showBubble("CAPRI", "Ga ada window target yang kebuka.", 2500);
      }
    } catch (e) {
      showBubble("CAPRI // ERR", String(e), 3000);
    }
  });

  btnPerch.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    triggerGlitch(380);
    await invoke("move_to_bottom_right").catch(() => {});
  });

  btnFx.addEventListener("click", () => {
    fxIndex = (fxIndex + 1) % FX_MODES.length;
    fxLabel.textContent = FX_MODES[fxIndex].slice(0, 5).toUpperCase();
  });

  btnMute.addEventListener("click", () => {
    muted = !muted;
    btnMute.textContent = muted ? "🔇" : "🔊";
  });

  // Hands-free Mic VAD ("halo halo" ready!)
  btnMic.addEventListener("click", toggleMicVad);

  async function toggleMicVad() {
    if (micActive) {
      stopMicVad();
      return;
    }
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
      btnMic.classList.add("active");
      setMood("attentive");
      showBubble("CAPRI // MIC ON", "Ngomong aja Bos ('Halo Capri...'), otomatis terkirim!", 4000);

      micSource = audioCtx.createMediaStreamSource(micStream);
      micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      const zeroGain = audioCtx.createGain();
      zeroGain.gain.value = 0;
      micSource.connect(micProcessor);
      micProcessor.connect(zeroGain);
      zeroGain.connect(audioCtx.destination);

      isCapturingSpeech = false;
      silenceFrames = 0;
      recordedPcm = [];

      micProcessor.onaudioprocess = (ev) => {
        if (!micActive || speaking || inFlightRequest) return;
        const input = ev.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
        const rms = Math.sqrt(sumSq / input.length);
        micLevel = Math.min(1, rms * 14);

        const THRESHOLD = 0.018;
        if (rms > THRESHOLD) {
          if (!isCapturingSpeech) {
            isCapturingSpeech = true;
            btnMic.classList.add("recording");
            recordedPcm = [];
          }
          silenceFrames = 0;
          recordedPcm.push(new Float32Array(input));
        } else if (isCapturingSpeech) {
          recordedPcm.push(new Float32Array(input));
          silenceFrames++;
          // ~1.0s silence after speech ends -> flush to STT
          if (silenceFrames >= 9) {
            const chunks = recordedPcm;
            recordedPcm = [];
            isCapturingSpeech = false;
            silenceFrames = 0;
            btnMic.classList.remove("recording");
            flushVadAudio(chunks, audioCtx.sampleRate);
          }
        }
      };
    } catch (e) {
      stopMicVad();
      showBubble("CAPRI // MIC ERR", `Gagal buka mic: ${e.message}`, 4500);
    }
  }

  function stopMicVad() {
    micActive = false;
    micLevel = 0;
    isCapturingSpeech = false;
    btnMic.classList.remove("active", "recording");
    if (micProcessor) {
      micProcessor.disconnect();
      micProcessor = null;
    }
    if (micSource) {
      micSource.disconnect();
      micSource = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  async function flushVadAudio(chunks, srcRate) {
    const wavBlob = encodeMonoWav16k(chunks, srcRate);
    if (!wavBlob || wavBlob.size < 4000) return;

    try {
      const form = new FormData();
      form.append("file", wavBlob, "vad.wav");
      form.append("language", "id-ID");
      const r = await fetch(`${config.brainUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      if (!r.ok) return;
      const j = await r.json();
      const transcript = (j.text || "").trim();
      if (transcript.length >= 2) {
        showBubble("BOS", transcript, 2500);
        await sendChat(transcript);
      }
    } catch (e) {
      console.warn("STT flush err:", e);
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
    if (outLen < 1600) return null;

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
      const idx = Math.min(merged.length - 1, Math.floor(i * ratio));
      const s = Math.max(-1, Math.min(1, merged[idx]));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  init().catch((e) => {
    console.error(e);
    showBubble("CAPRI // INIT ERROR", String(e), 0);
  });
})();
