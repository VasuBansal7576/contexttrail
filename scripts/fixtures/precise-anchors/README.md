# Synthetic anchor fixtures

`generate.mjs` independently generates all pixels and table values in `synthetic.json`. No external image, source document, private material, or provider output is used. These fixtures are rights-cleared project test inputs, not factual evidence.

Run `node scripts/fixtures/precise-anchors/generate.mjs` to regenerate byte-for-byte. The two 8×6 PNGs differ in pixel content while retaining the same dimensions. The table includes an empty string and a formula-like literal to prove exact-string handling without evaluation.
