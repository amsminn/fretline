import { expect, it } from 'vitest';
import { memoryInfraTotals, WebAudioLifetime } from '../../script/qa/lib/memory-infra';

it('extracts renderer allocator totals and the audio, wasm, V8 and partition subsets', () => {
  const events: readonly unknown[] = [
    { pid: 42, args: { dumps: { allocators: {
      malloc: { attrs: { size: { value: '100', units: 'bytes' } } },
      partition_alloc: {
        attrs: { size: { value: '200', units: 'bytes' } },
        array_buffer: { attrs: { size: { value: '40', units: 'bytes' } } },
      },
      v8: { isolate_1: { attrs: { size: { value: '80', units: 'bytes' } } } },
      blink_gc: { attrs: { size: { value: '20', units: 'bytes' } } },
      web_audio: { wasm: { attrs: { size: { value: '10', units: 'bytes' } } } },
      unrelated: { attrs: { size: { value: '8', units: 'bytes' } } },
    } } } },
    { pid: 7, args: { dumps: { allocators: { malloc: { attrs: { size: { value: 'ffff' } } } } } } },
  ];
  const result = memoryInfraTotals(events, 42);
  expect(result.allocators).toEqual([
    { path: 'blink_gc', bytes: 32 },
    { path: 'malloc', bytes: 256 },
    { path: 'partition_alloc', bytes: 512 },
    { path: 'partition_alloc/array_buffer', bytes: 64 },
    { path: 'unrelated', bytes: 8 },
    { path: 'v8/isolate_1', bytes: 128 },
    { path: 'web_audio/wasm', bytes: 16 },
  ]);
  expect(result.selected).toEqual(result.allocators.filter(allocator => allocator.path !== 'unrelated'));
});

it('drops every node owned by a destroyed WebAudio context even without node-destroy events', () => {
  const lifetime = new WebAudioLifetime();
  lifetime.contextCreated('context-1', 'realtime');
  lifetime.nodeCreated('destination', 'AudioDestination', 'context-1');
  lifetime.nodeCreated('worklet', 'AudioWorklet', 'context-1');

  lifetime.contextDestroyed('context-1');

  expect(lifetime.snapshot()).toEqual({
    audioContexts: 0,
    contextTypes: {},
    contextLifecycle: { created: { realtime: 1 }, destroyed: { realtime: 1 } },
    audioNodes: 0,
    nodeTypes: {},
    nodeLifecycle: { created: 2, destroyed: 2 },
  });
});
