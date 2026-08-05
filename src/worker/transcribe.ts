// Ported from Cyborgy (Reference code/cyborgy/pipeline.ts). Segments recorded
// at pause boundaries stay short, so no single call approaches Worker limits.
import type { Env, TranscriptWord } from "./types";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface Transcription {
  text: string;
  /** Word-level timestamps when the model provides them; null otherwise. */
  words: TranscriptWord[] | null;
}

/** Transcribe one audio segment with Workers AI Whisper (free daily allocation). */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<Transcription> {
  const result = (await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: arrayBufferToBase64(audio),
  })) as unknown as Record<string, unknown>;
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) throw new Error("transcription returned empty text");
  return { text, words: harvestWords(result) };
}

/** Word timestamps appear either top-level (`words`) or nested in `segments[].words`. */
function harvestWords(result: Record<string, unknown>): TranscriptWord[] | null {
  const isWord = (w: unknown): w is TranscriptWord =>
    typeof w === "object" &&
    w !== null &&
    typeof (w as TranscriptWord).word === "string" &&
    typeof (w as TranscriptWord).start === "number" &&
    typeof (w as TranscriptWord).end === "number";

  if (Array.isArray(result.words) && result.words.every(isWord) && result.words.length > 0) {
    return result.words;
  }
  if (Array.isArray(result.segments)) {
    const words = result.segments.flatMap((s) =>
      Array.isArray((s as { words?: unknown[] }).words)
        ? ((s as { words: unknown[] }).words.filter(isWord) as TranscriptWord[])
        : [],
    );
    if (words.length > 0) return words;
  }
  return null;
}
