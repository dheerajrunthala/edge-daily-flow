// A short chime for in-app notifications, synthesized rather than shipped as an asset:
// two sine notes and an envelope are a few lines of WebAudio and no network request.
//
// The whole file exists because of one browser rule: an AudioContext created before the
// user has interacted with the page starts suspended, and resuming it later silently
// fails. So the context is created on the first real gesture and reused from then on —
// which is also why a reminder that arrives before the user has clicked anything is
// shown as a toast with no sound rather than appearing to be broken.

let ctx: AudioContext | null = null;

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Arm the chime on the first user gesture. Returns a cleanup function, so a React effect
 * can own it. Safe to call more than once.
 */
export function unlockChime(): () => void {
  const Ctor = audioCtor();
  if (!Ctor) return () => {};

  const unlock = () => {
    try {
      ctx ??= new Ctor();
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      // No audio on this device. Toasts still work; that is the important half.
    }
    detach();
  };

  const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];
  const detach = () => events.forEach((e) => window.removeEventListener(e, unlock));
  events.forEach((e) => window.addEventListener(e, unlock, { once: true, passive: true }));
  return detach;
}

/** Is the chime armed? False until the user has interacted with the page. */
export function chimeReady(): boolean {
  return ctx !== null && ctx.state === "running";
}

/**
 * Two notes a fifth apart, 90ms apart, each ~0.35s. Quiet on purpose (peak gain 0.12):
 * this fires while the user is working in the tab, so it should read as a notification
 * and not as an alarm.
 */
export function playChime(): void {
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  [
    { freq: 880, at: 0 },
    { freq: 1318.5, at: 0.09 },
  ].forEach(({ freq, at }) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Ramped rather than switched: a square-edged gain change clicks audibly.
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(0.12, now + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.4);
  });
}
