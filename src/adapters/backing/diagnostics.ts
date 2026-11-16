import type { AssetBytes, ProjectV1 } from '../../domain/project';
import { parseWave, WaveError } from './wave';
import type { WaveLayout } from './wave';

export type BackingAssetState =
  | { readonly kind: 'none' }
  | { readonly kind: 'ready'; readonly bytes: Uint8Array; readonly layout: WaveLayout; readonly durationSeconds: number }
  | { readonly kind: 'missing-manifest'; readonly message: string }
  | { readonly kind: 'missing-bytes'; readonly message: string }
  | { readonly kind: 'corrupt'; readonly message: string };

export function inspectBackingAsset(project: ProjectV1, blobs: readonly AssetBytes[]): BackingAssetState {
  const backing = project.score.backing;
  if (!backing) return { kind: 'none' };
  const asset = project.assets.find(asset => asset.id === backing.assetId);
  if (!asset) return { kind: 'missing-manifest', message: '반주 자산이 프로젝트 목록에 없습니다. 악보는 그대로 유지됩니다.' };
  const blob = blobs.find(blob => blob.sha256 === asset.sha256);
  if (!blob) return { kind: 'missing-bytes', message: `반주 오디오 바이트(${asset.sha256.slice(0, 12)}…)를 찾을 수 없습니다.` };
  if (blob.bytes.byteLength !== asset.byteLength) return { kind: 'corrupt', message: `반주 자산 길이가 다릅니다 (${blob.bytes.byteLength} ≠ ${asset.byteLength}).` };
  try {
    const layout = parseWave(blob.bytes);
    return { kind: 'ready', bytes: blob.bytes, layout, durationSeconds: layout.frames / layout.sampleRate };
  } catch (error) {
    if (error instanceof WaveError) return { kind: 'corrupt', message: `반주 오디오가 손상되었습니다: ${error.message}` };
    throw error;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
