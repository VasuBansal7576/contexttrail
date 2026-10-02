# Local video preparation (draft)

This module prepares authorized local/upload bytes for image investigation. It does
not enable video uploads on the hosted site. The existing `/api/investigate` route
still accepts images only, with its current consent, provider-usage and policy guards.

## Use

For a local review with no provider calls:

```sh
npx --no-install vite-node scripts/prepare-video.ts -- ./authorized-video.mp4 ./video-review
```

Run after `npm ci`, which supplies the lockfile-pinned `vite-node` development tool.
The output directory must not already exist. It contains JPEG samples and a JSON
manifest with frame timestamps, parent identity and hashes. The command retains
these review files locally at the explicitly selected destination. Delete them when
they are no longer needed. Temporary decoder staging is always removed.


In a trusted Node worker with `ffmpeg` and `ffprobe` installed:

```ts
import { prepareVideo } from '../src/lib/video/ingest';
import { imageInputForFrame } from '../src/lib/video/image-input';

const prepared = await prepareVideo(authorizedUploadBytes, { signal });
for (const frame of prepared.frames) {
  const { input, source } = imageInputForFrame(frame, {
    claim: null, timezone: 'UTC', locale: 'en',
  });
  // Show/review the sample first. If the user authorizes provider transmission,
  // submit input through the existing guarded image investigation entry point.
  // Keep source alongside its result; never merge frame verdicts into video truth.
}
```

Inputs can come from a user-selected local file or a bounded upload parser. The
caller must enforce the upload body limit before materializing the bytes. No URL
or user-provided file path is passed to a subprocess. No download or provider calls
are made here. Bytes and temporary images are not persisted in a case export.

## Bounds and provenance

Automatic video and supplied-file comparison uploads share bounded MOV/MP4 atom
recognition. `ftyp` is optional and need not be the first atom: padding before it,
legacy `mdat`/`moov` ordering, 64-bit atom sizes within the byte cap and terminal
zero-size atoms are recognized. A complete top-level layout needs movie metadata
and media data; truncated, overflowing or inconsistent atom sizes are rejected.
Recognition is not decoding. The restricted decoder still validates streams,
duration, dimensions and frame output before any investigation can run.

The structural scan allows at most 4096 atoms and 12 levels of movie metadata.
It admits only empty self-contained `url ` data references. External URLs, URNs,
file aliases, compressed movie metadata and reference movies are unsupported.
This conservative subset does not accept a file merely from its name or MIME type.
Decoder protocol/format allowlists and resource limits remain unchanged; external
track and absolute alias-path support remain disabled by the decoder's defaults.

- Maximum input: 32 MiB, two minutes, 3840 × 2160 pixel area
- Self-contained MP4/MOV and WebM/Matroska containers only; no playlists
- Three evenly spaced candidate samples, starting at zero; at most three returned frames
- JPEG output fits the existing 500 KiB image boundary and 640-pixel bounding box
- The whole upload and each output JPEG receive SHA-256 content hashes
- Each frame retains parent media ID and its decoded presentation timestamp,
  relative to the first video frame, not a publication date or wall-clock time
- VFR/low-frame-rate timestamps can differ from requested sample points; repeated
  timestamps are deduplicated. Missing/undecodable samples fail explicitly
- Private temporary directory and input file; cleanup after success, cancellation,
  metadata rejection, missing executable, or decoder failure
- Subprocesses have fixed executable names, no shell, one codec thread, bounded
  stdout/stderr, 64 MiB single-allocation ceiling and 15-second timeout each
- Four subprocesses at most per upload; sequential worst-case timeout is 60 seconds

The format/protocol allowlists prevent playlist/network fetching. External MOV data
references remain disabled by FFmpeg's default. These are defense-in-depth bounds,
not a sandbox for native decoder vulnerabilities. Production must use a patched
FFmpeg build inside a separately resource-limited worker with concurrency admission
and filesystem/network isolation. This draft does not expose a server route.

The case foundation can represent the parent as a `video` MediaAsset with duration,
`not_retained` location, user-provided provenance and content hash. A frame timestamp
must remain media-relative when mapping to a timed span. A frame match establishes
only sampled visual overlap. It does not establish full-video identity, audio
identity, original upload, total reach, independent corroboration or claim truth.
The adapter deliberately creates no public-image URL or catalogue selector, so it
cannot inherit a public-source path around image-upload consent checks.

## Alternatives and remaining work

A hosted multipart endpoint was deferred: native decoder capacity, deployment
availability and per-frame provider authorization need a separate bounded worker
integration. A byte-input library owns local decoding and provenance without
changing established image request semantics. Audio, transcription, scene-cut
sampling, social downloading and cross-frame result aggregation are not implemented.

## Verify

```sh
VIDEO_REQUIRE_FFMPEG=1 npx vitest run src/lib/video/ingest.test.ts
npm run typecheck
npm test
```

The integration test generates three-second synthetic MP4 and WebM inputs locally,
runs the actual executables, checks all three frame timestamps/hashes/JPEG sizes,
checks the image adapter and exercises malformed/playlist cleanup. It makes no
provider requests. On a host without FFmpeg, integration tests are skipped unless
`VIDEO_REQUIRE_FFMPEG=1` is set, which explicitly fails missing dependency checks.
