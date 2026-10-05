# ContextTrail launch film

The current replacement is 29.2 seconds at 1920 × 1080, 30 fps. It introduces ContextTrail before showing a fresh metro question. The five-chapter companion supports seeking, paused source inspection, spoken-line navigation and a working question-entry link. Older UPI films are superseded.

## Rebuild

Run from this directory. Voice clips and word timings are already retained locally and committed.

```sh
python3 build-fresh-film.py
npx hyperframes@0.8.123 check --snapshots
npx hyperframes@0.8.123 snapshot --at 1.6,8.1,18.3,23.8,28.3
npx hyperframes@0.8.123 render --output renders/contexttrail-launch-fresh.mp4 --quality delivery --workers 2
ffmpeg -hide_banner -loglevel error -ss 1.6 -i renders/contexttrail-launch-fresh.mp4 -frames:v 1 -y renders/contexttrail-launch-fresh-poster.jpg
python3 build-interactive-player.py
python3 ../../.lavish/serve-contexttrail.py
```

Open `http://127.0.0.1:3237/contexttrail-launch.html`. The byte-range server permits seeking. `renders/contexttrail-launch-interactive.html` embeds the film, poster and fonts; the same server exposes it at `/contexttrail-launch-interactive.html`. The compatibility builders in `.lavish` delegate to the current builder rather than restoring an older film. Exports are ignored local artifacts; reproducible source, actual captures and narration are committed.

App links use loopback port 3221 and the newly saved case `research-a78d486d-c3d4-47a5-adc0-9aa55b868d6c`. The judge preview seeds nothing. Another checkout will not contain this private local case. Its search allowance is exhausted; a new provider run needs an authorized bounded grant. The recording uses cuts between actual computer-use states and explicitly shortens search waits.

## What the run proves

It retained twelve records, including five read pages and seven leads, and accurately reopened its exact evidence. It missed the January 2025 primary source. Search fixes made afterward still await live verification. The film demonstrates investigation and inspection; it does not claim that this question or the wider product vision is completed. The companion states the January gap and preserves the source's real publication and retrieval dates.

Runtime/layout checks pass. Structural warnings concern the monolithic scene/caption timeline and archived caption composition; a transient contrast warning occurs while the date note fades in. All scene midpoints and cut boundaries were inspected. Full browser playback reached 29.2 seconds without error; all five seeks, source pause, narration jump, sound, phone reflow and the final hotspot worked. Portable embedded seeking and source pause were separately verified. Audio peak is −2.5 dBFS; no listening assessment is claimed. Original-file rendered parity remains unverified because browser policy blocks the reference file URL.
