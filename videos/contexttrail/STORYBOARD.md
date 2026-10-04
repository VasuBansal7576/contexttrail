---
workflow: product-launch-video
flow: automation
music: none
canvas: 1920x1080
status: rendered
---

# ContextTrail / bring your question

## Video direction

The name and purpose are visible immediately. One metro question supplies the example. Actual browser captures remain unmodified in their frame. Brief cuts advance between decisions; evidence and dates hold while narration explains them. No unrelated footage or success state. Captions use locally timed narration. The interactive companion supplies reading time beyond the film.

| Scene | Start | Duration | Shot and narration |
| --- | --- | --- | --- |
| 01 What ContextTrail does | 0 | 4.873 | Authored typography and paper. Name/purpose immediately; paper enters at 0.5 seconds. Line 1 starts at 0.1. |
| 02 Bring the question | 4.873 | 8.779 | Actual `input.png` with metro question. Cut to actual `search.png` at 9.34 seconds as line 3 begins. Search waits explicitly shortened. |
| 03 Read source and dates | 13.652 | 7.321 | Actual `evidence.png`, then `inspector.png` at 15.452. Lines 4/5 ask which date the number describes. Highlight the real publication/retrieval labels at 17.585; annotation enters at 17.885. |
| 04 Return to evidence | 20.973 | 4.504 | Actual one-case casebook, then exact reopened paper at 22.573. Line 6 starts 21.073. No new provider requests during reopening. |
| 05 Your next question | 25.477 | 3.691 | Name and invitation. Action enters at 25.827; engraved hand at 25.927. Hand rotates −28 degrees and points horizontally into the action at y≈768. Line 7 starts 25.577. |

## Truth and validation

The question's January scope remains unresolved in this recorded run. The Asianet source describes network figures by 2025, has an observed 15 March 2026 publication date and a 4 October 2026 retrieval timestamp. The film demonstrates source inspection and retention. It does not present later figures as a January answer.

HyperFrames 0.8.123 checks have no lint/runtime/layout errors. Reviewed structural warnings concern the monolithic five-scene timeline and archived caption composition. A transient entrance contrast warning clears on the held date note. Midpoints and both sides of every cut were inspected. Final MP4 is 1920×1080, 30fps, H.264/AAC, 29.2 seconds. Audio stream peak is −2.5 dBFS; no listening assessment is claimed.

Assets are staged by `build-fresh-film.py`; voice clips and word timings are in `audio_meta_fresh.json`. Rebuild the responsive and portable companion with `build-interactive-player.py` after rendering and extracting its poster.
