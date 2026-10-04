# ContextTrail launch

A 77-second narrated film and chapter player, built from actual ContextTrail runs on 4 October 2026. The paper, ink, rust and blue colors match the casebook interface. Instrument Serif, Geist Sans and the pointing-hand illustration come from the product.

The UPI passage, reopened video report and paused watch are real product captures. The Delhi clip caption is an assertion to investigate. Neither the film nor the product claims that a retrieved Jasola report establishes this clip’s identity. The separate correction-history control is synthetic and is excluded from the film.

The composition has seven independent scenes, local Kokoro narration, media owned by HyperFrames, and explicit chapter timings. Voice generation used Python 3.11 and kokoro-onnx 0.4.7. No HeyGen account or paid music was used. `audio_meta.json` retains word timings; `SCRIPT.md` retains the spoken copy.

From this directory:

```sh
npx hyperframes@0.8.119 check
npx hyperframes@0.8.119 snapshot --at 4,12,24,38,50,61,73
npx hyperframes@0.8.119 render --fps 30 --quality delivery --workers 2 --skill product-launch-video -o renders/contexttrail-launch.mp4
```

The interactive companion is `../../.lavish/contexttrail-launch.html`. Its player supports chapter seeking, captions, a transcript and two inspectable real-run examples. The local app links expect ContextTrail on `127.0.0.1:3220`. Saved cases are private local state and are not seeded into another user’s checkout.

Renders and local synthesis environments are ignored. To refresh the player, copy the rendered MP4 into `.lavish/contexttrail-assets/contexttrail-launch.mp4`. Use Lavish export to create a portable review copy. Public hosting, submission and redistribution decisions remain separate from this local artifact.

The owner-supplied local clip `assets/delhi-caption-input.mp4` is intentionally excluded from Git. A fresh checkout needs that supplied clip, or a reviewed replacement of scene 4, to render. This preserves the distinction between creating a local launch artifact and publicly redistributing its source footage.
