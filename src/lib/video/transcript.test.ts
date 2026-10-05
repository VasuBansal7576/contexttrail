import { describe, expect, it } from 'vitest';
import { parseMediaTranscript, speechSearchQuestion, transcriptFromWhisper, unavailableTranscript } from './transcript';
const hash = `sha256:${'a'.repeat(64)}`;
function segment(text: string, start: number, probability = .9) { return { offsets: { from: start, to: start + 1000 }, text, tokens: [{ text: '[_BEG_]', p: .01 }, { text, p: probability }] }; }
const raw = { result: { language: 'en' }, transcription: [segment('UPI transaction volume rose in India.', 0), segment('The figure refers to August 2026.', 1500), segment('This needs independent source checking.', 3000)] };
describe('recognized speech remains an unreviewed, timestamped lead', () => {
  it('retains actual wording, excludes special token scores, and binds distributed query leads', () => {
    const transcript = transcriptFromWhisper(raw, 5000, hash);
    expect(transcript.segments).toEqual(raw.transcription.map(s => ({ startMs: s.offsets.from, endMs: s.offsets.to, text: s.text, recognition: 'unreviewed' })));
    expect(parseMediaTranscript(transcript)).toEqual(transcript);
    const question = speechSearchQuestion(transcript, 'A supplied assertion');
    for (const s of raw.transcription) expect(question).toContain(s.text);
    expect(question).toContain('unreviewed');
    expect(question).toContain('user-supplied caption');
  });
  it('keeps low-confidence text visible but excludes it from searches', () => {
    const transcript = transcriptFromWhisper({ result: { language: 'hi' }, transcription: [segment('Uncertain spoken name 7000', 0, .2), segment('भारत में भुगतान का संदर्भ', 1500)] }, 3000, hash);
    expect(transcript.segments[0].recognition).toBe('low_confidence');
    expect(speechSearchQuestion(transcript)).not.toContain('7000');
    expect(speechSearchQuestion(transcript)).toContain('भारत');
    const uncertain = transcriptFromWhisper({ result: { language: 'en' }, transcription: [segment('Potential hallucinated text', 0, .2)] }, 2000, hash);
    expect(speechSearchQuestion(uncertain)).toBeNull();
  });
  it('keeps the middle factual segment in a short recording and stays within the limit with a caption', () => {
    const text = ['We asked about 24 billion UPI transactions in August.', 'Retrieved reporting says 24.51 billion.', 'Open the passage inside the app.', 'Check the month, the source and the publication date.'];
    const transcript = transcriptFromWhisper({ result: { language: 'en' }, transcription: text.map((t, i) => segment(t, i * 1500)) }, 6000, hash);
    for (const claim of [null, 'A supplied caption '.repeat(20)]) {
      const query = speechSearchQuestion(transcript, claim);
      for (const segment of text) expect(query).toContain(segment);
      expect(query!.length).toBeLessThanOrEqual(500);
    }
  });
  it('does not manufacture speech from music/silence labels or unavailable recognition', () => {
    const transcript = transcriptFromWhisper({ result: { language: 'en' }, transcription: [segment('[Music]', 0), segment('(silence)', 1500)] }, 3000, hash);
    expect(transcript.status).toBe('no_speech_detected');
    expect(transcript.segments).toEqual([]);
    expect(speechSearchQuestion(transcript)).toBeNull();
    expect(speechSearchQuestion(unavailableTranscript('Decoder unavailable'))).toBeNull();
  });
  it('rejects malformed or out-of-order timestamps and mismatched statuses', () => {
    const transcript = transcriptFromWhisper(raw, 5000, hash);
    for (const altered of [{ ...transcript, status: 'unavailable' }, { ...transcript, modelHash: null }, { ...transcript, segments: [...transcript.segments].reverse() }, { ...transcript, segments: [{ ...transcript.segments[0], endMs: 6000 }] }]) expect(() => parseMediaTranscript(altered)).toThrow();
    expect(() => transcriptFromWhisper({ result: { language: 'en' }, transcription: [segment('Real wording', -1)] }, 5000, hash)).toThrow();
  });
});
it('withholds repetitive high-scoring recognition from automatic search without erasing the transcript', () => {
  const transcript = transcriptFromWhisper({ result: { language: 'hi' }, transcription: Array.from({ length: 8 }, (_, index) => segment(index === 0 ? 'अब दिवार गे दिख है।' : 'अपनी दिवार गे दिख है।', index * 1500, .99)) }, 12000, hash);
  expect(transcript.segments).toHaveLength(8);
  expect(transcript.segments.every(s => s.recognition === 'low_confidence')).toBe(true);
  expect(speechSearchQuestion(transcript)).toBeNull();
  expect(transcript.limitations.join(' ')).toContain('Repetition does not establish that speech is fabricated');
});
