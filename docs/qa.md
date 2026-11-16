# Fretline QA

Build before any test or QA that launches Electron:

```sh
bun run build
bun run qa:electron -- --case design-specimen --evidence qa-evidence/design/my-run/specimen
```

Electron cases drive the built app through Playwright. `FRETLINE_QA=1` is set by
the runner, with isolated QA application data. Windows are hidden by default
(`FRETLINE_QA_HEADLESS=1`). `FRETLINE_QA_HEADLESS=0` is the visible-window override;
regular QA runs do not use it.
Run domain cases with `bun run qa:domain -- --case <case> --evidence <directory>`.

Each scenario directory contains `result.json` (assertions, exit code, runtime
versions, fixture hashes, plan hash and child cleanup receipts), `actions.log`,
and the case's screenshots or output/audio artifacts. Keep each verification
run in its own evidence root (`qa-evidence/` is ignored by git).

Two optional environment variables add checks that need private files:
`FRETLINE_QA_PLAN=<file>` records the hash of a requirements plan in every result
(otherwise `none`) and is the default for `qa:audit --plan`, and
`FRETLINE_QA_REFERENCES=<directory>` points the layout comparison cases at
reference screenshots (`gp8-main-screen-reference.webp`,
`gp8-toolbar-reference.webp`) for side-by-side captures; without it those
captures are skipped.

```sh
bun run qa:audit -- --help
bun run qa:audit -- --evidence qa-evidence/design/my-run
bun run qa:audit -- --evidence qa-evidence/ --since-fixtures
```

The audit recursively checks exactly the supplied root, including nested
scenarios. The default audit is strict: changed fixture hashes fail.
`--since-fixtures` lists otherwise valid historical manifests with different
fixture hashes as `STALE`, which is non-fatal and is never a PASS. Other evidence
errors remain fatal. Use the strict default for the current wave.
`--exclude <relative-glob>` explicitly prunes historical paths;
`--allow-inconclusive-load` accepts valid `INCONCLUSIVE-LOAD` evidence as
non-fatal without claiming measured performance.

`qa:native` drives the app with real macOS input (accessibility focus and keys,
pointer events, `screencapture`) and needs the Accessibility and Screen Recording
permissions. Without them a case ends as `BLOCKED_PERMISSION`, never as a pass.
Regular runs use `qa:electron`; the native runner is for an OS-level journey on the
packaged `dist/mac-arm64/Fretline.app`, which Electron screenshots do not replace.
