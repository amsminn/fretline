import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const applicationUrl = 'app://fretline/';
/** Fresh per response; the HTML document and its CSP header must receive the same value. */
export const documentNonce = (): string => randomBytes(16).toString('base64');
export const nonceMetaTag = (nonce: string): string => `<meta name="csp-nonce" content="${nonce}" />`;
// Radix portals (react-remove-scroll / react-style-singleton) inject <style> elements at runtime;
// they read the nonce through get-nonce, so style-src can stay free of 'unsafe-inline'.
export const contentSecurityPolicy = (nonce: string): string => [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  `style-src 'self' 'nonce-${nonce}'`,
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const qaMetaTag = '<meta name="fretline-qa" content="1" />';

/**
 * Marks the served document as a QA session when the main process runs with
 * FRETLINE_QA=1, so the renderer can enable QA-only routes (#/specimen) at
 * runtime from the normal build instead of a separate VITE_FRETLINE_QA build.
 */
export function assetBody(asset: string, bytes: Uint8Array<ArrayBuffer>, environment: Readonly<Record<string, string | undefined>>): Uint8Array<ArrayBuffer> {
  if (environment['FRETLINE_QA'] !== '1' || !asset.endsWith('.html')) return bytes;
  const html = new TextDecoder().decode(bytes);
  const head = html.indexOf('</head>');
  if (head < 0) return bytes;
  return new TextEncoder().encode(`${html.slice(0, head)}    ${qaMetaTag}\n  ${html.slice(head)}`);
}

/** Exposes the response nonce to the renderer; non-HTML assets pass through untouched. */
export function nonceBody(asset: string, bytes: Uint8Array<ArrayBuffer>, nonce: string): Uint8Array<ArrayBuffer> {
  if (!asset.endsWith('.html') || !/^[A-Za-z0-9+/=]+$/.test(nonce)) return bytes;
  const html = new TextDecoder().decode(bytes);
  const head = html.indexOf('</head>');
  if (head < 0) return bytes;
  return new TextEncoder().encode(`${html.slice(0, head)}    ${nonceMetaTag(nonce)}\n  ${html.slice(head)}`);
}

export function isApplicationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'fretline' &&
      url.port === '' && url.username === '' && url.password === '';
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export async function resolveAssetPath(root: string, value: string): Promise<string | undefined> {
  if (!isApplicationUrl(value)) return undefined;
  const url = new URL(value);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined;
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  const inside = (file: string): boolean => {
    const path = relative(canonicalRoot, file);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  if (!inside(candidate)) return undefined;
  try {
    const canonical = await realpath(candidate);
    return inside(canonical) && (await stat(canonical)).isFile() ? canonical : undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}
