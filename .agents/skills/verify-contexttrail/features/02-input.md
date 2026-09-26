# Image selection and optional claim

Each distinct entry path reaches the same valid selection; errors preserve claim and permit replacement; noisy oversized input fails before a request; successful preprocessing stays under limits.

## Sub-features

- input-browse: real file chooser via label
- input-drop: actual DataTransfer drop
- input-keyboard: visible focus and Enter chooser
- input-paste: pasted image convenience
- input-replace-remove: retained claim, correct preview
- input-validation: empty, unsupported, decode failure and >450KB compression rejection
- input-claim: blank/whitespace trace, supplied claim mode, 500-character limit
- input-preparing: bounded image processing and duplicate-submit prevention

## How to get to it (user POV)

Open /investigate from landing, directly, or Return to upload; select by browse/drop/keyboard/paste.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive upload --entry browse|keyboard|drop|paste|setinputfiles --case valid|unsupported|empty|decode|oversize|replace|remove|claim-limit --run-id <id>. All entries and cases are implemented: browse/keyboard assert a real filechooser event; drop uses a real DataTransfer; paste uses a real ClipboardEvent; setinputfiles is direct input injection (no chooser proof). Generated scratch files cover valid/unsupported/empty/decode/oversize inputs. Observe preview, inline error, preserved claim, 500-character cap and disabled submission — missing states fail the drive.

Observable proof: Each distinct entry path reaches the same valid selection; errors preserve claim and permit replacement; noisy oversized input fails before a request; successful preprocessing stays under limits.

## Gotchas

Browse/drop/keyboard/replace/remove and validation were freshly driven; clipboard paste and every browser codec path remain NOT VERIFIED. Hidden file input focus is not visibly represented. No huge original-file size promise exists.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

