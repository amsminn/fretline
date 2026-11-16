Fretline macOS packaging resources

`bun run package:mac` builds the application, gathers the installed production
dependency licenses, and produces the unsigned arm64 application and DMG.
No certificate, notarization account, network service, or third-party notation software installation
is required at runtime. Windows NSIS and Linux AppImage settings are retained;
they have not been executed on those platforms.

`icon.svg` is original Fretline artwork. `icon.icns` is its macOS raster export.
To regenerate on macOS, create a private temporary directory and export TMPDIR,
NODE_COMPILE_CACHE and BUN_RUNTIME_TRANSPILER_CACHE_PATH below it, then:

```sh
mkdir -p "$RUN_TMP/icon.iconset"
qlmanage -t -s 1024 -o "$RUN_TMP" build/icon.svg
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$RUN_TMP/icon.svg.png" \
    --out "$RUN_TMP/icon.iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  sips -z "$double" "$double" "$RUN_TMP/icon.svg.png" \
    --out "$RUN_TMP/icon.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$RUN_TMP/icon.iconset" -o build/icon.icns
```

The builder hook writes `build/notices/` from the actual installed dependency
closure. It fails if any license is absent. The generated index includes package
versions and source repositories; the complete texts ship outside app.asar in
`Contents/Resources/third-party-notices/`, alongside `Contents/Resources/NOTICE`.
Chromium's full third-party notices and Electron's license are included.

Three upstream npm distributions omit their license files. The local complete
copies were retrieved November 10, 2026 from:

- Signalsmith Stretch: https://raw.githubusercontent.com/Signalsmith-Audio/signalsmith-stretch/main/LICENSE.txt
- @nodable/entities: https://raw.githubusercontent.com/nodable/val-parsers/master/LICENSE
- react-remove-scroll-bar: https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE

The soundfont's Apache notice ships with the full Apache 2.0 license. Bravura's
original OFL and each interface font's original OFL ship unmodified.

The complete Apache text is vendored at `build/Apache-2.0.txt` from
https://www.apache.org/licenses/LICENSE-2.0.txt rather than borrowed from a
development dependency. `TinySoundFont-SFZero-LICENSE.txt` is the combined MIT
license from https://raw.githubusercontent.com/schellingb/TinySoundFont/master/LICENSE;
its two copyright holders are also named in alphaTab's retained bundle headers.

Tailwind CSS's preflight and Vite's modulepreload polyfill remain in the built
renderer. Their installed licenses and versions are collected explicitly without
traversing either tool's build-only dependencies. Production dependency license
collection is retained because their code is bundled in the application even
when the unused `node_modules` directory is excluded from the installer.
