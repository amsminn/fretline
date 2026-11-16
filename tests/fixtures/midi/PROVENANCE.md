# MIDI fixtures

`study-smf0.hex` and `study-smf1.hex` are CC0-1.0 self-authored SMF inputs.
They encode the same two-note phrase with 480 PPQ, 120 BPM, program 24,
CC7 value 100, E4 followed by G4, each lasting one quarter note.
Whitespace is removed and hexadecimal pairs are decoded to bytes before use.
The hex source, rather than regenerated output, is pinned in the manifest.
`study.expected.json` is the authored semantic oracle.

`independent.ts` is an independent SMF inspector used only by tests and QA.
It does not import the production MIDI reader, writer or quantizer.
