import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { preflightAlternative } from '../../src/adapters/alphatab/preflight';
import type { ExportDiagnostic } from '../../src/adapters/alphatab/preflight';
import { PreflightList } from '../../src/renderer/dialogs/ExportDialog';

afterEach(cleanup);

const loss = (feature: string, title: string, impact: ExportDiagnostic['impact']): ExportDiagnostic =>
  ({ feature, title, location: '악보 전체', impact, detail: `${title} 설명 문장.`, alternative: preflightAlternative });

it('groups preflight items by severity, shows Korean titles instead of keys and writes the alternative once', () => {
  render(<PreflightList losses={[loss('audio.sounds', '음색', 'approximate'), loss('layout.stylesheet', '글꼴·배치 설정', 'omitted'),
    loss('rhythm.glyph', '매우 짧은 음표', 'blocked'), loss('gp.container.version', '파일 버전', 'approximate')]} />);

  const items = screen.getAllByRole('listitem');

  expect(items.map(item => item.getAttribute('data-feature'))).toEqual(['rhythm.glyph', 'layout.stylesheet', 'audio.sounds', 'gp.container.version']);
  expect(items.map(item => item.querySelector('p')?.textContent)).toEqual(['출력 불가 · 매우 짧은 음표', '누락 · 글꼴·배치 설정', '근사 · 음색', '근사 · 파일 버전']);
  expect(items.every(item => !item.textContent?.includes(item.getAttribute('data-feature') ?? '\0'))).toBe(true);
  expect(screen.getAllByText(preflightAlternative)).toHaveLength(1);
});
