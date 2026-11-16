# MusicXML fixtures

`voices-ties.musicxml` and its authored expected semantics are CC0-1.0,
self-authored for task 26. They exercise a chord, a tie, 3:2 eighth-note
tuplets, two voices, rests, two tempos, repeats, lyrics, tuning and technical
string/fret data.

The schema files come from the W3C MusicXML repository tag `v4.0`:
https://github.com/w3c/musicxml/tree/v4.0/schema
`musicxml.xsd` and `xlink.xsd` retain their W3C Community Final Specification
Agreement notices. `xml.xsd` retains its W3C XML namespace notice. Line endings
are normalized to LF; file contents otherwise remain unchanged.
`schema/catalog.xml` is a local, self-authored catalog that maps the schema's
two external imports to these pinned files. Validation runs with `--nonet`.
The manifest records SHA-256 values for these pinned copies.

The decoder in `inspect.ts` uses libxml2 XSD validation and happy-dom, rather
than the production MusicXML reader or its ordered-tree parser.
