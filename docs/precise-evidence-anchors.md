# Precise retained evidence anchors

This local-only extension binds reviewer-supplied findings to a pixel rectangle in a retained PNG or one cell in a retained structured table. It does not fetch URLs or paths, perform OCR, interpret an image, verify authenticity, or decide whether a source supports a conclusion. Table contents are supplied by the reviewer, not extracted or independently verified.

## Versions and compatibility

CaseRecord stays `contexttrail-case-v1`. Existing image reports, media references, text quotes and millisecond anchors retain their contracts. An image asset in CaseRecord is still a reference, even when the inquiry has a separate retained copy.

Opening a v1 inquiry/research file does not migrate or write it. Existing v1 edits stay v1. The first accepted `material` edit upgrades the inquiry to `contexttrail-inquiry-v2` and its research envelope to `contexttrail-research-v2`. Both parsers accept their respective v1/v2 versions. A v1 envelope containing v2 fields/anchors, mismatched envelope versions, and unknown versions are rejected. Older application versions will reject v2 rather than silently drop the retained data. There is no automatic downgrade.

The v2 inquiry adds `materials: { versions, heads }`. Each immutable version retains its material ID, monotonic revision, evidence ID, evidence digest, capture time, user-provided rights declaration, validated content, and computed digest. Heads select the current version and retain its bound/changed source status, or record an explicit withdrawal reason. Older bytes/table data remain in `versions` for reviewing historical findings, without copying those bytes into every research-history snapshot. Withdrawing material is not permanent erasure.

The existing atomic local save, optimistic revision, idempotent operation ID, writer lock, and interrupted-save checks apply to these edits too. A failed validation or size limit leaves the previous saved document intact.

## Intake and bounds

Only user-provided material may be retained. Send `rights: "user_provided"` only when you have the right to retain the supplied content. Public access to a linked source does not establish those rights.

PNG intake accepts canonical base64 bytes with `mimeType: "image/png"`. Supported pixels are non-interlaced 8-bit RGB or RGBA. JPEG, WebP, SVG, indexed/grayscale PNG and animated PNG are unsupported. Bounds are checked from the actual IHDR bytes before decompression/decoding:

- At most 256 KiB encoded PNG bytes
- At most 2048 pixels on either axis and 1,048,576 total pixels
- At most 1024 chunks, verified checksums, contiguous image data, and a complete end chunk
- An exact-length, bounded decompressed pixel stream and successful PNG decoding

Width and height in the persisted material are derived from that decoding. Caller dimensions, if supplied, must match. Image material requires image evidence and an image asset. A non-null source asset content hash must match the supplied PNG bytes. Coordinates refer to the encoded raster, with no EXIF/display-orientation transform.

Tables contain `columns: string[]` and rectangular `rows: string[][]`. Each column label and cell is retained literally, including empty strings, whitespace, and strings resembling formulas. Nothing is evaluated or normalized. Tables require a CaseRecord reference evidence item, so an existing passage or media item is not silently reinterpreted as a table. Bounds are 64 columns, 1000 rows, 10,000 data cells, 20,000 UTF-16 code units per string and 128 KiB serialized table content. At least one column and data row are required.

The entire material store, including history, is capped at 32 versions and 2 MiB serialized JSON. The HTTP body and complete saved research document retain their existing 5 MiB limits. A long-lived case may hit the document/history limit sooner. No automatic pruning, compaction, permanent erasure, or external blob storage is added.

## HTTP edit sequence

1. Create a case and add image/reference evidence using the existing endpoint.
2. Take that evidence's digest from the review's `anchorSources` list. This digest includes the associated asset metadata. Do not substitute the supplied-citation report's evidence binding, which has a different scope.
3. Submit a material edit with the current research revision and a unique operation ID.
4. Read the computed material digest from the returned v2 workspace, then submit a finding with a precise anchor.

All examples below are the `change` object inside the existing update request.

```json
{
  "kind": "material",
  "value": {
    "kind": "retain",
    "material": {
      "materialId": "image-copy",
      "revision": 1,
      "evidenceId": "image-evidence",
      "evidenceDigest": "<anchorSources evidenceDigest>",
      "capturedAt": "2026-10-01T00:00:00.000Z",
      "rights": "user_provided",
      "content": { "kind": "image", "mimeType": "image/png", "base64": "<canonical base64 PNG bytes>" }
    }
  }
}
```

For a table, use a reference evidence ID and replace the content with:

```json
{
  "kind": "table",
  "columns": ["Period", "Reported count"],
  "rows": [["2025", "12"], ["2026", "18"]]
}
```

Image anchor example, in the existing finding support entry:

```json
{
  "kind": "image_region",
  "materialId": "image-copy",
  "materialDigest": "<computed digest>",
  "x": 2, "y": 3, "width": 4, "height": 5
}
```

Coordinates are integer pixels from the top-left. Width and height must be positive; the rectangle is half-open, so `x + width <= image.width` and `y + height <= image.height`.

Table anchor example:

```json
{
  "kind": "table_cell",
  "materialId": "table-copy",
  "materialDigest": "<computed digest>",
  "row": 1, "column": 1, "value": "18"
}
```

Rows and columns are zero-based. Row zero is the first data row, not the headers. The value must match the retained string exactly. The full retained table, including column labels and neighboring cells, remains available for contextual review.

## Corrections and missing material

Replacing a material ID requires its next revision, the current evidence digest, and the complete replacement content. That creates a new material digest, even when corrected content is later reverted to old bytes. A material ID cannot be reassigned to another evidence ID or material kind. Repeating the exact active material version is a no-op for material history. Repeating the original operation ID/payload is a no-op for the entire saved document.

A source correction invalidates attached support even if the selected pixel rectangle or cell is unchanged. This warning persists if the source is later reverted; a new material revision and finding review are still required. Material replacement also invalidates it. Existing findings preserve their original anchor and saved digest; identical finding resubmission cannot clear the warning. A reviewed finding requires a changed review rationale and an exact anchor in the current material, which must itself be bound to current source evidence.

Withdraw a current material with:

```json
{ "kind": "material", "value": { "kind": "withdraw", "materialId": "image-copy", "reason": "Reviewer withdrew this copy" } }
```

Affected support reports `unavailable` with the reason. Support reports return small `retainedMaterial` and `currentMaterial` references with their IDs, digests and dimensions/table sizes. Resolve each digest in `document.workspace.materials.versions` for the original or replacement bytes/data. The payload is stored and returned once per immutable material version, not copied into every finding. A missing source evidence item also reports `unavailable`. A present but changed material/source or mismatched selection reports `changed`. Either requires review. A reference URL alone can never satisfy an image-region/table-cell anchor.

To restore withdrawn material, supply a new monotonic material revision. Old findings remain stale until explicitly re-reviewed. Selection does not establish entailment, truth, image authenticity, or independent corroboration.
