# ContextTrail launch film — 5 October 2026

90 seconds · 1920×1080 · 60 fps · nine editorial scenes.

The opening explains lost context, followed by “Hi, I'm Vasu. I built
ContextTrail.” The film then shows image investigation, evidence inspection,
source relationships, a saved finding, an answer's exact source span, a
separate question investigation, real video search moments, saved cases,
version history, and a paused watch. The UI comes from actual production-app
interactions. Camera movement and labels are editorial layers around those
unchanged captures.

Narration is locally generated Kokoro `am_michael`, not Vasu's recorded voice.
Music is an original locally synthesized 96 BPM composition. The music bed
uses the HyperFrames dynamic voice carve. No reference video assets were
copied, and nothing was published externally.

## Files

- `renders/contexttrail-launch-20261005.mp4`: final delivery film.
- `index.html`: editable master composition.
- `compositions/launch-20261005/`: independently seekable scenes and captions.
- `build-launch-20261005.py`: deterministic layout, timing, caption and score builder.
- `audio_request_launch_20261005.json`: full spoken script.
- `audio_meta_launch_20261005.json`: generated voice and aligner timing.
- `captions-launch.srt`, `captions-launch.vtt`: companion subtitles.
- `launch-media.json`: actual case IDs and media provenance.
- `REFERENCES-20261005.md`: Jev and motion reference observations.
- `check-launch-result.json`, `index.motion.json`: verification results and entrance assertions.
The earlier cut and duplicate capture outputs are retained in the release archive outside this repository.

## Rebuild

```sh
/Users/vasu/Desktop/Cook/contexttrail/.video-venv311/bin/python build-launch-20261005.py
node /Users/vasu/.agents/skills/hyperframes-audio/scripts/carve.mjs --comp index.html --bed music-bed --voice narration --strength 0.8
npm run check
npm run render -- --fps 60 --quality delivery --workers 1 --output renders/contexttrail-launch-20261005.mp4
python3 master-launch-audio.py
python3 verify-launch-20261005.py
```

The existing voice WAVs are reused. Rebuilding does not call research providers,
upload media, or change the application. The application captures remain
unchanged and the video's supplied recording is shown outside the saved UI
frame, whose original pixels were not persisted by that investigation.

The image and question investigations are separate. Retained pages are not
presented as independent corroboration. Video identity remains unresolved.
Changes shows a starting snapshot rather than an invented later correction.
Watch shows a paused saved watch, without resuming or requesting a new check.

## Preview

The persistent editor is available at
`http://localhost:3238/#project/contexttrail`.


Final delivery audio is mastered in two passes to −16 LUFS with a −1 dB true-peak ceiling. The encoded video stream is copied unchanged. The original mix is retained in `renders/launch-verification/unmastered-render.mp4`. Final metadata, decoding and audio measurements are in `renders/launch-verification/verification.json`.

Verified final delivery: 90s, 5400 frames, 1920×1080 at 60 fps, stereo AAC at 48 kHz. Full decode completed without errors. Measured loudness -16.22 LUFS; measured true peak -1.82 dBTP. Master composition checks pass with zero runtime, layout, motion or contrast errors. Eight reviewed caption-density/legacy-source warnings are structural and do not affect the delivered film.
