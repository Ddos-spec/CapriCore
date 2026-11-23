// SPDX-License-Identifier: GPL-3.0-only

export function playTeleportSound(context, preset) {
  if (!context || context.state === 'closed' || !['spark', 'thunder', 'pulse'].includes(preset))
    return;
  if (context.state === 'suspended') void context.resume().catch(() => {});
  const start = context.currentTime + 0.007;
  const duration = { spark: 0.16, thunder: 0.37, pulse: 0.26 }[preset];
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(preset === 'thunder' ? 0.14 : 0.085, start + 0.025);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  envelope.connect(context.destination);
  const sweep = context.createOscillator();
  sweep.type = preset === 'spark' ? 'triangle' : 'sine';
  sweep.frequency.setValueAtTime({ spark: 1900, thunder: 132, pulse: 360 }[preset], start);
  sweep.frequency.exponentialRampToValueAtTime(
    { spark: 630, thunder: 45, pulse: 920 }[preset],
    start + duration * 0.7,
  );
  sweep.connect(envelope);
  let crackle, filter;
  if (preset !== 'pulse') {
    const noise = context.createBuffer(
      1,
      Math.floor(context.sampleRate * duration),
      context.sampleRate,
    );
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.6;
    crackle = context.createBufferSource();
    crackle.buffer = noise;
    filter = context.createBiquadFilter();
    filter.type = preset === 'spark' ? 'highpass' : 'lowpass';
    filter.frequency.value = preset === 'spark' ? 1900 : 420;
    crackle.connect(filter).connect(envelope);
    crackle.start(start);
  }
  sweep.onended = () => {
    crackle?.disconnect();
    filter?.disconnect();
    sweep.disconnect();
    envelope.disconnect();
  };
  sweep.start(start);
  sweep.stop(start + duration);
}

/** Edgerunners breach summon stinger: sub-bass drop + metallic glitch sweep + crimson pulse. */
export function playBreachSummonSound(context) {
  if (!context || context.state === 'closed') return;
  if (context.state === 'suspended') void context.resume().catch(() => {});
  const t0 = context.currentTime + 0.005;

  // Sub-bass impact drop
  const subGain = context.createGain();
  subGain.gain.setValueAtTime(0.001, t0);
  subGain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.018);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
  subGain.connect(context.destination);

  const sub = context.createOscillator();
  sub.type = 'sawtooth';
  const lp = context.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(240, t0);
  lp.frequency.exponentialRampToValueAtTime(48, t0 + 0.34);
  sub.frequency.setValueAtTime(124, t0);
  sub.frequency.exponentialRampToValueAtTime(38, t0 + 0.34);
  sub.connect(lp).connect(subGain);

  // Digital glitch slice sweep
  const hiGain = context.createGain();
  hiGain.gain.setValueAtTime(0.0001, t0);
  hiGain.gain.exponentialRampToValueAtTime(0.065, t0 + 0.02);
  hiGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.21);
  hiGain.connect(context.destination);

  const slice = context.createOscillator();
  slice.type = 'square';
  slice.frequency.setValueAtTime(1680, t0);
  slice.frequency.exponentialRampToValueAtTime(520, t0 + 0.09);
  slice.frequency.setValueAtTime(2340, t0 + 0.095);
  slice.frequency.exponentialRampToValueAtTime(880, t0 + 0.21);
  slice.connect(hiGain);

  sub.onended = () => {
    sub.disconnect();
    lp.disconnect();
    subGain.disconnect();
    slice.disconnect();
    hiGain.disconnect();
  };
  sub.start(t0);
  sub.stop(t0 + 0.37);
  slice.start(t0);
  slice.stop(t0 + 0.22);
}

/** Playful gentle cyber chime on headpat contact. */
export function playHeadpatChime(context) {
  if (!context || context.state === 'closed') return;
  if (context.state === 'suspended') void context.resume().catch(() => {});
  const t0 = context.currentTime + 0.005;
  const g = context.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.055, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
  g.connect(context.destination);

  const osc = context.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(880, t0);
  osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.14);
  osc.connect(g);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
  osc.start(t0);
  osc.stop(t0 + 0.25);
}
