import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { decodeBacking, BackingImportError } from '../../src/adapters/backing/decode';
import { inspectBackingAsset } from '../../src/adapters/backing/diagnostics';
import { extractEmbeddedBacking } from '../../src/adapters/backing/gp-audio';
import { buildPeakPyramid, peakColumns } from '../../src/adapters/backing/peaks';
import { encodeWave, parseWave } from '../../src/adapters/backing/wave';
import { contentToken } from '../../src/domain/commands/core';
import { applyBackingCommand, measureMediaSeconds, syncPointConflict } from '../../src/domain/commands/sync-points';
import type { BackingEdit, SyncPoint } from '../../src/domain/commands/sync-points';
import type { Asset, ScoreDocument } from '../../src/domain/document';
import type { ProjectV1 } from '../../src/domain/project';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { Practice } from '../../src/renderer/audio/practice';
import { buildPlayback, LoopClock } from '../../src/renderer/audio/transport';
import { BackingStore } from '../../src/renderer/backing/store';
import { backingGrid } from '../../src/renderer/backing/timeline';
import { emptySelection } from '../../src/renderer/state/document-edits';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

const tone = (seconds: number, sampleRate = 48_000): Uint8Array => {
  const frames = Math.round(seconds * sampleRate);
  const left = new Float32Array(frames); const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { left[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sampleRate); right[i] = i < frames / 2 ? 0.9 : 0.1; }
  return encodeWave([left, right], sampleRate);
};
const asset = (bytes: Uint8Array, label = 'tone'): Asset => ({ id: fixtureId('asset', label), sha256: fixtureId('sha', label).replaceAll('-', '').padEnd(64, 'a'), mediaType: 'audio/wav', byteLength: bytes.byteLength });
const apply = (doc: ScoreDocument, edit: BackingEdit) => applyBackingCommand(doc, { expectedToken: contentToken(doc), edit }, emptySelection);
const applied = (doc: ScoreDocument, edit: BackingEdit): ScoreDocument => {
  const result = apply(doc, edit);
  if (result.kind !== 'applied') throw new Error(result.diagnostics.map(d => d.message).join());
  return result.nextDoc;
};
const measure = (doc: ScoreDocument, index: number) => {
  const found = doc.measures[index];
  if (!found) throw new RangeError(`Missing measure ${index}`);
  return found;
};
const point = (doc: ScoreDocument, index: number, mediaSeconds: number, offsetQ = zeroQ): SyncPoint => ({ measureId: measure(doc, index).id, pass: 1, offsetQ, mediaSeconds });

describe('backing map', () => {
  const base = fixtureDocument('loop-eight-bars');
  const wav = tone(20);
  const attached = applied(base, { kind: 'attachBacking', asset: asset(wav) });

  it('attaches one asset, maps anchors onto the playback tempo map and detaches it again', () => {
    expect(attached.assets).toHaveLength(1);
    expect(attached.backing).toEqual({ assetId: asset(wav).id, offsetSeconds: 0, syncPoints: [] });
    const synced = applied(applied(attached, { kind: 'addSyncPoint', point: point(attached, 0, 2) }), { kind: 'addSyncPoint', point: point(attached, 2, 10) });
    const build = buildPlayback(synced);
    const clock = new LoopClock(build, 1);
    expect(build.mediaOffset).toBe(2);
    expect(clock.seconds(8 * 960) + build.mediaOffset).toBeCloseTo(10, 6);
    const grid = backingGrid(synced);
    expect(grid.measures.map(entry => entry.mediaStart.toFixed(3))).toEqual(['2.000', '6.000', '10.000', '12.000', '14.000', '16.000', '18.000', '20.000']);
    expect(grid.measures[0]?.beats.map(beat => beat.toFixed(2))).toEqual(['3.00', '4.00', '5.00']);
    expect(grid.mediaOf(measure(synced, 1).id, rationalQ(2n))).toBeCloseTo(8, 6);
    expect(grid.positionAt(rationalQ(9n))).toEqual({ measureId: measure(synced, 2).id, offsetQ: rationalQ(1n) });
    const detached = applied(synced, { kind: 'detachBacking' });
    expect(detached.backing).toBeUndefined();
    expect(detached.assets).toEqual([]);
  });

  it('rejects crossing, duplicate and out-of-range anchors without touching the document', () => {
    const synced = applied(applied(attached, { kind: 'addSyncPoint', point: point(attached, 0, 2) }), { kind: 'addSyncPoint', point: point(attached, 2, 10) });
    const crossing = apply(synced, { kind: 'addSyncPoint', point: point(synced, 1, 11) });
    expect(crossing.kind).toBe('rejected');
    if (crossing.kind === 'rejected') expect(crossing.diagnostics[0]?.message).toContain('교차');
    const moved = apply(synced, { kind: 'moveSyncPoint', index: 1, mediaSeconds: 1.5 });
    expect(moved.kind).toBe('rejected');
    const duplicate = apply(synced, { kind: 'addSyncPoint', point: point(synced, 0, 3) });
    expect(duplicate.kind).toBe('rejected');
    if (duplicate.kind === 'rejected') expect(duplicate.diagnostics[0]?.message).toContain('같은 악보 위치');
    expect(apply(synced, { kind: 'addSyncPoint', point: point(synced, 3, 12, rationalQ(4n)) }).kind).toBe('rejected');
    expect(apply(synced, { kind: 'removeSyncPoint', index: 5 }).kind).toBe('rejected');
    expect(apply(synced, { kind: 'backingOffset', offsetSeconds: Number.NaN }).kind).toBe('rejected');
    expect(apply(base, { kind: 'addSyncPoint', point: point(base, 0, 1) }).kind).toBe('rejected');
    expect(syncPointConflict(synced, [point(synced, 2, 1), point(synced, 0, 2)])).toContain('교차');
    expect(syncPointConflict(synced, [point(synced, 0, 1), point(synced, 2, 2)])).toBeNull();
    expect(synced.backing?.syncPoints).toHaveLength(2);
  });

  it('interpolates media time between anchors and extrapolates at tempo outside them', () => {
    const anchors = [{ scoreSeconds: 0, mediaSeconds: 2 }, { scoreSeconds: 8, mediaSeconds: 10 }];
    expect(measureMediaSeconds({ anchors, offsetSeconds: 0, scoreSeconds: 4 })).toBe(6);
    expect(measureMediaSeconds({ anchors, offsetSeconds: 0, scoreSeconds: 12 })).toBe(14);
    expect(measureMediaSeconds({ anchors: [], offsetSeconds: 1.5, scoreSeconds: 4 })).toBe(5.5);
  });

  it('diagnoses missing manifest entries, missing bytes and corrupt audio without repairing anything', () => {
    const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'backing'), score: attached, assets: attached.assets, source: null, preservation: [] };
    const sha256 = asset(wav).sha256;
    expect(inspectBackingAsset(project, [{ sha256, bytes: wav }]).kind).toBe('ready');
    expect(inspectBackingAsset(project, []).kind).toBe('missing-bytes');
    expect(inspectBackingAsset({ ...project, assets: [] }, [{ sha256, bytes: wav }]).kind).toBe('missing-manifest');
    expect(inspectBackingAsset(project, [{ sha256, bytes: wav.slice(0, 1000) }]).kind).toBe('corrupt');
    const garbage = new Uint8Array(wav.byteLength).fill(1);
    expect(inspectBackingAsset(project, [{ sha256, bytes: garbage }])).toMatchObject({ kind: 'corrupt' });
    expect(inspectBackingAsset({ ...project, score: base, assets: [] }, []).kind).toBe('none');
  });

  it('keeps WAV bytes verbatim, transcodes compressed audio to 48 kHz stereo WAV and refuses corrupt or unknown files', async () => {
    const decoder = vi.fn(async () => ({ sampleRate: 24_000, channels: [new Float32Array(24_000).fill(0.25)] }));
    const kept = await decodeBacking({ name: 'loop.wav', bytes: wav, maxBytes: 1 << 30 }, decoder);
    expect(kept.wav).toBe(wav); expect(kept.transcoded).toBe(false); expect(kept.durationSeconds).toBeCloseTo(20, 6);
    expect(decoder).not.toHaveBeenCalled();
    const transcoded = await decodeBacking({ name: 'song.mp3', bytes: new Uint8Array([1, 2, 3]), maxBytes: 1 << 30 }, decoder);
    const layout = parseWave(transcoded.wav);
    expect(layout).toMatchObject({ sampleRate: 48_000, channels: 2, bits: 16, frames: 48_000 });
    expect(transcoded.durationSeconds).toBe(1); expect(transcoded.transcoded).toBe(true);
    await expect(decodeBacking({ name: 'broken.wav', bytes: wav.slice(0, 30), maxBytes: 1 << 30 }, decoder)).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(decodeBacking({ name: 'notes.txt', bytes: wav, maxBytes: 1 << 30 }, decoder)).rejects.toBeInstanceOf(BackingImportError);
    await expect(decodeBacking({ name: 'song.ogg', bytes: new Uint8Array(8), maxBytes: 1 << 30 }, async () => { throw new Error('bad stream'); })).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(decodeBacking({ name: 'big.wav', bytes: wav, maxBytes: 10 }, decoder)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('builds a halving peak pyramid whose columns follow the signal envelope', () => {
    const pyramid = buildPeakPyramid(wav);
    expect(pyramid.frames).toBe(960_000);
    expect(pyramid.levels.map(level => level.framesPerBucket)).toEqual([256, 512, 1024]);
    expect(pyramid.levels.map(level => level.min.length)).toEqual([3750, 1875, 938]);
    expect(pyramid.levels.at(-1)?.min.length).toBeLessThanOrEqual(1024);
    const columns = peakColumns(pyramid, 0, 20, 10);
    expect(columns).toHaveLength(10);
    const first = columns[0]; const last = columns[9];
    if (!first || !last) throw new RangeError('Missing peak columns');
    expect(first.max).toBeGreaterThan(0.65); expect(last.max).toBeLessThan(0.35);
    expect(peakColumns(pyramid, 25, 30, 4).every(column => column.min === 0 && column.max === 0)).toBe(true);
  });

  it('extracts GP8 embedded backing audio, frame padding and sync points from the container', () => {
    const gpif = `<?xml version="1.0"?><GPIF><BackingTrack><Enabled>true</Enabled><Source>Local</Source><AssetId>7</AssetId><FramePadding>44100</FramePadding></BackingTrack>
      <Assets><Asset id="7"><EmbeddedFilePath><![CDATA[Content/Assets/backing.mp3]]></EmbeddedFilePath></Asset></Assets>
      <MasterTrack><Automations><Automation><Type>SyncPoint</Type><Position>0.5</Position><Value><BarIndex>2</BarIndex><BarOccurrence>1</BarOccurrence><FrameOffset>132300</FrameOffset></Value></Automation>
      <Automation><Type>Tempo</Type><Position>0</Position><Value>120 2</Value></Automation></Automations></MasterTrack></GPIF>`;
    const archive = zipSync({ 'Content/score.gpif': strToU8(gpif), 'Content/Assets/backing.mp3': new Uint8Array([0xff, 0xfb, 1, 2]) });
    const embedded = extractEmbeddedBacking(archive, 1 << 20);
    expect(embedded?.name).toBe('backing.mp3');
    expect(embedded?.bytes).toEqual(new Uint8Array([0xff, 0xfb, 1, 2]));
    expect(embedded?.framePaddingSeconds).toBe(1);
    expect(embedded?.syncPoints).toEqual([{ barIndex: 2, barOccurrence: 1, positionRatio: 0.5, mediaSeconds: 3 }]);
    expect(extractEmbeddedBacking(zipSync({ 'Content/score.gpif': strToU8('<GPIF/>') }), 1 << 20)).toBeNull();
    expect(extractEmbeddedBacking(new Uint8Array([1, 2, 3]), 1 << 20)).toBeNull();
  });

  it('disables fixed BPM only while anchors are active and synchronization is on', () => {
    const synced = applied(applied(attached, { kind: 'addSyncPoint', point: point(attached, 0, 2) }), { kind: 'addSyncPoint', point: point(attached, 2, 10) });
    const store = new BackingStore();
    expect(store.playbackScore(synced)).toBe(synced);
    store.setSyncEnabled(false);
    expect(store.playbackScore(synced).backing?.syncPoints).toEqual([]);
    expect(buildPlayback(store.playbackScore(synced)).mediaOffset).toBe(0);
    const practice = new Practice();
    practice.setBackingSync(store.getSnapshot().syncEnabled && synced.backing !== undefined && synced.backing.syncPoints.length > 0);
    practice.configure({ mode: 'fixed', value: 90, trainer: null, audible: false, visual: false, countIn: false });
    expect(practice.getSnapshot().mode).toBe('fixed');
    store.setSyncEnabled(true);
    practice.setBackingSync(true);
    expect(practice.getSnapshot().mode).toBe('relative');
    expect(() => practice.configure({ mode: 'fixed', value: 90, trainer: null, audible: false, visual: false, countIn: false })).toThrow('반주 동기화');
  });
});
