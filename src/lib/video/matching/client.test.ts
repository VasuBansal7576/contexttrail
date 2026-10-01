import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalComparisonResponse } from './application-contract';
import type { FramePairComparison } from './model';
import { ComparisonClientError, compareFiles, formatTimestamp, frameSource, getComparisonCapabilities, parseComparisonCapabilities, parseComparisonResponse, validateComparisonFile } from './client';

const mediaHash = 'a'.repeat(64), frameHash = 'b'.repeat(64), leftId = `image:sha256:${frameHash}`, rightId = `video:sha256:${mediaHash}`;
function fixture(): LocalComparisonResponse {
  const left = { mediaId: leftId, frameId: `${leftId}:still`, contentHash: frameHash, timestampMs: null, mimeType: 'image/png', width: 1, height: 1, base64: 'iVBORw0KGgo=' } satisfies LocalComparisonResponse['frames']['left'][number];
  const right = { ...left, mediaId: rightId, frameId: `${rightId}:0`, timestampMs: 0, mimeType: 'image/jpeg' } satisfies LocalComparisonResponse['frames']['right'][number];
  const pair: FramePairComparison = { left: { mediaId: left.mediaId, frameId: left.frameId, contentHash: left.contentHash, timestampMs: left.timestampMs }, right: { mediaId: right.mediaId, frameId: right.frameId, contentHash: right.contentHash, timestampMs: right.timestampMs }, leftRegion: { x: 0, y: 0, width: 1, height: 1 }, rightRegion: { x: 0, y: 0, width: 1, height: 1 }, status: 'candidate_visual_overlap', basis: 'bounded_pixel_alignment', distance: { meanAbsoluteRgbError: 0.01, trimmedAbsoluteRgbError: 0.001, edgeError: 0.005, comparedTiles: 16, retainedTiles: 12, informativeTiles: 12, tiles: Array.from({ length: 16 }, (_, i) => ({ column: i % 4, row: Math.floor(i / 4), rgbError: 0.01, edgeError: i === 15 ? 2 : 0.005, informative: true, retained: i < 12 })) } };
  return { schemaVersion: 'contexttrail-local-media-comparison-v1', frames: { left: [left], right: [right] }, persistence: { status: 'not_saved', reason: 'Comparison not saved to case.' }, report: { schemaVersion: 1, algorithm: 'bounded-pixel-alignment-v1', inputs: { left: { mediaId: leftId, contentHash: frameHash, coverage: { kind: 'still_image', fullImageDecoded: true }, rasterPreprocessing: 'encoded_orientation_black_alpha_matte' }, right: { mediaId: rightId, contentHash: mediaHash, coverage: { kind: 'sampled_video', durationMs: 1000, requestedTimestampsMs: [0], decodedTimestampsMs: [0], sampleCount: 1, largestUnsampledGapMs: 1000, temporalCoverageFraction: null, audioAnalyzed: false }, rasterPreprocessing: 'encoded_orientation_black_alpha_matte' } }, comparedFramePairs: 1, comparisons: [pair], candidates: [structuredClone(pair)], parameters: { minCropAxisFraction: 0.6, descriptorSide: 24, maxTrimmedRgbError: 0.065, maxMeanRgbError: 0.15, maxEdgeError: 0.07, minInformativeTiles: 8, discardedTileFraction: 0.25 }, limitations: ['Sampled frames only. No identity verdict.'] } };
}
const capabilityFixture = {
  schemaVersion: 'contexttrail-local-media-capabilities-v1', mode: 'local_supplied_media_only', busy: false, persistence: 'not_saved',
  limits: { videoBytes: 32 * 1024 * 1024, imageBytes: 8 * 1024 * 1024, videoDurationMs: 120000, videoSamples: 3, comparedFramePairs: 9, requestBytes: 64 * 1024 * 1024 + 64 * 1024, responseBytes: 16 * 1024 * 1024, uploadMs: 30000, deadlineMs: 330000, activeJobs: 1 },
  formats: [{ extension: 'mp4', kind: 'video', mimeType: 'video/mp4' }, { extension: 'jpg', kind: 'image', mimeType: 'image/jpeg' }, { extension: 'png', kind: 'image', mimeType: 'image/png' }],
};
afterEach(() => vi.unstubAllGlobals());

describe('browser-safe local comparison boundary', () => {
  it('preserves valid frame payloads, timestamps, error values above one, and no-save state', () => {
    const result = parseComparisonResponse(fixture());
    expect(result).toEqual(fixture());
    expect(result.report.comparisons[0].distance.tiles[15].edgeError).toBe(2);
    expect(frameSource(result.frames.left[0])).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
  it.each([null, [], {}, { schemaVersion: 'new-version' }])('rejects incomplete unknown input %j', value => expect(() => parseComparisonResponse(value)).toThrow(ComparisonClientError));
  it('rejects nonfinite scores, invalid rectangles, invalid sample coverage and foreign frame references', () => {
    const score = fixture(); score.report.comparisons[0].distance.edgeError = NaN;
    const crop = fixture(); crop.report.comparisons[0].leftRegion.width = 1.5;
    const count = fixture(); count.report.comparedFramePairs = 2;
    const reference = fixture(); reference.report.comparisons[0].left.frameId = 'unreturned-frame';
    const coverage = fixture(); coverage.report.inputs.right.coverage = { kind: 'sampled_video', durationMs: 1000, requestedTimestampsMs: [0], decodedTimestampsMs: [0], sampleCount: 3, largestUnsampledGapMs: 1000, temporalCoverageFraction: null, audioAnalyzed: false };
    const timestamp = fixture(); timestamp.frames.right[0].timestampMs = 500;
    for (const invalid of [score, crop, count, reference, coverage, timestamp]) expect(() => parseComparisonResponse(invalid)).toThrow(ComparisonClientError);
  });
  it('rejects unsupported image MIME, corrupt base64 and candidate promotion', () => {
    const unsafeMime = fixture();
    const raw = { ...unsafeMime, frames: { ...unsafeMime.frames, left: [{ ...unsafeMime.frames.left[0], mimeType: 'image/svg+xml' }] } };
    const base64 = fixture(); base64.frames.left[0].base64 = 'javascript:alert(1)';
    const candidate = fixture(); candidate.report.comparisons[0].status = 'no_candidate';
    for (const invalid of [raw, base64, candidate]) expect(() => parseComparisonResponse(invalid)).toThrow(ComparisonClientError);
  });
  it('preserves a zero-candidate result without manufacturing a verdict', () => {
    const response = fixture(); response.report.comparisons[0].status = 'no_candidate'; response.report.candidates = [];
    const parsed = parseComparisonResponse(response);
    expect(parsed.report.candidates).toEqual([]);
    expect(parsed.report).not.toHaveProperty('verdict');
  });
  it('validates capability limits and keeps server busy state', () => {
    expect(parseComparisonCapabilities({ ...capabilityFixture, busy: true }).busy).toBe(true);
    expect(() => parseComparisonCapabilities({ ...capabilityFixture, limits: { ...capabilityFixture.limits, videoSamples: 100 } })).toThrow();
    expect(() => parseComparisonCapabilities({ ...capabilityFixture, mode: 'web_search' })).toThrow();
  });
  it('checks size, extension, declared MIME, empty files and the selected kind', () => {
    const capabilities = parseComparisonCapabilities(capabilityFixture);
    expect(validateComparisonFile(new File(['x'], 'clip.MP4', { type: 'video/mp4' }), 'video', capabilities)).toBeNull();
    expect(validateComparisonFile(new File(['x'], 'clip.mp4'), 'video', capabilities)).toBeNull();
    expect(validateComparisonFile(new File(['x'], 'clip.mp4', { type: 'application/octet-stream' }), 'video', capabilities)).toBeNull();
    expect(validateComparisonFile(new File(['x'], 'clip.mp4', { type: 'image/png' }), 'video', capabilities)).toMatch(/extension and type/);
    expect(validateComparisonFile(new File(['x'], 'clip.mp4'), 'image', capabilities)).toMatch(/extension and type/);
    expect(validateComparisonFile(new File([], 'clip.mp4'), 'video', capabilities)).toMatch(/empty/);
    expect(validateComparisonFile(new File(['x'], '../clip.mp4'), 'video', capabilities)).toMatch(/without a path/);
    expect(validateComparisonFile(new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'still.jpg'), 'image', capabilities)).toMatch(/8 MiB limit/);
  });
  it('renders media-relative timestamps including millisecond rollover', () => {
    expect(formatTimestamp(null)).toBe('Still image'); expect(formatTimestamp(72910)).toBe('01:12.910'); expect(formatTimestamp(59999.8)).toBe('01:00.000');
  });
});
describe('same-origin supplied-file requests', () => {
  it('sends only the specified files, kinds and rights to the local route with the cancellation signal', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(fixture())); vi.stubGlobal('fetch', fetchMock);
    const left = new File(['image'], 'left.png', { type: 'image/png' }), right = new File(['video'], 'right.mp4', { type: 'video/mp4' }), controller = new AbortController();
    await compareFiles({ left, right, leftKind: 'image', rightKind: 'video', signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    if (!options) throw new Error('Expected request options');
    expect(url).toBe('/api/media/compare'); expect(options.signal).toBe(controller.signal); expect(options.method).toBe('POST'); expect(options.cache).toBe('no-store');
    expect(options.body).toBeInstanceOf(FormData);
    if (!(options.body instanceof FormData)) throw new Error('Expected FormData');
    expect([...options.body.keys()]).toEqual(['left', 'right', 'leftKind', 'rightKind', 'rights']); expect(options.body.get('rights')).toBe('user_provided'); expect(options.body.get('left')).toBe(left); expect(options.body.get('right')).toBe(right);
  });
  it('fetches capabilities without files, and propagates bounded endpoint errors', async () => {
    const fetchMock = vi.fn(async () => Response.json(capabilityFixture)); vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect((await getComparisonCapabilities(signal)).mode).toBe('local_supplied_media_only');
    expect(fetchMock).toHaveBeenCalledWith('/api/media/compare', { signal, cache: 'no-store' });
    fetchMock.mockImplementation(async () => Response.json({ error: 'Local media comparison is disabled.', code: 'LOCAL_MEDIA_DISABLED' }, { status: 503 }));
    await expect(getComparisonCapabilities(signal)).rejects.toMatchObject({ code: 'LOCAL_MEDIA_DISABLED', status: 503 });
  });
  it('keeps abort failures distinct from invalid responses', async () => {
    const controller = new AbortController(); controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }));
    await expect(getComparisonCapabilities(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// Exercise the actual client component in a DOM without launching a browser.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { VideoCompare } from '@/components/casebook/VideoCompare';

async function mountedComparison() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/compare' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('self', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('navigator', dom.window.navigator); vi.stubGlobal('HTMLElement', dom.window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('React', React);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local-test-${Math.random()}`);
  const pending: { resolve: (response: Response) => void; signal: AbortSignal | null | undefined }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method === 'POST') return new Promise<Response>(resolve => pending.push({ resolve, signal: options.signal }));
    return Response.json(capabilityFixture);
  }));
  const container = dom.window.document.getElementById('root'); if (!container) throw new Error('Missing test root');
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(VideoCompare)); });
  function field(label: string) {
    const element = container?.querySelector(`input[aria-label="${label}"]`);
    if (!(element instanceof dom.window.HTMLInputElement)) throw new Error(`Missing ${label}`);
    return element;
  }
  async function choose(label: string, name: string) {
    const element = field(label);
    Object.defineProperty(element, 'files', { configurable: true, value: [new File(['media'], name, { type: name.endsWith('.png') ? 'image/png' : 'video/mp4' })] });
    await act(async () => element.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  }
  async function authorizeAndSubmit(submitCount = 1) {
    const rights = container?.querySelector('.video-rights input'); if (!(rights instanceof dom.window.HTMLInputElement)) throw new Error('Missing rights control');
    await act(async () => rights.click());
    const form = container?.querySelector('form'); if (!form) throw new Error('Missing comparison form');
    await act(async () => {
      for (let count = 0; count < submitCount; count++) form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
  }
  async function prepare(submitCount = 1) {
    const kind = container?.querySelector('select[aria-label="File A media kind"]'); if (!(kind instanceof dom.window.HTMLSelectElement)) throw new Error('Missing kind selector');
    await act(async () => { kind.value = 'image'; kind.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await choose('Choose file A', 'left.png'); await choose('Choose file B', 'right.mp4');
    await authorizeAndSubmit(submitCount);
  }
  return { container, pending, choose, prepare, authorizeAndSubmit, revoke, close: async () => { await act(async () => root.unmount()); create.mockRestore(); revoke.mockRestore(); dom.window.close(); } };
}
describe('comparison component request lifecycle', () => {
  it('admits only one request when two submit events arrive before the next render', async () => {
    const view = await mountedComparison();
    try {
      await view.prepare(2);
      expect(view.pending).toHaveLength(1);
      expect(view.pending[0].signal?.aborted).toBe(false);
      await act(async () => view.pending[0].resolve(Response.json(fixture())));
      expect(view.container.querySelector('.video-results')).not.toBeNull();
    } finally { await view.close(); }
  });
  it('cancels with AbortController, preserves files and ignores a late success', async () => {
    const view = await mountedComparison();
    try {
      await view.prepare(); expect(view.pending).toHaveLength(1);
      const cancel = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Cancel comparison'); if (!cancel) throw new Error('Missing cancel');
      await act(async () => cancel.click());
      expect(view.pending[0].signal?.aborted).toBe(true);
      expect(view.container.textContent).toContain('left.png'); expect(view.container.textContent).toContain('right.mp4'); expect(view.container.textContent).toContain('Comparison cancelled.');
      await act(async () => view.pending[0].resolve(Response.json(fixture())));
      expect(view.container.querySelector('.video-results')).toBeNull();
      expect(view.container.textContent).toContain('Comparison cancelled.');
    } finally { await view.close(); }
  });
  it('drops old results on replacement, resets rights and revokes replaced previews', async () => {
    const view = await mountedComparison();
    try {
      await view.prepare(); await act(async () => view.pending[0].resolve(Response.json(fixture())));
      expect(view.container.querySelector('.video-results')).not.toBeNull();
      expect(view.container.textContent).toContain('Comparison not saved to case.');
      await view.choose('Choose file A', 'replacement.png');
      expect(view.container.querySelector('.video-results')).toBeNull(); expect(view.container.textContent).toContain('replacement.png'); expect(view.revoke).toHaveBeenCalled();
      const submit = view.container.querySelector('button[type="submit"]'); expect(submit?.hasAttribute('disabled')).toBe(true);
    } finally { await view.close(); }
  });
  it('keeps selected files after server errors and aborts an in-flight request on unmount', async () => {
    const view = await mountedComparison();
    let closed = false;
    try {
      await view.prepare(); await act(async () => view.pending[0].resolve(Response.json({ error: 'Decoder unavailable.', code: 'DECODER_UNAVAILABLE' }, { status: 503 })));
      expect(view.container.textContent).toContain('Decoder unavailable.'); expect(view.container.textContent).toContain('left.png'); expect(view.container.textContent).toContain('right.mp4');
      const form = view.container.querySelector('form'); if (!form) throw new Error('Missing form');
      await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      expect(view.pending).toHaveLength(2);
      await view.close(); closed = true;
      expect(view.pending[1].signal?.aborted).toBe(true);
    } finally { if (!closed) await view.close(); }
  });
});
