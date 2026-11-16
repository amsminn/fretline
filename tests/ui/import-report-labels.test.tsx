import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CompatibilityReport } from '../../src/adapters/alphatab/compatibility';
import { ImportReport } from '../../src/renderer/dialogs/ImportReport';
import { TooltipProvider } from '../../src/renderer/ui';

afterEach(cleanup);

const report: CompatibilityReport = { inventoryVersion: 1, engineVersion: '1.9.0', format: 'gp5', sourceHash: 'ab'.repeat(32), diagnostics: [
  { feature: 'container.private-fields', location: 'song.gp5', status: 'inventory-unknown', impact: '확인하지 못했습니다.', alternative: '원본 바이트를 유지하세요.' },
  { feature: 'Score.tab', location: 'Score', status: 'unsupported', impact: '매핑되지 않습니다.', alternative: '별도로 작성하세요.' },
  { feature: 'Beat.ottava', location: 'MasterBar 2 (0-based)', status: 'unsupported', impact: '매핑되지 않습니다.', alternative: '별도로 작성하세요.' },
  { feature: 'measures', location: 'song.gp5', status: 'mapped', impact: '8개 항목을 편집 문서로 매핑했습니다.', alternative: '저장하세요.' },
] };

it('shows Korean feature, location and status words and keeps machine keys only as data attributes', () => {
  render(<TooltipProvider><ImportReport report={report} name="song.gp5" onCancel={() => undefined} /></TooltipProvider>);

  const rows = screen.getAllByRole('row').slice(1);

  expect(rows.map(row => [row.getAttribute('data-feature'), row.getAttribute('data-status')])).toEqual([
    ['container.private-fields', 'inventory-unknown'], ['Score.tab', 'unsupported'], ['Beat.ottava', 'unsupported'], ['measures', 'mapped']]);
  expect(rows.map(row => row.querySelector('td')?.textContent)).toEqual(['원본의 비공개 정보song.gp5', '악보 정보: tab악보 전체', '박 정보: ottava3번째 마디', '마디song.gp5']);
  expect(rows.map(row => row.querySelector('td + td span')?.textContent)).toEqual(['검증 안 됨', '미지원', '미지원', '지원']);
  const table = screen.getByRole('table').textContent ?? '';
  for (const raw of ['inventory-unknown', 'unsupported', 'mapped', 'Score.tab', '0-based']) expect(table).not.toContain(raw);
});
