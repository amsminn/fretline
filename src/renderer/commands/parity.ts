export const sources = {
  R1: 'main screen layout',
  R2: 'click and drag',
  R3: 'navigation',
  R4: 'keyboard shortcuts',
  R5: 'playback',
} as const;
export type Source = keyof typeof sources;
export const parityRows = [
  { id: 'UX01', source: ['R1'], owner: [5, 10, 29], case: 'shell-parity', electron: ['shell-parity', 'gp-parity-tour'] },
  { id: 'UX02', source: ['R1', 'R5'], owner: [10, 12, 22, 23], case: 'toolbar-order', electron: ['shell-parity', 'gp-parity-tour', 'gp-parity-compact'] },
  { id: 'UX03', source: ['R2', 'R3', 'R4'], owner: [15], case: 'fret-entry', electron: ['fret-entry-editing', 'gp-parity-tour'] },
  { id: 'UX04', source: ['R4', 'R5'], owner: [15, 20], case: 'shortcut-context', electron: ['fret-entry-editing', 'practice-controls'] },
  { id: 'UX05', source: ['R2'], owner: [11, 13], case: 'drag-loop', electron: ['drag-loop', 'drag-loop-boundaries', 'gp-parity-tour'] },
  { id: 'UX06', source: ['R1', 'R2'], owner: [10, 11, 13], case: 'global-range', electron: ['shell-parity', 'selection-gestures'] },
  { id: 'UX07', source: ['R4', 'R5'], owner: [12, 13], case: 'loop-context', electron: ['drag-loop', 'gp-parity-tour', 'gp-parity-compact'] },
  { id: 'UX08', source: ['R2', 'R4'], owner: [11], case: 'selection-keys', electron: ['selection-gestures', 'gp-parity-tour'] },
  { id: 'UX09', source: ['R4'], owner: [14, 15, 18], case: 'clipboard-history', electron: ['fret-entry-editing', 'invalid-repeat-paste', 'gp-parity-tour'] },
  { id: 'UX10', source: ['R4'], owner: [15, 17], case: 'articulation-shortcuts', electron: ['guitar-techniques', 'text-focus-no-leak', 'gp-parity-tour', 'gp-parity-compact'] },
  { id: 'UX11', source: ['R4'], owner: [16, 17], case: 'voice-scope', electron: ['complex-rhythm-edit'] },
  { id: 'UX12', source: ['R1', 'R4'], owner: [10, 19, 29], case: 'panel-shortcuts', electron: ['compact-panels', 'gp-parity-tour', 'gp-parity-compact'] },
  { id: 'UX13', source: ['R1', 'R3', 'R4'], owner: [10, 18], case: 'track-navigation', electron: ['shell-parity', 'compact-panels'] },
  { id: 'UX14', source: ['R2'], owner: [18, 19], case: 'direct-symbol-edit', electron: ['notation-design', 'gp-parity-tour', 'gp-parity-compact'] },
  { id: 'UX15', source: ['R3', 'R5'], owner: [12], case: 'playback-follow', electron: ['playback-mixer'] },
  { id: 'UX16', source: ['R1', 'R5'], owner: [10, 12], case: 'mixer-behavior', electron: ['playback-mixer', 'shell-parity', 'gp-parity-tour'] },
  { id: 'UX17', source: ['R1', 'R4'], owner: [10, 28, 33], case: 'document-tabs', electron: ['shell-parity', 'compact-panels', 'file-save-reopen', 'gp-parity-tour'] },
  { id: 'UX18', source: ['R5'], owner: [20], case: 'practice-controls', electron: ['practice-controls', 'practice-invalid-context'] },
  { id: 'UX19', source: ['R5'], owner: [22], case: 'backing-edit', electron: ['backing-edit', 'backing-invalid-anchor'] },
  { id: 'UX20', source: ['R4'], owner: [23, 32], case: 'command-palette', electron: ['practice-tools', 'gp-parity-tour'] },
] as const satisfies readonly {
  readonly id: string; readonly source: readonly Source[];
  readonly owner: readonly number[]; readonly case: string;
  /** Electron QA cases under script/qa/cases/electron that exercise the row. */
  readonly electron: readonly string[];
}[];
