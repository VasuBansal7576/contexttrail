export interface TranscriptSegment { startMs: number; endMs: number; text: string; recognition: 'unreviewed' | 'low_confidence' }
export interface MediaTranscript {
  schemaVersion: 'contexttrail-transcript-v1';
  status: 'transcribed' | 'no_speech_detected' | 'no_audio' | 'unavailable';
  engine: 'whisper.cpp'; model: string | null; modelHash: string | null;
  language: string | null; durationMs: number | null;
  segments: TranscriptSegment[]; limitations: string[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transcript');
  return value as Record<string, unknown>;
}
export function parseMediaTranscript(value: unknown): MediaTranscript {
  const v = object(value);
  if (v.schemaVersion !== 'contexttrail-transcript-v1' || v.engine !== 'whisper.cpp' || !['transcribed', 'no_speech_detected', 'no_audio', 'unavailable'].includes(String(v.status))
    || !Array.isArray(v.segments) || v.segments.length > 500 || !Array.isArray(v.limitations) || v.limitations.length > 20 || v.limitations.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('Invalid transcript');
  if (v.durationMs !== null && (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs <= 0 || v.durationMs > 120_000)) throw new Error('Invalid transcript duration');
  if (v.model !== null && (typeof v.model !== 'string' || !/^[\w.-]{1,100}$/.test(v.model))) throw new Error('Invalid transcript model');
  if (v.modelHash !== null && (typeof v.modelHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.modelHash))) throw new Error('Invalid transcript model hash');
  if (v.language !== null && (typeof v.language !== 'string' || !/^[a-z]{2,3}$/.test(v.language))) throw new Error('Invalid transcript language');
  let previous = 0;
  const segments = v.segments.map((item): TranscriptSegment => {
    const s = object(item);
    if (typeof s.startMs !== 'number' || !Number.isFinite(s.startMs) || s.startMs < previous || typeof s.endMs !== 'number' || !Number.isFinite(s.endMs) || s.endMs <= s.startMs || typeof v.durationMs !== 'number' || s.endMs > v.durationMs + 50
      || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000 || (s.recognition !== 'unreviewed' && s.recognition !== 'low_confidence')) throw new Error('Invalid transcript segment');
    previous = s.startMs;
    return { startMs: s.startMs, endMs: s.endMs, text: s.text, recognition: s.recognition };
  });
  if ((v.status === 'transcribed') !== (segments.length > 0) || (segments.length > 0 && (v.model === null || v.modelHash === null))) throw new Error('Invalid transcript status');
  return { schemaVersion: 'contexttrail-transcript-v1', engine: 'whisper.cpp', status: v.status as MediaTranscript['status'], model: v.model as string | null, modelHash: v.modelHash as string | null, language: v.language as string | null, durationMs: v.durationMs as number | null, segments, limitations: v.limitations as string[] };
}
export function unavailableTranscript(reason: string, status: 'no_audio' | 'unavailable' = 'unavailable'): MediaTranscript {
  return { schemaVersion: 'contexttrail-transcript-v1', engine: 'whisper.cpp', status, model: null, modelHash: null, language: null, durationMs: null, segments: [], limitations: [reason] };
}

/** Converts actual recognizer output; low token scores remain visible and are excluded from automatic text queries. */
export function transcriptFromWhisper(value: unknown, durationMs: number, modelHash: string): MediaTranscript {
  const v = object(value), result = object(v.result);
  if (!Array.isArray(v.transcription) || v.transcription.length > 500) throw new Error('Invalid recognizer output');
  const segments: TranscriptSegment[] = [];
  for (const item of v.transcription) {
    const s = object(item), offsets = object(s.offsets);
    if (typeof s.text !== 'string' || !s.text.trim() || /^[\s\[\](]*?(?:music|silence|applause|blank_audio|inaudible)[\s\]\)]*$/i.test(s.text)) continue;
    if (typeof offsets.from !== 'number' || typeof offsets.to !== 'number' || offsets.to <= offsets.from || offsets.from < 0 || offsets.from >= durationMs) throw new Error('Invalid recognizer timestamps');
    const scores = Array.isArray(s.tokens) ? s.tokens.flatMap(value => { const token = object(value); return typeof token.text === 'string' && !/^\[_/.test(token.text) && typeof token.p === 'number' && token.p >= 0 && token.p <= 1 ? [token.p] : []; }) : [];
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    segments.push({ startMs: offsets.from, endMs: Math.min(durationMs, offsets.to), text: s.text.trim(), recognition: mean >= 0.6 ? 'unreviewed' : 'low_confidence' });
  }
  const normalized = segments.map(segment => segment.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const counts = new Map<string, number>(); for (const text of normalized) counts.set(text, (counts.get(text) ?? 0) + 1);
  const repetitive = segments.length >= 4 && [...counts.values()].some(count => count >= 3 && count / segments.length >= .5);
  if (repetitive) for (const segment of segments) segment.recognition = 'low_confidence';
  return parseMediaTranscript({ schemaVersion: 'contexttrail-transcript-v1', engine: 'whisper.cpp', status: segments.length ? 'transcribed' : 'no_speech_detected', model: 'whisper-small-multilingual', modelHash, language: result.language, durationMs, segments,
    limitations: [...(repetitive ? ['Repeated recognition dominates this recording. All recognized wording is marked uncertain and excluded from automatic searches until the original is checked. Repetition does not establish that speech is fabricated.'] : []), 'Automatic speech recognition can mishear speech, names and numbers or hallucinate text in noise. Inspect the original audio before using a transcription as evidence.', 'Transcript timestamps are offsets in the supplied media, not event or publication dates.', 'No speaker identity, authorship, authenticity, edits or intent are inferred.', 'Low-confidence segments are retained for review and excluded from automatic search wording.'] });
}

/** Historical derivation retained to validate existing saved reports exactly. */
export function legacySpeechSearchQuestion(transcript: MediaTranscript, claim: string | null = null): string | null {
  const usable = transcript.segments.filter(segment => segment.recognition === 'unreviewed');
  if (!usable.length) return null;
  const indices = [...new Set([0, Math.floor(usable.length / 2), usable.length - 1])];
  const lead = indices.map(index => usable[index].text.slice(0, 105)).join(' / ');
  return `What context and evidence relates to this unreviewed recognized speech: “${lead}”${claim?.trim() ? `, with the user-supplied caption “${claim.trim().slice(0, 90)}”` : ''}?`.slice(0, 500);
}
/** Keep every usable segment when it fits. Longer speech uses explicitly partial distributed leads. */
export function speechSearchQuestion(transcript: MediaTranscript, claim: string | null = null): string | null {
  const usable = transcript.segments.filter(segment => segment.recognition === 'unreviewed');
  if (!usable.length) return null;
  const prefix = 'What context and evidence relates to this unreviewed recognized speech: “';
  const suffix = `”${claim?.trim() ? `, with the user-supplied caption “${claim.trim().slice(0, 90)}”` : ''}?`;
  const maximum = Math.min(350, 500 - prefix.length - suffix.length);
  const complete = usable.map(segment => segment.text).join(' / ');
  const indices = [...new Set([0, Math.floor(usable.length / 2), usable.length - 1])];
  const perSegment = Math.floor((maximum - (indices.length - 1) * 3) / indices.length);
  const bounded = (text: string) => { if (text.length <= perSegment) return text; const end = text.lastIndexOf(' ', perSegment); return text.slice(0, end > perSegment / 2 ? end : perSegment); };
  const lead = complete.length <= maximum ? complete : indices.map(index => bounded(usable[index].text)).join(' / ');
  return prefix + lead + suffix;
}
