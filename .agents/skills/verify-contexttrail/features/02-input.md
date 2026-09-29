# Image selection and optional claim

An image can be chosen the way a user actually chooses one, a rejected input
never reaches the API, and the optional claim is capped and announced.

## Sub-features

- input-entry: browse (file chooser), keyboard, drop and paste all deliver the file
- input-validation: unsupported / undecodable / oversized inputs are refused with a message
- input-replace-remove: the selection can be swapped or cleared, and submit state follows
- input-claim: 500-character cap with a live "characters remaining" announcement

## Drive command

```
bin/control-contexttrail drive upload --run-id <id> \
  [--entry browse|keyboard|drop|paste|setinputfiles] \
  [--case valid|unsupported|empty|decode|oversize|replace|remove|claim-limit]
```

Defaults: `--entry browse`, `--case valid`. Both `--entry` and `--case` are
closed vocabularies — any other value exits 2 naming the supported set.

## Assertions (executable contract)

Common to every case:

| ID | What it proves |
| --- | --- |
| `upload.entry-method` (INFO) | how the file was delivered (`chooserSeen`, `dataTransferUsed`, `clipboardEventUsed`, `setInputFilesOnly`) |
| `upload.preview-visible` | `img[alt^="Selected image preview"]` is rendered |
| `upload.preview-matches-file` | the preview alt text names the file actually delivered |
| `boundary.zero-provider-attempts` / `boundary.provider-blocked` / `boundary.mode-controlled` | selecting an input never contacts a provider |
| `console.no-unexpected-errors` | no unexpected console error |

Per case:

| Case | Assertions |
| --- | --- |
| `valid` | `upload.submit-enabled-after-valid` |
| `unsupported` | `upload.unsupported-rejected` (error text), `upload.submit-disabled-after-unsupported` |
| `empty` | `upload.decode-rejected`, `upload.claim-survives-failure` |
| `decode` | `upload.decode-rejected`, `upload.claim-survives-failure` |
| `oversize` | `upload.oversize-rejected` |
| `replace` | preview alt changes to the second file |
| `remove` | `upload.submit-disabled-after-remove`, `upload.claim-survives-remove`, `upload.input-restored-after-remove` |
| `claim-limit` | `upload.claim-cap-500` (typed 600 chars → value length 500), `upload.claim-counter-announced` (`0 characters remaining`) |

Entry points: `browse` (label click → `filechooser`), `keyboard`
(focus `#ct-image-input` → Enter → `filechooser`), `drop` (synthesised
`DragEvent` carrying a `DataTransfer`), `paste` (synthesised `paste` event with
`clipboardData`), `setinputfiles` (`page.setInputFiles` directly).

## Evidence

`01-upload-<entry>-<case>.png`, `upload-<entry>-<case>.aria.txt`,
`drive.json` (`tier: real-ui`, `entry`, `case`), `console.json`.

## Negative controls

| Command | Expected |
| --- | --- |
| `drive upload --run-id <id> --entry telepathy` | exit 2, lists `browse\|keyboard\|drop\|paste\|setinputfiles` |
| `drive upload --run-id <id> --case does-not-exist` | exit 2, lists the eight cases |
| `drive upload --run-id <id> --image <file>` | exit 2, `--image` is only valid with `--live` |
| `drive upload --run-id <id> --claim-text hi` | exit 2, `--claim-text` requires a claim-mode fixture case (upload resolves to none) |
| `drive upload --run-id <id> --live` | exit 2, `--live requires RUN_LIVE_TESTS=1 (provider credit gate)` — the gate is evaluated before any other live handling |
| `RUN_LIVE_TESTS=1 drive upload --run-id <id> --live` | exit 2, `--live requires --image <path>` (upload accepts `--live`, but needs the submitted media) |

Note the gate ordering: `landing` and `accessibility` carry no options at all,
so for them `--live` is rejected as `--live is only valid for
investigation|result|viewer drives`, and only when the credit gate is already
open does that message surface. With the gate closed the credit-gate message
wins on every drive.

## Gotchas

- `drop` and `paste` dispatch synthesised events with a real `DataTransfer`
  carrying the bytes. That exercises the app's drop/paste handlers but is not a
  human drag-and-drop; `drive.json` records the entry so the distinction is
  never lost.
- The 500-character cap is enforced by the app, not by this harness — the
  harness types 600 characters and asserts the value is 500.
- Selection happens entirely client-side; no `/api/investigate` request is
  made from this drive (asserted by the boundary checks).

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
