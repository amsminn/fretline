import { additionalShortcuts, primary, shared } from './keymap';
import type { Shortcut } from './keymap';
import type { CommandContext } from './contexts';
import type { Source } from './parity';
import { pick } from '../i18n';
import type { MessagePair } from '../i18n';

export const menus = [
  ['File', '파일'], ['Edit', '편집'], ['Track', '트랙'], ['Bar', '마디'],
  ['Note', '음표'], ['Effects', '효과'], ['Section', '섹션'], ['Tools', '도구'],
  ['Sound', '사운드'], ['View', '보기'], ['Window', '윈도우'], ['Help', '도움말'],
] as const;
export type MenuName = typeof menus[number][0];
/** The English menu title is also the menu id. */
export const menuLabel = (menu: MenuName, korean: string): string => pick([korean, menu]);
export type CommandDefinition = {
  readonly id: string;
  /** Resolved from `labels` for the current UI language on every read. */
  readonly label: string;
  readonly labels: MessagePair;
  readonly menu: MenuName;
  readonly owner: number;
  readonly source: readonly Source[];
  readonly contexts: readonly CommandContext[];
  readonly keys: Shortcut;
  readonly surfaces: readonly ('menu' | 'palette' | 'toolbar')[];
};
type Labels = Readonly<Record<string, MessagePair>>;
const formatNames: Labels = {
  gp: ['GP 파일(.gp)', 'GP file (.gp)'], musicxml: ['MusicXML', 'MusicXML'], midi: ['MIDI', 'MIDI'], alphatex: ['alphaTex', 'alphaTex'],
  original: ['원본 파일(바이트 그대로)', 'Original File (byte-exact)'], pdf: ['PDF', 'PDF'], png: ['PNG 이미지', 'PNG Image'], svg: ['SVG 이미지', 'SVG Image'],
  wav: ['WAV 오디오', 'WAV Audio'], stems: ['트랙별 WAV', 'Per-Track WAV'],
};
const formatName = (format: string): MessagePair => formatNames[format] ?? [format, format];
const arrowNames: Labels = { Left: ['왼쪽', 'Left'], Right: ['오른쪽', 'Right'], Up: ['위', 'Up'], Down: ['아래', 'Down'] };
const effectLabels: Labels = {
  bend: ['벤드', 'Bend'], hammerPull: ['해머온 / 풀오프', 'Hammer-On / Pull-Off'], slide: ['슬라이드', 'Slide'], palmMute: ['팜 뮤트', 'Palm Mute'],
  dead: ['데드 노트', 'Dead Note'], harmonic: ['하모닉스', 'Harmonics'], vibrato: ['비브라토', 'Vibrato'], letRing: ['렛 링', 'Let Ring'],
  tap: ['태핑', 'Tapping'], slap: ['슬랩', 'Slap'], pop: ['팝', 'Pop'], accent: ['악센트', 'Accent'], staccato: ['스타카토', 'Staccato'], trill: ['트릴', 'Trill'],
  fadeIn: ['페이드 인', 'Fade In'], fadeOut: ['페이드 아웃', 'Fade Out'], brushDown: ['브러시 다운', 'Brush Down'], pickDown: ['다운 피킹', 'Pickstroke Down'],
  rasgueado: ['라스게아도', 'Rasgueado'], fingering: ['운지 표시', 'Fingering'], sustainPedal: ['서스테인 페달', 'Sustain Pedal'],
  audioSettings: ['음표 오디오 설정', 'Note Audio Settings'], tremoloPicking: ['트레몰로 피킹', 'Tremolo Picking'], tremoloBar: ['트레몰로 바', 'Tremolo Bar'],
  ghost: ['고스트 노트', 'Ghost Note'], legato: ['레가토', 'Legato'], brushUp: ['브러시 업', 'Brush Up'], pickUp: ['업 피킹', 'Pickstroke Up'],
  palmMuteBeat: ['박 팜 뮤트', 'Palm Mute (Beat)'],
};
const trackLabels: Labels = {
  add: ['트랙 추가', 'Add Track'], delete: ['트랙 삭제', 'Delete Track'], copy: ['트랙 복제', 'Duplicate Track'], tuning: ['튜닝', 'Tuning'],
  capo: ['카포', 'Capo'], instrument: ['악기', 'Instrument'], transpose: ['이조', 'Transpose'], drums: ['드럼 트랙', 'Drum Track'],
};
const barLabels: Labels = {
  insert: ['마디 삽입', 'Insert Bar'], delete: ['마디 삭제', 'Delete Bar'], meter: ['박자표', 'Time Signature'], key: ['조표', 'Key Signature'],
  tempo: ['템포', 'Tempo'], repeatOpen: ['반복 시작', 'Repeat Open'], repeatClose: ['반복 끝', 'Repeat Close'], endings: ['다른 엔딩', 'Alternate Endings'],
  directions: ['진행 기호', 'Directions'], pickup: ['못갖춘마디', 'Pickup Bar'], freeTime: ['자유 박자', 'Free Time'], rebar: ['마디 재분할', 'Rebar'],
};
const sectionLabels: Labels = {
  edit: ['섹션 표시', 'Section Marker'], next: ['다음 섹션', 'Next Section'], previous: ['이전 섹션', 'Previous Section'], text: ['텍스트', 'Text'],
  lyrics: ['가사', 'Lyrics'], chord: ['코드', 'Chord'], automation: ['자동화', 'Automation'],
};
const soundLabels: Labels = {
  stop: ['정지', 'Stop'], seek: ['위치 이동', 'Seek'], audition: ['음표 미리 듣기', 'Audition Note'], resumeFollow: ['자동 스크롤 재개', 'Resume Auto-Scroll'],
  mute: ['음소거', 'Mute'], solo: ['솔로', 'Solo'], volume: ['볼륨', 'Volume'], pan: ['팬', 'Pan'], focus: ['포커스', 'Focus'],
  trackEq: ['트랙 EQ', 'Track EQ'], masterEq: ['마스터 EQ', 'Master EQ'],
};
const practiceLabels: Labels = {
  relativeSpeed: ['재생 속도', 'Playback Speed'], fixedBpm: ['고정 템포', 'Fixed Tempo'], trainer: ['속도 훈련', 'Speed Trainer'],
  metronome: ['메트로놈', 'Metronome'], countIn: ['카운트인', 'Count-in'],
};
const backingLabels: Labels = {
  import: ['반주 가져오기', 'Import Backing Track'], waveform: ['파형 표시', 'Show Waveform'], anchors: ['동기점', 'Sync Points'],
  offset: ['반주 오프셋', 'Backing Offset'], sync: ['반주 동기화', 'Backing Sync'], gain: ['반주 볼륨', 'Backing Volume'], mute: ['반주 음소거', 'Mute Backing'],
};
const panelLabels: Labels = {
  palette: ['편집 팔레트', 'Editing Palette'], multitrack: ['멀티트랙', 'Multitrack'], songInspector: ['Song 검사기', 'Song Inspector'],
  trackInspector: ['Track 검사기', 'Track Inspector'], stylesheet: ['스타일시트', 'Stylesheet'], globalView: ['Global View', 'Global View'],
};
const viewLabels: Labels = {
  zoomIn: ['확대', 'Zoom In'], zoomOut: ['축소', 'Zoom Out'], notation: ['기보 방식', 'Notation Mode'], clef: ['음자리표', 'Clef'],
  spelling: ['임시표 표기', 'Accidental Spelling'], courtesyAccidental: ['예방 임시표', 'Courtesy Accidentals'], page: ['페이지 보기', 'Page View'],
  horizontal: ['가로 보기', 'Horizontal View'], part: ['파트 보기', 'Part View'], fullScore: ['전체 악보', 'Full Score'], design: ['디자인 모드', 'Design Mode'],
  lineBreak: ['줄 바꿈', 'Line Break'], beatSpacing: ['박 간격', 'Beat Spacing'], scoreSettings: ['악보 설정', 'Score Settings'],
};
const toolLabels: Labels = { instrument: ['악기 보기', 'Instrument View'], tuner: ['튜너', 'Tuner'], chord: ['코드 도구', 'Chord Tool'], scale: ['스케일 도구', 'Scale Tool'] };
const labelOf = (table: Labels, id: string): MessagePair => table[id] ?? [id, id];
const editing = ['editing'] as const;
const workspace = ['editing', 'playback'] as const;
// Menus without a documented shortcut intentionally remain menu-accessible.
type CommandPlacement = Pick<CommandDefinition, 'menu' | 'owner'> & Partial<Pick<CommandDefinition, 'keys' | 'contexts'>>;
function command(id: string, labels: MessagePair, placement: CommandPlacement): CommandDefinition {
  return { id, labels, get label() { return pick(labels); }, ...placement, keys: placement.keys ?? additionalShortcuts[id] ?? shared(), contexts: placement.contexts ?? editing, source: ['R1', 'R4', 'R5'],
    surfaces: ['menu', 'palette', 'toolbar'] };
}
export const commandDefinitions: readonly CommandDefinition[] = [
  command('file.new', ['새 악보', 'New Score'], { menu: 'File', owner: 33, keys: primary('n') }),
  command('file.open', ['열기', 'Open'], { menu: 'File', owner: 7, keys: primary('o'), contexts: workspace }),
  command('file.templates', ['템플릿', 'Templates'], { menu: 'File', owner: 33 }),
  command('file.recent', ['최근 문서', 'Recent Documents'], { menu: 'File', owner: 33 }),
  command('file.save', ['저장', 'Save'], { menu: 'File', owner: 6, keys: primary('s'), contexts: workspace }),
  command('file.saveAs', ['다른 이름으로 저장', 'Save As'], { menu: 'File', owner: 6, keys: primary('Shift+s'), contexts: workspace }),
  command('file.close', ['문서 닫기', 'Close Document'], { menu: 'File', owner: 33, keys: primary('w'), contexts: workspace }),
  command('file.closeAll', ['모든 문서 닫기', 'Close All Documents'], { menu: 'File', owner: 33, keys: primary('Shift+w'), contexts: workspace }),
  command('file.recovery', ['복구', 'Recovery'], { menu: 'File', owner: 28 }),
  command('file.editableCopy', ['편집 가능한 사본으로 변환', 'Convert to Editable Copy'], { menu: 'File', owner: 7 }),
  ...['gp', 'musicxml', 'midi', 'alphatex', 'original', 'pdf', 'png', 'svg', 'wav', 'stems'].map(format =>
    command(`file.export.${format}`, [`${formatName(format)[0]} 내보내기`, `Export ${formatName(format)[1]}`], { menu: 'File', owner: ['gp', 'alphatex', 'original'].includes(format) ? 25 : ['wav', 'stems'].includes(format) ? 24 : ['pdf', 'png', 'svg'].includes(format) ? 27 : 26 })),
  // alphaTex is an export-only format (plan C5/R8); no import handler exists, so no import entry is cataloged.
  ...['musicxml', 'midi'].map(format => command(`file.import.${format}`, [`${formatName(format)[0]} 가져오기`, `Import ${formatName(format)[1]}`], { menu: 'File', owner: 26 })),
  command('file.print', ['인쇄', 'Print'], { menu: 'File', owner: 27, keys: primary('p') }),
  command('file.pageSetup', ['페이지 설정', 'Page Setup'], { menu: 'File', owner: 27 }),
  command('file.quit', ['Fretline 종료', 'Quit Fretline'], { menu: 'File', owner: 4, keys: { mac: ['Meta+q'], windows: ['Alt+F4'] }, contexts: workspace }),
  command('edit.undo', ['실행 취소', 'Undo'], { menu: 'Edit', owner: 15, keys: primary('z') }),
  command('edit.redo', ['다시 실행', 'Redo'], { menu: 'Edit', owner: 15, keys: { mac: ['Meta+Shift+z'], windows: ['Ctrl+y'] } }),
  ...(['copy', 'cut', 'paste'] as const).map((id, index) => command(`edit.${id}`, ([['복사', 'Copy'], ['잘라내기', 'Cut'], ['붙여넣기', 'Paste']] as const)[index] ?? [id, id], { menu: 'Edit', owner: 15, keys: primary(['c', 'x', 'v'][index] ?? '') })),
  command('edit.specialPaste', ['특수 붙여넣기', 'Special Paste'], { menu: 'Edit', owner: 18, keys: primary('Shift+v') }),
  command('edit.copyAllTracks', ['모든 트랙 복사', 'Copy All Tracks'], { menu: 'Edit', owner: 18, keys: primary('Shift+c') }),
  command('edit.cutAllTracks', ['모든 트랙 잘라내기', 'Cut All Tracks'], { menu: 'Edit', owner: 18, keys: primary('Shift+x') }),
  command('selection.all', ['현재 트랙 전체 선택', 'Select Whole Track'], { menu: 'Edit', owner: 11, keys: primary('a') }),
  command('selection.clear', ['선택 해제', 'Clear Selection'], { menu: 'Edit', owner: 11, keys: shared('Escape'), contexts: workspace }),
  ...['Left', 'Right', 'Up', 'Down'].flatMap(key => [
    command(`navigate.${key.toLowerCase()}`, [`${labelOf(arrowNames, key)[0]}으로 이동`, `Move ${labelOf(arrowNames, key)[1]}`], { menu: 'Edit', owner: 15, keys: shared(`Arrow${key}`) }),
    command(`selection.${key.toLowerCase()}`, [`${labelOf(arrowNames, key)[0]}으로 선택 확장`, `Extend Selection ${labelOf(arrowNames, key)[1]}`], { menu: 'Edit', owner: 11, keys: shared(`Shift+Arrow${key}`) }),
  ]),
  command('navigate.nextStaff', ['다음 보표', 'Next Staff'], { menu: 'Edit', owner: 15, keys: shared('Tab') }),
  command('navigate.previousStaff', ['이전 보표', 'Previous Staff'], { menu: 'Edit', owner: 15, keys: shared('Shift+Tab') }),
  ...Array.from({ length: 10 }, (_, digit) => command(`note.fret.${digit}`, [`프렛 ${digit}`, `Fret ${digit}`], { menu: 'Note', owner: 15, keys: shared(String(digit)) })),
  command('note.durationShorter', ['음 길이 줄이기', 'Shorten Duration'], { menu: 'Note', owner: 15, keys: shared('+', '=') }),
  command('note.durationLonger', ['음 길이 늘리기', 'Lengthen Duration'], { menu: 'Note', owner: 15, keys: shared('-', '_') }),
  command('note.rest', ['쉼표', 'Rest'], { menu: 'Note', owner: 15, keys: shared('r') }),
  command('note.delete', ['음표 삭제', 'Delete Note'], { menu: 'Note', owner: 15, keys: shared('Backspace') }),
  command('note.dot', ['부점', 'Dotted Note'], { menu: 'Note', owner: 15, keys: shared('.') }),
  command('note.insertBeat', ['박 삽입', 'Insert Beat'], { menu: 'Note', owner: 15, keys: { mac: ['Ctrl++'], windows: ['Ctrl+Insert'] } }),
  command('note.ripple', ['밀어내기 편집', 'Ripple Edit'], { menu: 'Note', owner: 14 }),
  command('note.tie', ['붙임줄', 'Tie'], { menu: 'Note', owner: 16, keys: shared('l') }),
  command('note.tuplet', ['잇단음표', 'Tuplet'], { menu: 'Note', owner: 16, keys: shared('/') }),
  command('note.grace', ['꾸밈음', 'Grace Note'], { menu: 'Note', owner: 16, keys: shared('g') }),
  command('note.graceOnBeat', ['박 위 꾸밈음', 'Grace Note on Beat'], { menu: 'Note', owner: 16, keys: { mac: ['Alt+g'], windows: ['Ctrl+Alt+g'] } }),
  command('note.tieBeat', ['박 붙임줄', 'Tie Beat'], { menu: 'Note', owner: 16, keys: shared('Shift+l') }),
  command('note.moveVoice', ['성부 이동', 'Move to Voice'], { menu: 'Note', owner: 16 }),
  command('note.multivoice', ['다성부 편집', 'Multivoice Editing'], { menu: 'Note', owner: 16, keys: primary('m') }),
  ...[1, 2, 3, 4].map(voice => command(`note.voice.${voice}`, [`성부 ${voice}`, `Voice ${voice}`], { menu: 'Note', owner: 16, keys: primary(String(voice)) })),
  ...[
    ['bend', 'b'], ['hammerPull', 'h'], ['slide', 's'], ['palmMute', 'p'],
    ['dead', 'x'], ['harmonic', 'y'], ['vibrato', 'v'], ['letRing', 'i'],
    ['tap', ')'], ['slap', '$'], ['pop', ''], ['accent', ';'], ['staccato', '!'],
    ['trill', 'n'], ['fadeIn', '<'], ['fadeOut', '>'], ['brushDown', 'Meta+d'],
    ['pickDown', 'Shift+d'], ['rasgueado', 'Shift+r'], ['fingering', ''],
    ['sustainPedal', ''], ['audioSettings', 'Shift+f'], ['tremoloPicking', ''],
    ['tremoloBar', ''], ['ghost', 'o'], ['legato', 'Shift+h'],
    ['brushUp', ''], ['pickUp', 'Shift+u'], ['palmMuteBeat', 'Shift+p'],
  ].map(([id = '', key = '']) => command(`effects.${id}`, labelOf(effectLabels, id), { menu: 'Effects', owner: 17, keys: key === 'Meta+d' ? primary('d') : key ? shared(key) : shared() })),
  ...['add', 'delete', 'copy', 'tuning', 'capo', 'instrument', 'transpose', 'drums'].map(id =>
    command(`track.${id}`, labelOf(trackLabels, id), { menu: 'Track', owner: 18 })),
  command('track.next', ['다음 트랙', 'Next Track'], { menu: 'Track', owner: 18, keys: primary('ArrowDown'), contexts: workspace }),
  command('track.previous', ['이전 트랙', 'Previous Track'], { menu: 'Track', owner: 18, keys: primary('ArrowUp'), contexts: workspace }),
  ...['insert', 'delete', 'meter', 'key', 'tempo', 'repeatOpen', 'repeatClose', 'endings', 'directions', 'pickup', 'freeTime', 'rebar'].map(id =>
    command(`bar.${id}`, labelOf(barLabels, id), { menu: 'Bar', owner: id === 'rebar' ? 16 : 18 })),
  ...['edit', 'next', 'previous', 'text', 'lyrics', 'chord', 'automation'].map(id => command(`section.${id}`, labelOf(sectionLabels, id), { menu: 'Section', owner: 18 })),
  command('sound.playPause', ['재생 / 일시정지', 'Play / Pause'], { menu: 'Sound', owner: 12, keys: shared('Space'), contexts: workspace }),
  command('sound.loop', ['구간 반복', 'Loop'], { menu: 'Sound', owner: 13, keys: shared('F9'), contexts: workspace }),
  command('sound.playFromBeginning', ['처음부터 재생', 'Play from Beginning'], { menu: 'Sound', owner: 12,
    keys: { mac: ['Shift+Space'], windows: ['Ctrl+Space'] }, contexts: workspace }),
  command('sound.stepBackward', ['한 박 뒤로', 'Step Backward'], { menu: 'Sound', owner: 12, keys: shared('Alt+ArrowLeft'), contexts: workspace }),
  command('sound.forward', ['한 박 앞으로', 'Step Forward'], { menu: 'Sound', owner: 12, keys: shared('Alt+ArrowRight'), contexts: workspace }),
  command('sound.rewind', ['되감기', 'Rewind'], { menu: 'Sound', owner: 12, keys: primary('ArrowLeft'), contexts: workspace }),
  command('sound.fastForward', ['빨리 감기', 'Fast Forward'], { menu: 'Sound', owner: 12, keys: primary('ArrowRight'), contexts: workspace }),
  command('sound.speedUp', ['속도 높이기', 'Speed Up'], { menu: 'Sound', owner: 20, keys: shared('+', '='), contexts: ['playback'] }),
  command('sound.speedDown', ['속도 낮추기', 'Speed Down'], { menu: 'Sound', owner: 20, keys: shared('-', '_'), contexts: ['playback'] }),
  ...['stop', 'seek', 'audition', 'resumeFollow', 'mute', 'solo', 'volume', 'pan', 'focus', 'trackEq', 'masterEq'].map(id =>
    command(`sound.${id}`, labelOf(soundLabels, id), { menu: 'Sound', owner: 12, keys: shared(), contexts: workspace })),
  ...['relativeSpeed', 'fixedBpm', 'trainer', 'metronome', 'countIn'].map(id =>
    command(`practice.${id}`, labelOf(practiceLabels, id), { menu: 'Sound', owner: 20, keys: shared(), contexts: workspace })),
  ...['import', 'waveform', 'anchors', 'offset', 'sync', 'gain', 'mute'].map(id =>
    command(`backing.${id}`, labelOf(backingLabels, id), { menu: 'Sound', owner: 22, keys: shared(), contexts: workspace })),
  ...[
    ['palette', 'F2', 10], ['multitrack', 'F3', 19], ['songInspector', 'F5', 10],
    ['trackInspector', 'F6', 10], ['stylesheet', 'F7', 19], ['globalView', 'F8', 10],
  ].map(([id, key, owner]) => command(`view.${id}`, labelOf(panelLabels, String(id)), { menu: 'View', owner: Number(owner), keys: shared(String(key)), contexts: workspace })),
  ...['zoomIn', 'zoomOut', 'notation', 'clef', 'spelling', 'courtesyAccidental', 'page', 'horizontal', 'part', 'fullScore', 'design', 'lineBreak', 'beatSpacing', 'scoreSettings'].map(id =>
    command(`view.${id}`, labelOf(viewLabels, id), { menu: 'View', owner: 19 })),
  command('tools.commandPalette', ['명령 팔레트', 'Command Palette'], { menu: 'Tools', owner: 23, keys: primary('e'), contexts: workspace }),
  ...['instrument', 'tuner', 'chord', 'scale'].map(id => command(`tools.${id}`, labelOf(toolLabels, id), { menu: 'Tools', owner: 23, keys: shared(), contexts: workspace })),
  command('tools.preferences', ['설정', 'Preferences'], { menu: 'Tools', owner: 33, keys: primary(','), contexts: workspace }),
  command('window.minimize', ['최소화', 'Minimize'], { menu: 'Window', owner: 4, keys: shared(), contexts: workspace }),
  command('window.fullscreen', ['전체 화면', 'Full Screen'], { menu: 'Window', owner: 4, keys: shared('F11'), contexts: workspace }),
  command('help.guide', ['사용 설명서', 'User Guide'], { menu: 'Help', owner: 32, keys: shared(), contexts: workspace }),
  command('help.shortcuts', ['단축키', 'Shortcuts'], { menu: 'Help', owner: 32, keys: shared(), contexts: workspace }),
  command('help.compatibility', ['호환성', 'Compatibility'], { menu: 'Help', owner: 32, keys: shared(), contexts: workspace }),
  command('help.about', ['Fretline 정보', 'About Fretline'], { menu: 'Help', owner: 4, keys: shared(), contexts: workspace }),
];
