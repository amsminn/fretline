import { describe, expect, it } from 'vitest';
import { describeFeature, describeLocation, describeStatus } from '../../src/adapters/alphatab/compatibility';
import type { CompatibilityDiagnostic } from '../../src/adapters/alphatab/compatibility';

describe('compatibility presentation', () => {
  it.each([
    ['Score', '악보 전체'], ['MasterBar 0 (0-based)', '1번째 마디'], ['Track 2 (0-based)', '3번째 트랙'], ['Note 11 (0-based)', '12번째 음표'],
    ['{"measureId":"m1","voice":1,"occupiedQ":{"n":"5","d":"1"}}', '마디 구조 · 성부 1'], ['song.gp5', 'song.gp5'], ['악보 전체', '악보 전체'],
  ])('presents location %s as %s', (location, expected) => { expect(describeLocation(location)).toBe(expected); });
  it('labels known and engine-field features in Korean without exposing bare keys', () => {
    expect(describeFeature('container.private-fields')).toBe('원본의 비공개 정보');
    expect(describeFeature('MIDI.quantization')).toBe('MIDI 양자화');
    expect(describeFeature('Score.tab')).toBe('악보 정보: tab');
    expect(describeFeature('unknown-key')).toBe('원본 정보: unknown-key');
    const statuses: readonly CompatibilityDiagnostic['status'][] = ['mapped', 'unsupported', 'inventory-unknown'];
    expect(statuses.map(describeStatus)).toEqual(['지원', '미지원', '검증 안 됨']);
  });
});
