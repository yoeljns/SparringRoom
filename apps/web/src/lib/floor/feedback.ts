/**
 * Audible and vibration feedback (spec 5.7): one tone for accepted, a clearly
 * different one for refused.
 *   accepted  two short rising sine beeps (880 Hz then 1320 Hz), one short buzz
 *   refused   one long low square-wave buzz (196 Hz, twice), long double buzz
 */

export type FeedbackKind = 'accepted' | 'refused';

interface ToneStep {
  frequency: number;
  type: OscillatorType;
  /** Seconds from the start. */
  at: number;
  duration: number;
  gain: number;
}

export const TONES: Record<FeedbackKind, readonly ToneStep[]> = {
  accepted: [
    { frequency: 880, type: 'sine', at: 0, duration: 0.09, gain: 0.5 },
    { frequency: 1320, type: 'sine', at: 0.1, duration: 0.12, gain: 0.5 },
  ],
  refused: [
    { frequency: 196, type: 'square', at: 0, duration: 0.28, gain: 0.45 },
    { frequency: 196, type: 'square', at: 0.36, duration: 0.42, gain: 0.45 },
  ],
};

export const VIBRATION: Record<FeedbackKind, number[]> = {
  accepted: [60],
  refused: [250, 120, 400],
};

type AudioContextCtor = typeof AudioContext;

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
  } catch {
    audioContext = null;
  }
  return audioContext;
}

/**
 * Browsers start audio only after a user gesture. Call this from the first
 * tap or key press so later scan tones are not muted.
 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

export function playTone(kind: FeedbackKind): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const start = ctx.currentTime + 0.01;
  for (const step of TONES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = step.type;
    osc.frequency.value = step.frequency;
    const t0 = start + step.at;
    const t1 = t0 + step.duration;
    // Short ramps avoid clicks.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(step.gain, t0 + 0.01);
    gain.gain.setValueAtTime(step.gain, t1 - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }
}

export function vibrate(kind: FeedbackKind): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(VIBRATION[kind]);
    } catch {
      // Vibration is best effort.
    }
  }
}

/** Tone plus vibration. */
export function feedback(kind: FeedbackKind): void {
  playTone(kind);
  vibrate(kind);
}
