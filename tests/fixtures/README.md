# Fixture contract

These are test inputs, not persisted alphaTab JSON or a second application domain
model. `domain/*.json` uses fixture schema 1. Adapter and domain tests translate
these authored recipes into their public production input; QA must open files or
dispatch normal UI commands, never inject a document through a QA write bridge.

UUIDs identify objects. `m2b2` labels identify musical positions for assertions.
Durations and spans are exact quarter-note rationals. The seven-four recipe has
seven quarter notes in the time of four (written 7:4); pickup-6-8 starts with two
eighth notes, then a complete six-eighth bar. Performance bars with no attacks
are silent; adapters fill the remainder with rests. The generator is deterministic
and has exactly 16 tracks, 256 global bars and 10000 attacks.

Expected JSON is an authored oracle. It is not regenerated from parser output.
GP expectations cite upstream test assertions or direct GPIF inspection.
They deliberately assert a supported subset, not lossless import fidelity.

`generate.ts` recreates self-authored binary/data fixtures and updates byte hashes.
It does not rewrite expected files. Upstream GP source files are vendored verbatim,
with immutable source revision, path, license and SHA-256 in `manifest.json`.

QA exit codes: 0 PASS, 1 assertion FAIL, 2 infrastructure FAIL,
3 BLOCKED_PERMISSION, 4 UNKNOWN_CASE, 5 APP_CRASH. A negative scenario passes
only when its subprocess fails with the expected code and is reaped.
