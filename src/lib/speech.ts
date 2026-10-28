/**
 * Dictation via the browser's own speech recognition.
 *
 * Deliberately not a React hook and deliberately tiny: this wraps a vendor-prefixed API
 * that only Chromium-family browsers implement, and the whole contract is "start, give me
 * transcripts, stop". Everything stateful stays in the component.
 *
 * Firefox has no SpeechRecognition at all and Safari's is unreliable, so `speechSupported`
 * is checked before the microphone button is rendered rather than failing on click.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};

type SpeechCtor = new () => SpeechRecognitionLike;

function ctor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return ctor() !== null;
}

export type Dictation = { stop: () => void };

/**
 * Start listening.
 *
 * `onText` receives the transcript so far — interim results included, so the input shows
 * words as they are spoken rather than appearing all at once at the end. `isFinal` tells
 * the caller when a phrase has settled and is safe to submit.
 *
 * The caller's `lang` matters more than it looks: the default would be the page's, and an
 * Indian English speaker dictating to en-US recognition loses names and numbers.
 */
export function startDictation(opts: {
  lang?: string;
  onText: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): Dictation | null {
  const Ctor = ctor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = opts.lang ?? navigator.language ?? "en-IN";
  rec.continuous = false;
  rec.interimResults = true;

  let transcript = "";

  rec.onresult = (event) => {
    let settled = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      transcript += result[0]?.transcript ?? "";
      if (result.isFinal) settled = true;
    }
    opts.onText(transcript.trim(), settled);
  };

  rec.onerror = (event) => {
    // "no-speech" and "aborted" are the user saying nothing or changing their mind, not
    // failures worth a toast.
    const code = event.error ?? "unknown";
    if (code === "no-speech" || code === "aborted") return;
    opts.onError?.(
      code === "not-allowed"
        ? "Microphone access was blocked. Allow it in your browser's site settings."
        : `Dictation failed (${code}).`,
    );
  };

  rec.onend = () => opts.onEnd?.();

  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.abort() };
}
