import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetBody, isApplicationUrl, qaMetaTag, resolveAssetPath } from '../../src/main/protocol';

describe('offline asset boundary', () => {
  let temporary: string;
  let root: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'fretline-protocol-'));
    root = join(temporary, 'renderer');
    await mkdir(root);
    await mkdir(join(root, 'directory'));
    await writeFile(join(root, 'index.html'), '<main>Fretline</main>');
    await writeFile(join(root, 'score font.woff2'), 'local asset');
    await writeFile(join(temporary, 'secret.txt'), 'private');
    await symlink(join(temporary, 'secret.txt'), join(root, 'escape.txt'));
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it.each([
    ['app://fretline/', 'index.html'],
    ['app://fretline/score%20font.woff2', 'score font.woff2'],
    ['app://fretline/index.html?cache=1#section', 'index.html'],
  ])('serves an existing local asset at %s', async (url, filename) => {
    expect(await resolveAssetPath(root, url)).toBe(await realpath(join(root, filename)));
  });

  it.each([
    'https://fretline/index.html',
    'file:///index.html',
    'app://attacker/index.html',
    'app://user@fretline/index.html',
    'app://fretline:42/index.html',
    'app://fretline/%2e%2e%2fsecret.txt',
    'app://fretline/escape.txt',
    'app://fretline/%00',
    'app://fretline/%',
    'app://fretline/..%5csecret.txt',
    'app://fretline/missing.js',
    'app://fretline/directory',
  ])('refuses access outside existing local assets for %s', async url => {
    expect(await resolveAssetPath(root, url)).toBeUndefined();
  });

  it.each(['not a URL', 'https://fretline/', 'app://fretline.evil/', 'app://user:pass@fretline/'])(
    'rejects an untrusted application origin %s', url => {
      expect(isApplicationUrl(url)).toBe(false);
    },
  );
});

describe('runtime QA marker', () => {
  const html = new TextEncoder().encode('<!doctype html><html><head><title>Fretline</title></head><body></body></html>');
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  it('injects the fretline-qa meta into the document head only under FRETLINE_QA=1', () => {
    const marked = decode(assetBody('/out/renderer/index.html', html, { FRETLINE_QA: '1' }));
    expect(marked.indexOf(qaMetaTag)).toBeGreaterThan(marked.indexOf('<head>'));
    expect(marked.indexOf(qaMetaTag)).toBeLessThan(marked.indexOf('</head>'));
    expect(marked.match(/fretline-qa/g)).toHaveLength(1);
  });
  it.each([{}, { FRETLINE_QA: '0' }, { FRETLINE_QA: 'true' }])('leaves the document untouched for env %o', environment => {
    expect(assetBody('/out/renderer/index.html', html, environment)).toBe(html);
  });
  it('never rewrites non-HTML assets', () => {
    const script = new TextEncoder().encode('</head>');
    expect(assetBody('/out/renderer/assets/main.js', script, { FRETLINE_QA: '1' })).toBe(script);
  });
});
