'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import SaveComparison from './SaveComparison';
import { CasebookShell, ChapterHeading } from './CasebookShell';
import type { LocalComparisonFrame, LocalComparisonResponse } from '@/lib/video/matching/application-contract';
import type { FramePairComparison, MatchRegion, MediaCoverage } from '@/lib/video/matching/model';
import { compareFiles, formatBytes, formatTimestamp, frameSource, getComparisonCapabilities, validateComparisonFile, type ComparisonCapabilities, type MediaKind } from '@/lib/video/matching/client';

type SelectedMedia = { kind: MediaKind; file: File | null };
type Availability = { kind: 'loading' } | { kind: 'ready'; value: ComparisonCapabilities } | { kind: 'unavailable'; message: string };
type ComparisonState = { kind: 'idle' } | { kind: 'running' } | { kind: 'cancelled' } | { kind: 'error'; message: string } | { kind: 'complete'; result: LocalComparisonResponse };
const fallbackAccept = { image: '.jpg,.jpeg,.png,.webp', video: '.mp4,.mov,.webm,.mkv' };
const statusLabels: Record<FramePairComparison['status'], string> = { candidate_visual_overlap: 'Candidate visual overlap', no_candidate: 'No candidate', uninformative: 'Insufficient visual detail' };
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Could not reach the local comparison server. Your files remain selected.'; }

function useFilePreview(file: File | null): string | null {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return preview?.file === file ? preview.url : null;
}

function FileSlot({ side, selection, capabilities, onChange }: { side: 'A' | 'B'; selection: SelectedMedia; capabilities: ComparisonCapabilities | null; onChange: (selection: SelectedMedia) => void }) {
  const preview = useFilePreview(selection.file);
  const problem = selection.file && capabilities ? validateComparisonFile(selection.file, selection.kind, capabilities) : null;
  const accept = capabilities ? capabilities.formats.filter(f => f.kind === selection.kind).map(f => `.${f.extension}`).join(',') : fallbackAccept[selection.kind];
  const [previewFailed, setPreviewFailed] = useState<File | null>(null);
  return <section className="video-file-slot" aria-labelledby={`file-${side}-heading`}>
    <div className="video-slot-topline"><h2 id={`file-${side}-heading`}>Supplied file {side}</h2><label className="video-kind-label">Media kind<select aria-label={`File ${side} media kind`} value={selection.kind} onChange={event => onChange({ kind: event.target.value === 'image' ? 'image' : 'video', file: null })}><option value="video">Video</option><option value="image">Still image</option></select></label></div>
    <div className="video-file-preview">
      {preview && !problem && previewFailed !== selection.file ? selection.kind === 'video'
        ? <video key={preview} src={preview} controls preload="metadata" playsInline aria-label={`Preview of file ${side}`} onError={() => setPreviewFailed(selection.file)} />
        : <img src={preview} alt={`Selected file ${side}: ${selection.file?.name}`} onError={() => setPreviewFailed(selection.file)} />
        : <div className="video-preview-empty"><span className="video-frame-glyph" aria-hidden="true">{side}</span><p>{selection.file ? 'File selected' : 'A moment starts here.'}</p><span>{selection.file ? 'The local decoder checks the supplied bytes.' : 'Choose a file to compare its sampled frames.'}</span></div>}
    </div>
    <div className="video-file-controls">
      <label className="video-file-picker"><span>{selection.file ? 'Replace file' : `Choose ${selection.kind === 'video' ? 'video' : 'image'}`}</span><input key={selection.kind} aria-label={`Choose file ${side}`} type="file" accept={accept} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) onChange({ ...selection, file }); event.currentTarget.value = ''; }} /></label>
      <p className="video-file-name">{selection.file ? <>{selection.file.name}<span>{formatBytes(selection.file.size)}</span></> : 'No file selected'}</p>
      {selection.file ? <button type="button" className="video-remove" onClick={() => onChange({ ...selection, file: null })} aria-label={`Remove file ${side}`}>Remove</button> : null}
    </div>
    <p className="video-file-hint">{selection.kind === 'video' ? 'MP4 · MOV · WebM · MKV' : 'JPEG · PNG · WebP, still images only'}{capabilities ? ` · ${formatBytes(selection.kind === 'video' ? capabilities.limits.videoBytes : capabilities.limits.imageBytes)} maximum` : ''}</p>
    {previewFailed === selection.file && selection.file ? <p className="video-file-hint">Your browser could not preview this file. The local decoder may still support it.</p> : null}
    {problem ? <p className="video-file-error" role="alert">{problem}</p> : null}
  </section>;
}

function ComparisonFrame({ frame, label, region, showRegion }: { frame: LocalComparisonFrame; label: string; region: MatchRegion; showRegion: boolean }) {
  return <figure className="video-result-frame">
    <div className="video-frame-caption"><span className="eyebrow">{label} / decoded frame</span><span className="video-timestamp">{formatTimestamp(frame.timestampMs)}</span></div>
    <div className="video-frame-well"><div className="video-frame-image"><img src={frameSource(frame)} alt={`${label}, decoded ${frame.timestampMs === null ? 'still image' : `frame at ${formatTimestamp(frame.timestampMs)}`}`} width={frame.width} height={frame.height} />{showRegion ? <span className="video-region" aria-hidden="true" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} /> : null}</div></div>
    <figcaption>{frame.width} × {frame.height} pixels<span>{showRegion ? 'Yellow rectangle: approximate compared region' : 'Actual returned frame'}</span></figcaption>
  </figure>;
}
function CoverageNote({ coverage, label }: { coverage: MediaCoverage; label: string }) {
  return <div className="video-coverage-note"><p className="eyebrow">{label} / sampling coverage</p>{coverage.kind === 'still_image' ? <><h3>One still image</h3><p>The full supplied image was decoded. The matcher may compare an approximate crop.</p></> : <><h3>{coverage.sampleCount} frames / {formatTimestamp(coverage.durationMs)}</h3><p>Decoded at {coverage.decodedTimestampsMs.map(formatTimestamp).join(', ')}. Largest unsampled gap: {formatTimestamp(coverage.largestUnsampledGapMs)}.</p><p>No temporal coverage percentage is established. Audio was not analyzed.</p></>}</div>;
}
export function ComparisonResult({ result, saved = false }: { result: LocalComparisonResponse; saved?: boolean }) {
  const initial = result.report.comparisons.findIndex(pair => pair.status === 'candidate_visual_overlap');
  const [selectedIndex, setSelectedIndex] = useState(initial >= 0 ? initial : 0);
  const [showRegion, setShowRegion] = useState(false);
  const pair = result.report.comparisons[selectedIndex];
  const left = result.frames.left.find(frame => frame.frameId === pair.left.frameId), right = result.frames.right.find(frame => frame.frameId === pair.right.frameId);
  if (!left || !right) return <p role="alert">The selected pair is unavailable. Start a new comparison.</p>;
  const candidateCount = result.report.candidates.length;
  return <section className={`video-results${saved ? " video-results-saved" : ""}`} aria-labelledby="comparison-heading">
    <div className="video-results-heading"><div><p className="eyebrow">02 / inspect the sampled pairs</p><h2 id="comparison-heading">{candidateCount ? <>{candidateCount} candidate {candidateCount === 1 ? 'overlap' : 'overlaps'}. <em>Look closer.</em></> : <>No candidate overlap. <em>Keep the gaps in view.</em></>}</h2></div><span className="video-result-stamp">{result.report.comparedFramePairs} pairs compared<br />Supplied files only</span></div>
    <p className="video-result-caution">A candidate is a sampled visual overlap for human inspection. It does not establish identity, copying, authenticity, a publication date, or a verdict. No candidate does not establish absence of reuse.</p>
    <div className="video-pair-stage"><ComparisonFrame frame={left} label="File A" region={pair.leftRegion} showRegion={showRegion} /><svg className="video-pair-arrow" aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4" /></svg><ComparisonFrame frame={right} label="File B" region={pair.rightRegion} showRegion={showRegion} /></div>
    <div className="video-pair-controls"><p className={`video-pair-status ${pair.status === 'candidate_visual_overlap' ? 'video-is-candidate' : ''}`}>{statusLabels[pair.status]}</p><label className="video-region-toggle"><input type="checkbox" checked={showRegion} onChange={event => setShowRegion(event.target.checked)} />Show approximate compared regions</label></div>
    <div className="video-pair-strip" role="group" aria-label="All sampled frame comparisons">{result.report.comparisons.map((item, index) => <button type="button" key={`${item.left.frameId}:${item.right.frameId}`} aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(index)}><span className="eyebrow">Pair {String(index + 1).padStart(2, '0')}</span><span>{formatTimestamp(item.left.timestampMs)} / {formatTimestamp(item.right.timestampMs)}</span><span className="video-pair-strip-status">{statusLabels[item.status]}</span></button>)}</div>
    <div className="video-inspection-sheet">
      <div className="video-score-heading"><h3>Read the errors.</h3><p>Lower values mean less pixel error under this bounded alignment. These are raw errors, never confidence percentages or probabilities.</p></div>
      <dl className="video-score-grid"><div><dt>Mean RGB error</dt><dd>{pair.distance.meanAbsoluteRgbError.toFixed(5)}</dd></div><div><dt>Trimmed RGB error</dt><dd>{pair.distance.trimmedAbsoluteRgbError.toFixed(5)}</dd></div><div><dt>Edge error</dt><dd>{pair.distance.edgeError.toFixed(5)}</dd></div><div><dt>Informative retained tiles</dt><dd>{pair.distance.informativeTiles} / {pair.distance.retainedTiles}</dd></div></dl>
      <p className="video-score-footnote">Basis: {pair.basis === 'identical_encoded_bytes' ? 'identical encoded frame bytes' : 'bounded pixel alignment'}. {pair.distance.retainedTiles} of {pair.distance.comparedTiles} tiles retained. Discarded tiles can contain important changes or captions. Region boxes are approximate and are not saved evidence anchors.</p>
      <details className="video-details"><summary>Inspect all tile errors and matching gates</summary><div className="video-table-scroll"><table><caption>Tile errors for the selected sampled pair</caption><thead><tr><th scope="col">Tile</th><th scope="col">RGB error</th><th scope="col">Edge error</th><th scope="col">Informative</th><th scope="col">Retained</th></tr></thead><tbody>{pair.distance.tiles.map(tile => <tr key={`${tile.column}:${tile.row}`}><th scope="row">{tile.column + 1}, {tile.row + 1}</th><td>{tile.rgbError.toFixed(5)}</td><td>{tile.edgeError.toFixed(5)}</td><td>{tile.informative ? 'Yes' : 'No'}</td><td>{tile.retained ? 'Yes' : 'Discarded'}</td></tr>)}</tbody></table></div><p>Candidate gates: mean RGB ≤ {result.report.parameters.maxMeanRgbError}, trimmed RGB ≤ {result.report.parameters.maxTrimmedRgbError}, edge ≤ {result.report.parameters.maxEdgeError}, and at least {result.report.parameters.minInformativeTiles} informative retained tiles. Identical encoded bytes are reported separately. Algorithm: {result.report.algorithm}.</p></details>
      <div className="video-coverage-grid"><CoverageNote label="File A" coverage={result.report.inputs.left.coverage} /><CoverageNote label="File B" coverage={result.report.inputs.right.coverage} /></div>
      <details className="video-details"><summary>What this comparison cannot establish</summary><ul>{result.report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>
    </div>
    {saved ? <p className="video-persistence-note">Saved comparison snapshot. Sampled frames and the original report are retained; the original video files are not. The report’s initial not-saved status describes its original response.</p> : <SaveComparison result={result} />}
  </section>;
}

export function VideoCompare() {
  const [left, setLeft] = useState<SelectedMedia>({ kind: 'video', file: null });
  const [right, setRight] = useState<SelectedMedia>({ kind: 'video', file: null });
  const [rights, setRights] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ kind: 'loading' });
  const [state, setState] = useState<ComparisonState>({ kind: 'idle' });
  const requestId = useRef(0), controller = useRef<AbortController | null>(null);
  const capabilityId = useRef(0), capabilityController = useRef<AbortController | null>(null);
  const checkAvailability = useCallback(async () => {
    capabilityController.current?.abort();
    const current = ++capabilityId.current, abort = new AbortController(); capabilityController.current = abort;
    setAvailability({ kind: 'loading' });
    try { const value = await getComparisonCapabilities(abort.signal); if (current === capabilityId.current && !abort.signal.aborted) setAvailability({ kind: 'ready', value }); }
    catch (error) { if (current === capabilityId.current && !abort.signal.aborted) setAvailability({ kind: 'unavailable', message: errorMessage(error) }); }
  }, []);
  useEffect(() => { void checkAvailability(); return () => { requestId.current++; capabilityId.current++; controller.current?.abort(); capabilityController.current?.abort(); }; }, [checkAvailability]);
  const capabilities = availability.kind === 'ready' ? availability.value : null;
  const leftError = left.file && capabilities ? validateComparisonFile(left.file, left.kind, capabilities) : null;
  const rightError = right.file && capabilities ? validateComparisonFile(right.file, right.kind, capabilities) : null;
  const needsVideo = left.kind !== 'video' && right.kind !== 'video';
  const ready = !!(capabilities && !capabilities.busy && left.file && right.file && rights && !leftError && !rightError && !needsVideo);
  function replace(side: 'left' | 'right', selection: SelectedMedia) {
    requestId.current++; controller.current?.abort(); controller.current = null; setState({ kind: 'idle' }); setRights(false);
    if (side === 'left') setLeft(selection); else setRight(selection);
  }
  function cancel() { requestId.current++; controller.current?.abort(); controller.current = null; setState({ kind: 'cancelled' }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !left.file || !right.file || state.kind === 'running' || controller.current !== null) return;
    const current = ++requestId.current, abort = new AbortController(); controller.current = abort;
    setState({ kind: 'running' });
    try {
      const result = await compareFiles({ left: left.file, right: right.file, leftKind: left.kind, rightKind: right.kind, signal: abort.signal });
      if (current === requestId.current && !abort.signal.aborted) setState({ kind: 'complete', result });
    } catch (error) { if (current === requestId.current && !abort.signal.aborted) setState({ kind: 'error', message: errorMessage(error) }); }
    finally { if (current === requestId.current) controller.current = null; }
  }
  return <CasebookShell chapter="video" dark><main id="main" className="casebook-main video-workspace">
    <div className="video-chapter-intro"><ChapterHeading number="02" label="Supplied video comparison">A trail, <em>frame by frame.</em></ChapterHeading><p>Put two supplied files side by side.<br />Keep each sampled moment beside its counterpart.<span>Local comparison · human inspection</span></p></div>
    <div className="video-availability" role="status" aria-live="polite">
      {availability.kind === 'loading' ? <p>Checking the local comparison server…</p> : availability.kind === 'unavailable' ? <><p><strong>Local comparison unavailable.</strong> {availability.message}</p><p>This chapter needs a single-user server bound to loopback, both local research and media opt-ins, and a trusted FFmpeg/FFprobe installation.</p><button type="button" onClick={() => void checkAvailability()}>Check again</button></> : <><p><span className="video-local-dot" aria-hidden="true" />{availability.value.busy ? 'The local decoder is busy. Wait for the active comparison, then check again.' : 'Local supplied-media comparison enabled. No web search or provider calls.'}</p><p>Up to {formatBytes(availability.value.limits.videoBytes)} and {availability.value.limits.videoDurationMs / 1000} seconds per video; {formatBytes(availability.value.limits.imageBytes)} per still. At most {availability.value.limits.videoSamples} sample points per video.</p>{availability.value.busy ? <button type="button" onClick={() => void checkAvailability()}>Check again</button> : null}</>}
    </div>
    <form onSubmit={submit} className="video-comparison-form">
      <div className="video-input-grid"><FileSlot side="A" selection={left} capabilities={capabilities} onChange={selection => replace('left', selection)} /><svg className="video-pair-arrow" aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4" /></svg><FileSlot side="B" selection={right} capabilities={capabilities} onChange={selection => replace('right', selection)} /></div>
      <div className="video-form-bottom"><div><label className="video-rights"><input type="checkbox" checked={rights} disabled={state.kind === 'running'} onChange={event => setRights(event.target.checked)} /><span>I have the right to supply and compare both files on this local server.</span></label><p className="video-boundary-note">Choose two videos, or one video and a still image. Use trusted media: a native decoder is not a security sandbox. Files are sent only when you choose Compare.</p>{needsVideo ? <p className="video-file-error" role="alert">At least one file must be a video.</p> : null}</div><div className="video-submit-actions"><button type="submit" className="paper-button primary" disabled={!ready || state.kind === 'running'}>{state.kind === 'running' ? 'Comparing sampled frames…' : state.kind === 'complete' ? 'Compare again' : 'Compare sampled frames'}</button>{state.kind === 'running' ? <button type="button" className="video-cancel" onClick={cancel}>Cancel comparison</button> : null}</div></div>
    </form>
    <div className="video-request-status" aria-live="polite" aria-atomic="true">{state.kind === 'running' ? <p role="status">Decoding the supplied files and comparing bounded frame pairs. This can take several minutes. You can cancel without losing the selected files.</p> : state.kind === 'cancelled' ? <p role="status">Comparison cancelled. Your files remain selected. The local decoder may need a moment to clean up before a retry.</p> : state.kind === 'error' ? <p role="alert">{state.message} Your selected files remain available. Retry with the same files or replace them.</p> : state.kind === 'complete' ? <p role="status">Comparison complete. {state.result.report.comparedFramePairs} sampled pairs inspected, {state.result.report.candidates.length} candidate overlaps. Comparison itself does not save a case. Use the save control below to retain this result.</p> : null}</div>
    {state.kind === 'complete' ? <ComparisonResult key={requestId.current} result={state.result} /> : <div className="video-empty-note"><p className="eyebrow">Keep the question open</p><h2>A sampled match is <em>a place to look.</em></h2><p>The comparison checks a few decoded frames. It cannot search for an earlier source, assess a whole video, or establish what an image proves. Results can be explicitly saved to your local casebook after comparison.</p></div>}
  </main></CasebookShell>;
}
