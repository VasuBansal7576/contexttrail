# Local sampled-frame matching

This local-only tool compares two rights-cleared supplied videos or still images. It
returns candidate visual overlaps for inspection and retains the compared frames.
It does not search the web, contact a provider, alter a case, create a finding or
promote an existing image result to a verified identity.

## Run

Install the locked Node dependencies and a trusted FFmpeg/FFprobe build. Then:

```sh
npm run media:match -- --rights-cleared video authorized-a.mp4 video authorized-b.webm new-review-directory
npm run media:match -- --rights-cleared image supplied.png video authorized.mp4 another-new-directory
```

The rights flag is a caller attestation. The tool cannot establish ownership. Input
kinds are explicit, paths stay in the CLI, and the decoder receives bytes. Existing
output directories are refused. The output has private filesystem permissions,
`report.json`, and the actual compared JPEG/PNG/WebP files. These files remain at the
chosen local destination until the operator removes them. Full videos are not copied.

## What the report means

Each frame-pair comparison includes both parent media IDs, SHA-256 hashes of the
supplied files and compared frame bytes, actual decoded presentation timestamps,
normalized compared rectangles, raw distance components and all 16 tile measurements.
A still image has a null timestamp. Video timestamps are relative to the first video
frame and are never publication dates.

Every sampled pair is compared, including off-diagonal pairs. This permits a reused
or reordered sampled frame to be found without assuming that the two sequences are
in the same order. It does not establish segment boundaries or unique correspondence.
A repeated background can produce several candidate timestamp pairs. All pairs,
including misses and uninformative pairs, remain in `comparisons`; `candidates` is a
filtered view of the same records.

`candidate_visual_overlap` means that a fixed heuristic passed, or the retained frame
bytes are identical. It is not a probability, semantic conclusion, authenticity
judgment, copying allegation, original-upload attribution or full-video verdict.
`no_candidate` and `uninformative` do not establish absence of reuse.

## Fixed algorithm, version 1

The tool uses the existing bounded video extractor, with three requested samples at
zero, one-third and two-thirds of duration. It decodes still images to a 96 × 96 RGB
working raster and compares 24 × 24 area-averaged descriptors. The square raster is a
working coordinate system; report rectangles are normalized to the original decoded
image width and height. Orientation metadata is not applied to still images.

For each sampled pair, one full view is compared against axis-aligned crops of the
other. Both directions are tried. Each crop axis retains at least 60% of the image.
Five coarse widths/heights and three offset fractions are followed by four fixed
coordinate-descent step sizes. Both-sided crops, rotations, reflection and perspective
are not searched. The returned rectangle is an approximate alignment, not an exact
object boundary or a CaseRecord evidence anchor.

The descriptor has 16 tiles. A single brightness offset of at most 24 intensity
levels is removed. The 12 tiles with the smallest RGB errors are retained. Candidate
gates are trimmed RGB error ≤ 0.065, full mean RGB error ≤ 0.15, edge error ≤ 0.07,
and at least eight retained informative tiles. An informative tile has luminance
variance ≥ 64 in both inputs. Distances are normalized to the 0–255 intensity range.
Identical encoded frame bytes bypass these heuristic gates, including for blank images.

The omitted quarter of tiles can contain important captions or edits. Their errors
and locations are retained in the report, and the frames must be inspected. This is
an inexpensive candidate generator, not a spatial identity verifier. Do not use it
to enable the existing near-match promotion path.

The settings are deliberately fixed before the held-out run. Tests on generated
geometry do not establish general image/video retrieval accuracy. Detailed evaluation
results and failures belong beside the raw reports, not hidden by a single success rate.

## Coverage and resource limits

- Existing video limits remain 32 MiB, two minutes, 3840 × 2160 pixel area, three samples
- Still images accept JPEG, PNG and WebP, at most 8 MiB, 8,294,400 pixels and 8192 pixels per axis; animated PNG/WebP are rejected
- A still-image decode/probe is two sequential fixed subprocesses, each limited to 15 seconds, bounded output and a 64 MiB single-allocation ceiling
- One video uses up to four extraction subprocesses plus six still-frame decode/probe subprocesses; two videos use at most 20 subprocesses, at most 300 seconds of cumulative subprocess timeout
- At most nine frame-pair comparisons are reached through the two-input CLI
- Private staging cleanup is owned by the existing video extractor; still-image bytes travel through pipes without temporary files
- Actual requested and decoded timestamps, sample count and largest gap are reported; temporal coverage fraction is null because point samples do not establish interval coverage
- No OCR, transcript, narration, audio, remote retrieval or model processing is performed

The native decoder is not a security sandbox. This slice has no HTTP endpoint. Hosted
use still needs a patched isolated decoder worker with resource/concurrency admission.
It does not add new provider authorization or spend any provider allowance.

## Integration boundary

`prepareMatchMedia` accepts a byte input with an explicit `image` or `video` kind and
`user_provided` rights. It returns owned frame bytes, decoded raster pixels and coverage.
`comparePreparedMedia` accepts only those locally prepared records. It is an internal
in-memory function, not a parser for untrusted JSON manifests. Its versioned report is
self-contained and has no CaseRecord or Inquiry schema dependency. CaseRecord v1 and
the retained-material v2 inquiry envelope remain unchanged.

There is no automatic case/anchor import. A later adapter must bind retained bytes,
case revisions and unavailable/stale material handling before creating reviewable
anchors. Matching alone must never create support for a claim.

## Verify

```sh
VIDEO_REQUIRE_FFMPEG=1 npx --no-install vitest run src/lib/video/matching/matching.test.ts
npm run typecheck
VIDEO_REQUIRE_FFMPEG=1 npm test
```

The real decoder tests cover crops, subtitles, unrelated inputs, blank images,
MP4/WebM reordering, image-to-video comparison, hashes, timestamps, cancellation and
missing executables. These are development fixtures, not held-out accuracy evidence.
