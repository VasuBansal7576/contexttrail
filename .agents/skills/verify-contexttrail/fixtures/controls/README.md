# Retained controls

`astra-c7-controls.json` is Astra's own control manifest, vendored verbatim: for
each control she names it, the fixture it was derived from, the mutation it
applies, and the **sha256 of the exact bytes** she captured on app `ea1b539`
(build `-MDc3G4d5CmmNaf7w0UF2`).

`retained/` holds those bytes. Two rules keep them honest:

1. **Never regenerate them.** They are a real capture, not a fixture this
   repository produces; a regenerated stream with the same name proves nothing.
2. **Never move them into `fixtures/` root.** The contract suite globs
   `fixtures/*.ndjson` and would treat a private control as a maintained case —
   which is how a replay of someone else's stream could quietly become one of
   ours. The CLI resolves a case from `fixtures/` first and `controls/retained/`
   second, so a maintained fixture can never be shadowed by a private stream.

Replaying a listed control verifies the file against the manifest **before the
drive runs**; a single changed byte fails the command with both digests, and the
verified name, mutation and digest are recorded in `drive.json` as
`retainedControl`. Editing these files is therefore always a visible failure, not
a silent change to what the control proves.
