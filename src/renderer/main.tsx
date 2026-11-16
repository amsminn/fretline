import { setNonce } from 'get-nonce';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { App } from './App';
import { setLanguage } from './i18n/language';
import './styles/index.css';

// Radix portals inject <style> elements at runtime; the per-response nonce from main lets the strict
// style-src policy admit them without 'unsafe-inline'. This must run before the first React commit.
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content');
if (nonce) setNonce(nonce);

const root = document.getElementById('root');
if (!root) throw new TypeError('Missing renderer root');
await window.desktop.bootstrapStatus();
// The language is known before the first commit, so the shell never paints in another language first.
const { displayLanguage } = await window.desktop.preferences.get();
document.documentElement.lang = displayLanguage;
setLanguage(displayLanguage);
for (const path of ['/font/Bravura.woff2', '/soundfont/sonivox.sf2']) {
  const response = await fetch(new URL(path, location.href), { method: 'HEAD' });
  if (!response.ok) throw new TypeError(`Local asset unavailable: ${path} (${response.status})`);
}

const specimenEnabled = import.meta.env.DEV || document.querySelector('meta[name="fretline-qa"]')?.getAttribute('content') === '1';
const Specimen = lazy(async () => ({ default: (await import('./specimen/Specimen')).Specimen }));
const ScoreHarness = lazy(async () => ({ default: (await import('./specimen/ScoreHarness')).ScoreHarness }));

function Router() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHashChange = (): void => setHash(location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  if (specimenEnabled && hash === '#/specimen') {
    return <Suspense fallback={null}><Specimen /></Suspense>;
  }
  if (specimenEnabled && hash === '#/score-harness') {
    return <Suspense fallback={null}><ScoreHarness /></Suspense>;
  }
  return <App />;
}

createRoot(root).render(<Router />);
