# Sampled-frame matching evaluation, version 1

This is an author-run synthetic held-out check, not independent validation or a
representative real-world accuracy estimate. Every pixel was generated locally by
`scripts/evaluate-media-matching.ts`. No borrowed footage, OCR, transcript, model,
provider or network source was used.

The comparison algorithm and its thresholds were committed at
`7093c027197f967acea6a43e612bd11fb2a2220f` before the evaluation set was written. The
case specification was committed at `51275477dc426eafb78252a57504655d8b07e4e0` before
its first execution. No matching settings changed after those outcomes were seen.
The evaluation script checks the comparison module against the frozen commit and
records SHA-256 hashes for the current decoder, adapter and output model separately.

## Observed results

Across 16 specified cases and 124 sampled-frame pairs:

- 21 of 33 corresponding generated-scene pairs produced candidates
- 12 corresponding pairs were missed
- 1 of 91 non-corresponding pairs produced a candidate
- 90 non-corresponding pairs produced no candidate

These are exact counts for this fixture set. Pair observations from the same source
are correlated. They must not be advertised as calibrated confidence or general
precision/recall. The set deliberately contains unsupported transformations and
sampling failures; those results are retained.

| Case | Corresponding pairs found | Missed pairs | False candidates |
| --- | ---: | ---: | ---: |
| Original bytes / sampled frames | 3 | 0 | 0 |
| MP4 to WebM | 3 | 0 | 0 |
| Unseen asymmetric crop | 3 | 0 | 0 |
| Subtitle-like overlay | 3 | 0 | 0 |
| Combined crop and subtitles | 0 | 3 | 0 |
| Reordered samples | 3 | 0 | 0 |
| One reused segment | 1 | 0 | 0 |
| Unrelated sequence | 0 | 0 | 0 |
| Brightness shift | 3 | 0 | 0 |
| Resized lossy still to video | 1 | 0 | 0 |
| Still to cropped video | 1 | 0 | 0 |
| Mirrored sequence | 0 | 3 | 0 |
| 12-degree rotation | 0 | 3 | 0 |
| Severe crop, 35% × 40% retained | 0 | 3 | 0 |
| Brief reuse between samples | 0 | 0 sampled positives | 0 |
| Generic shared-pattern negative | 0 | 0 | 1 |

The combined crop/subtitle miss is within the intended transformation family and is
an unresolved performance gap. The mirror, rotation and severe-crop misses are outside
the implemented search family, but remain false negatives against known derivation.

The brief-reuse sequence contains a source scene from 400 to 600 ms. The extractor
samples 0, 1000 and 2000 ms, so no corresponding pair reaches the matcher. This is a
whole-video coverage miss even though its nine sampled negative pairs were correctly
rejected. Sampling coverage cannot be inferred from a passed matching test.

Two independently generated subjects on the same generic repeating background caused
the false scene correspondence. The report's candidate should not be upgraded to
media identity or reused-scene evidence without inspection. The shared visual pattern
is real; the generated subjects are different.

## Inspect or repeat

```sh
npm run media:evaluate -- new-evaluation-directory
```

The directory contains:

- `manifest.json`: pre-execution case descriptions, generated scene labels, media hashes, algorithm/decoder hashes and fixed parameters
- `evaluation.json`: every expected and observed pair, exact timestamps, all counts and every failed positive, false candidate and coverage miss
- `reports/*.json`: complete raw comparisons, regions, tile errors and hashes
- `media/`: generated source frames and encoded videos/images
- `frames/`: the actual extracted/compared images

The exact first-run artifact lives outside the repository as a separately delivered
local evaluation folder/archive. Re-running the script is reproducibility work. Once
these cases have been observed, they are no longer fresh held-out evidence for a later
algorithm. A changed matcher requires fresh cases and a new version.

## Post-run decoder correction

Review found that the initial RGB decode discarded alpha. The final decoder composites
alpha-bearing inputs onto black before resizing and states that treatment in the report.
A focused real-decoder regression covers transparent PNG, half-transparent pixels and
lossless transparent WebP. This corrects hidden-pixel handling; it does not tune matching.

All 43 decoded image rasters used in the original evaluation were hashed before and
after the correction. Every complete RGB raster was byte-identical. The retained
`opaque-raster-hashes-before-alpha-fix.json` and `alpha-fix-equivalence.json` record
that comparison, so the original measured distances and outcomes still apply to the
final decoder for those fixtures. Transparent real-world accuracy has not been measured.

## Readiness

The slice is useful for local candidate review on sampled supplied material. It is
not ready to enable automatic identity promotion, full-video conclusions or hosted
untrusted-media processing. More diverse rights-cleared footage, independent evaluation,
scene-aware sampling and a stronger spatial verifier remain separate work. Audio,
transcription, OCR and semantic claim assessment remain unimplemented.
