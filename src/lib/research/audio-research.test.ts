import { describe, expect, it, vi } from 'vitest';
import { runAutomaticResearch, type AutomaticResearchDeps } from './automatic';
import { parseAutomaticResearchResult } from './automatic-client';
import { parseSavedVideoReport, savedVideoView } from './saved-video';
import { transcriptFromWhisper, unavailableTranscript } from '../video/transcript';
import { parseAutomaticForm } from './automatic-input';
const recognized = transcriptFromWhisper({ result: { language: 'en' }, transcription: [{ text: 'UPI payments reached a new monthly transaction volume in August 2026.', offsets: { from: 0, to: 2500 }, tokens: [{ text: 'UPI', p: .9 }] }] }, 3000, `sha256:${'a'.repeat(64)}`);
function dependencies(): AutomaticResearchDeps { return { serpapi: { search: vi.fn(async p => ({ [p.engine === 'google_news' ? 'news_results' : 'organic_results']: [{ title: 'UPI source', link: 'https://source.example.org/upi', snippet: 'UPI monthly payments in August 2026.' }] })), uploadImage: vi.fn(async () => 'offline-only') }, jev: null, fetchPage: vi.fn(async url => ({ url, html: `<article><p>${'UPI payments rose in August 2026 according to the monthly transaction record. '.repeat(8)}</p></article>` })), transcribeMedia: vi.fn(async () => recognized) }; }
describe('audio research and exact retention', () => {
  it('researches recognized speech without an image upload or a fabricated user assertion, then reopens unchanged', async () => {
    const deps = dependencies();
    const result = await runAutomaticResearch({ kind: 'audio', bytes: new Uint8Array([1, 2, 3]), rights: 'user_provided', claim: 'A caption supplied by the user.' }, () => {}, deps);
    expect(result.kind).toBe('audio'); expect(result.transcript).toEqual(recognized);
    expect(result.caseRecord.assets[0]).toMatchObject({ kind: 'audio', location: { kind: 'not_retained' }, durationMs: 3000 });
    expect(result.claimReport?.mode).toBe('source_assertions');
    expect(deps.serpapi?.uploadImage).not.toHaveBeenCalled(); expect(deps.serpapi?.search).toHaveBeenCalledTimes(6);
    const view = parseAutomaticResearchResult(JSON.parse(JSON.stringify(result)));
    const saved = parseSavedVideoReport({ schemaVersion: 'contexttrail-media-report-v2', result: view.retainedResult });
    expect(savedVideoView(saved)).toEqual(view);
    expect(() => parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: view.retainedResult })).toThrow();
    expect(JSON.stringify(saved)).not.toContain('"bytes"');
    expect(() => parseAutomaticResearchResult({ ...result, question: 'An unrelated transcript assertion' })).toThrow(/bound/);
  });
  it.each([unavailableTranscript('No decoder'), { ...recognized, segments: recognized.segments.map(s => ({ ...s, recognition: 'low_confidence' as const })) }])('retains failed/uncertain audio without speculative provider searches', async transcript => {
    const deps = dependencies(); deps.transcribeMedia = async () => transcript;
    const result = await runAutomaticResearch({ kind: 'audio', bytes: new Uint8Array([1]), rights: 'user_provided' }, () => {}, deps);
    expect(deps.serpapi?.search).not.toHaveBeenCalled();
    expect(result.caseRecord.evidence).toEqual([]); expect(result.frames).toEqual([]);
    expect(result.transcript).toEqual(transcript);
    expect(parseAutomaticResearchResult(result).transcript).toEqual(transcript);
  });
  it('cancels after recognition without dispatching a search', async () => {
    const deps = dependencies(), controller = new AbortController(); deps.signal = controller.signal;
    deps.transcribeMedia = async () => { controller.abort(); return recognized; };
    await expect(runAutomaticResearch({ kind: 'audio', bytes: new Uint8Array([1]), rights: 'user_provided' }, () => {}, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.serpapi?.search).not.toHaveBeenCalled();
  });
  it.each(['decode', 'retrieval'] as const)('preserves the completed speech trail when visual %s fails, including save and reopen', async failure => {
    const deps = dependencies();
    deps.prepareVideo = async () => { if (failure === 'decode') throw Error('Decoder failed'); return { mediaId: 'video:controlled', contentHash: 'b'.repeat(64), durationMs: 3000, coverage: 'sampled_frames_only', frames: [{ id: 'frame:controlled', mediaId: 'video:controlled', timestampMs: 0, contentHash: 'c'.repeat(64), mimeType: 'image/jpeg', bytes: new Uint8Array([1]) }] }; };
    deps.traceFrame = async (_input, emit) => { emit({ type: 'investigation.error', code: 'INTERNAL_ERROR', message: 'Controlled frame failure' }); };
    const result = await runAutomaticResearch({ kind: 'video', bytes: new Uint8Array([1,2,3]), rights: 'user_provided' }, () => {}, deps);
    expect(result.frames).toEqual([]); expect(result.spokenResearch?.caseRecord.evidence.length).toBeGreaterThan(0);
    expect(result.limitations).toContain('No completed visual search was retained. The speech trail is separate; it cannot verify visual identity, continuity or the caption.');
    const view = parseAutomaticResearchResult(result);
    expect(savedVideoView(parseSavedVideoReport({ schemaVersion: 'contexttrail-media-report-v2', result: view.retainedResult }))).toEqual(view);
    expect(deps.serpapi?.uploadImage).not.toHaveBeenCalled();
  });
  it('validates local audio opt-in, permission and signatures before decoding', async () => {
    vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1');
    try {
      const form = new FormData(); form.set('kind', 'audio'); form.set('rights', 'user_provided'); form.set('audio', new Blob([Buffer.from('RIFFxxxxWAVEfmt data')]), 'owned.wav');
      expect((await parseAutomaticForm(form)).kind).toBe('audio');
      form.set('audio', new Blob(['#EXTM3U https://remote.example/private'])); await expect(parseAutomaticForm(form)).rejects.toMatchObject({ code: 'INVALID_AUDIO' });
      form.set('rights', 'no'); await expect(parseAutomaticForm(form)).rejects.toMatchObject({ code: 'RIGHTS_REQUIRED' });
    } finally { vi.unstubAllEnvs(); }
  });
});
