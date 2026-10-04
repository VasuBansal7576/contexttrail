# ContextTrail launch

The revised film runs for 80.27 seconds at 1920 × 1080, 30 fps. It uses local narration and burned captions. The interactive companion has chapter seeking, a transcript, a pause-to-inspect source dialog and deliberate original-source links.

The story follows one recorded real investigation from 4 October 2026: `research-602c8124-42c7-4e40-97a2-9fda6b02cd41`. Fresh computer-use captures show its question, retained merchant-acceptance passage, publication-date uncertainty, open questions, saved casebook row and exact reopening. No new provider search is staged in this film. The excerpt is an article's explanation, not an independently established conclusion about UPI adoption.

Instrument Serif, Geist, cream paper, rust, blue and the illustrated hand come from the current authored interface. The hand's fingertip meets the invitation button at approximately (1200, 758). The quote has a five-second quiet reading hold. The seven scene sources are `compositions/revised1.html` through `revised7.html`; `revision-timing.json` records their starts and durations.

`SCRIPT.md` contains the narration. `audio_meta_revised.json` retains measured voice durations and word timings. Local Kokoro used the existing Python 3.11 environment and `am_michael` voice at 0.94 speed. No HeyGen account or paid music was used. The previous export remains recoverable; its source is in the preceding Git revision.

From this directory:

```sh
npx hyperframes@0.8.123 check --at 4,14,28,41,51,62,77 --at-transitions
npx hyperframes@0.8.123 preview --background --no-open
npx hyperframes@0.8.123 render --fps 30 --quality high --workers 2 --strict --no-best-effort --skill product-launch-video -o renders/contexttrail-launch-final.mp4
```

The player source is `../../.lavish/contexttrail-launch.html`. Run `python3 ../../.lavish/serve-contexttrail.py` and open `http://127.0.0.1:3237/contexttrail-launch.html`. This server supports byte ranges, required for chapter seeking in the tested browser. A plain Python static server played the movie but exposed no seekable range; the revised server was verified through real browser clicks.

Run `python3 ../../.lavish/export-contexttrail.py` after rendering. The export is `renders/contexttrail-launch-interactive.html`, with its film, fonts, screenshots and captions embedded. Saved-case links expect the local ContextTrail app on port 3220 and this user's saved state. They are not seeded into another checkout. Film exports are local, ignored artifacts; source, captures used in the film, narration and companion code are committed.

The final HyperFrames check has zero runtime, layout and contrast errors or warnings. Two timeline-density warnings concern caption lanes with four and five short cues; those cues are intentional. Caption overlaps were repaired and the seam was captured again before rendering. Midpoints and both sides of every cut were visually inspected. The final H.264/AAC export has a 48 kHz audio stream, 80.266667-second duration and no clipped audio peak.

The broader product acceptance remains open. This film does not establish whole-video identity, complete audio research, automatic claim families, specialised review/attribution/shopping workflows or consistent primary-source recovery. Those remain product work rather than launch-film claims.
