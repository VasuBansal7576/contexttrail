# Local supplied-media application bridge

The application can compare two supplied images, two videos, or an image and a video,
through `/api/media/compare`. It reuses the frozen `bounded-pixel-alignment-v1`
matcher. Results are candidate sampled-frame overlaps for human inspection.
No request searches the web, contacts a provider, reads a user-supplied path or
spends provider credit. Publication dates, original upload, identity, truth and
source independence remain unassessed.

## Run locally

Use a trusted, patched FFmpeg and FFprobe installation. Run one Node server,
bound to loopback, with both opt-ins:

```sh
CONTEXTTRAIL_RESEARCH_LOCAL=1 CONTEXTTRAIL_MEDIA_LOCAL=1 npm run start -- -H 127.0.0.1
```

Build first with `npm run build`. Research storage alone does not enable the
decoder. Without the opt-ins the route returns `503`. The same Host, URL and
Origin checks protect the research and comparison routes. Foreign origins,
foreign hosts and cross-site browser requests return `403`. Known hosted and
serverless runtime markers also disable comparison. This is single-user local
operation. These checks are not a hosted account or tenant boundary.

FFmpeg is a native decoder, not a security sandbox. This opt-in does not make
arbitrary untrusted media safe. Hosted operation still needs a patched isolated
worker, enforced resource limits and shared admission control. Binding the app
to an external interface, adding a reverse proxy or running multiple workers is
outside this route's supported deployment.

## HTTP contract

`GET /api/media/compare` returns the enabled capability, current busy state,
limits and accepted file extension/type pairs. It never returns another request's
media or result. The response has `Cache-Control: no-store`.

`POST /api/media/compare` accepts multipart FormData with exactly these fields:

- `left` and `right`, one file each
- `leftKind` and `rightKind`, each `image` or `video`
- `rights`, exactly `user_provided`, the caller's attestation for both files

Only supplied bytes reach the decoder. Original names are checked for a bounded
filename and an accepted extension, then discarded. Extension, declared MIME
when present, and signature must agree. A blank MIME or `application/octet-stream`
is allowed because local file pickers may supply either. Native decoding still
validates the actual container and stream.

Accepted formats are `.jpg`/`.jpeg` with `image/jpeg`, `.png` with `image/png`,
`.webp` with `image/webp`, `.mp4` with `video/mp4`, `.mov` with `video/quicktime`,
`.webm` with `video/webm` and `.mkv` with `video/x-matroska`. MP4/MOV inputs must have a bounded self-contained movie/media layout.
Validated legacy MOV layouts without `ftyp` are supported; external data references are rejected. WebM/MKV
must start with EBML. This check does not establish validity. The bounded
extractor subsequently rejects malformed containers and unsupported streams.
Animated PNG/WebP remain rejected.

The success body is `LocalComparisonResponse`, exported by the browser-safe
`src/lib/video/matching/application-contract.ts`:

```ts
{
  schemaVersion: 'contexttrail-local-media-comparison-v1',
  report: FrameMatchReport,
  frames: { left: LocalComparisonFrame[], right: LocalComparisonFrame[] },
  persistence: { status: 'not_saved', reason: string }
}
```

Each returned frame includes its media/frame IDs, SHA-256 hash, MIME, width,
height, base64 bytes and decoded media-relative timestamp. Still timestamps are
null. Frames are the exact inputs compared, not placeholders or claimed web
retrieval. The report preserves all pair comparisons, approximate rectangles,
raw distance values, per-tile errors, candidates and coverage limitations.
These scores are not percentages or probabilities.

Use an AbortController when submitting. Clear an old result when replacing the
inputs, and ignore any response from an earlier request after navigation or
cancellation. Retrying creates a fresh computation from the newly supplied
bytes. There is no job/result store, session cache, operation ID or durable
server history. The same input bytes produce the same result. The browser must
not put file bytes or frame payloads into sessionStorage or localStorage.

Errors return `{error, code}`. Important statuses are `400` for invalid form or
rights, `403` for boundary rejection, `408` for the upload/overall deadline,
`413` for input/decoder/output limits, `415` for unsupported content or signature,
`422` for malformed media, `429` for a busy decoder, `499` for cancellation when
the client is still connected, and `503` for disabled/unavailable decoding.
Messages do not expose local paths or native decoder diagnostics.

## Bounds and cleanup

- One admitted upload/decode/comparison per Node process, with no queue
- At most 32 MiB per video or 8 MiB per still; the streamed multipart body is capped at 64 MiB plus 64 KiB of form overhead
- Upload deadline 30 seconds, total request deadline 330 seconds
- Existing decoder subprocess timeouts, output limits, pixel/duration limits, protocol/format restrictions and 64 MiB single-allocation bound remain unchanged
- At most two minutes and three requested sample points per video, with at most nine sampled-frame pairs
- A separate scheduling adapter calls the byte-for-byte frozen matcher on each frame pair and yields between pairs. One synchronous interval contains one bounded pair comparison; cancellation and deadline handling wait for that pair to finish
- At most 16 MiB serialized output, including temporary frame payloads
- Body parsing is in memory after a bounded stream read. It is not streaming native decoding. A single request can occupy several copies of its bounded inputs
- Video extraction owns private temporary files. Success, decoder failure and cancellation wait for cleanup before releasing the admission slot
- Stills use pipes. No full video, result or frame payload is written to research storage

This bridge does not alter the held-out evaluation: 21 of 33 positive pairs had
candidates, and 1 of 91 negative pairs did. Those are results on that dataset,
not a guarantee for new files. See the [frozen evaluation](local-media-matching-evaluation.md).

## Retaining a comparison

Comparison requests return `not_saved` and never write a case implicitly. The
explicit save control retains the exact report and decoded frame bytes in a
versioned comparison snapshot. Frame hashes are checked on reopen. Original
video files are excluded. Saved snapshots can be inspected without decoding,
searching or reclassifying the inputs.

Local pair records are kept separately from web source evidence. No placeholder
source URL, claim support, provenance date, occurrence identity or conclusion
is manufactured. Approximate crop rectangles remain inspection aids, rather
than validated source evidence anchors. Image pairs also support inspecting an
advertised and received item; pixel overlap alone cannot establish a shopping
mismatch, material, variant or seller conduct.

## Repeatable verification

```sh
VIDEO_REQUIRE_FFMPEG=1 npx --no-install vitest run src/app/api/media/compare/route.test.ts src/lib/video/matching/matching.test.ts src/app/api/research/route.test.ts
npm run typecheck
npm run build
node scripts/verify-media-http.mjs
```

The HTTP script runs the production Next server on an ephemeral loopback port.
Its child environment includes no provider credentials. It creates owned
synthetic PNG, MP4 and WebM fixtures and checks actual decoded responses,
frame/file hashes, still/video and video/video, deterministic retry, request
data isolation, bad input, admission, client disconnect during upload, abort
during native decoding, scratch cleanup and unchanged saved cases. It records
source hashes, assertions and response artifacts under `.verify/media-http-*`.
These tests prove application behavior on synthetic media, not matching accuracy
or a security audit.

Container controls distinguish recognition from native validation: malformed
atom layouts return `415 SIGNATURE_MISMATCH` before decoding; a bounded,
self-contained movie/media layout with no usable video track returns
`422 INVALID_MEDIA` during native validation. Both controls are generated
locally, and their fixture helper and production recognition source hashes are
included in the HTTP verification artifact.

### Frozen matcher compatibility

The bridge keeps `compare.ts` byte-for-byte at its evaluator-pinned SHA-256,
`c755c5c891ee2c79feb99b272772a8e1160783367b942b79f8474f93757b2575`.
Scheduling lives in `schedule.ts`. It calls the original matcher with one pair
at a time, preserves its report envelope, and joins the resulting ordered pairs.
The adapter never changes crop search, thresholds, samples or score computation.
A cancellation cannot interrupt a synchronous pair calculation; it is checked
at each yield and again after the final pair.

Run the normal frozen evaluation without changing its hash check:

```sh
npm run media:evaluate -- new-evaluation-directory
```

For an existing retained evaluation produced by the current preprocessing
contract, verify complete report and byte equality without regenerating media:

```sh
npx --no-install tsc --module commonjs --moduleResolution node --target ES2020 --esModuleInterop --skipLibCheck --strict --outDir .media-match-build scripts/verify-media-scheduling.ts
node .media-match-build/scripts/verify-media-scheduling.js retained-evaluation-directory new-equivalence.json
```

The verifier requires the original supplied-file hashes, all extracted frame
hashes, complete frozen/scheduled report equality and exact serialized report
hashes. The recorded replay covers 17 retained inputs, 43 frames, 16 reports and
124 pairs. Fresh evaluation regeneration retains the same 43 frame hashes and
124 timestamp/score/region/status outputs, with 21 true-positive candidates,
12 misses, 1 false candidate and 90 true negatives. Newly encoded WebM files can
have different container IDs and file hashes. The retained-byte verification
avoids that difference and establishes full report-hash equality. These are
regression checks on the existing observed set, not new held-out evidence.
