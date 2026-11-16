import type { Language } from '../../main/settings';
import { getLanguage } from '../i18n/language';
import { pick } from '../i18n';
import type { MessagePair } from '../i18n';

export type HelpInline = string | { readonly command: string };
export type HelpTopic = {
  readonly id: string;
  readonly title: string;
  readonly paragraphs: readonly (readonly HelpInline[])[];
};
export type CompatibilityStatus = 'supported' | 'unsupported' | 'unverified' | 'default';
export type CompatibilityRow = {
  readonly area: string;
  readonly status: CompatibilityStatus;
  readonly text: readonly HelpInline[];
};
export type CompatibilityGroup = { readonly id: string; readonly title: string; readonly rows: readonly CompatibilityRow[] };
export type HelpContent = {
  readonly intro: string;
  readonly guideTopics: readonly HelpTopic[];
  readonly compatibilityGroups: readonly CompatibilityGroup[];
  readonly statusLabels: Readonly<Record<CompatibilityStatus, string>>;
};

/** Source prose: a Latin-only string stays as is; everything else is a [ko, en] pair resolved per language. */
type Text = string | MessagePair;
type SourceInline = Text | { readonly command: string };
type SourceTopic = { readonly id: string; readonly title: Text; readonly paragraphs: readonly (readonly SourceInline[])[] };
type SourceRow = { readonly area: Text; readonly status: CompatibilityStatus; readonly text: readonly SourceInline[] };
type SourceGroup = { readonly id: string; readonly title: Text; readonly rows: readonly SourceRow[] };

const statusLabelSource: Readonly<Record<CompatibilityStatus, Text>> = {
  supported: ['지원', 'Supported'], unsupported: ['미지원', 'Unsupported'], unverified: ['검증 안 됨', 'Unverified'], default: ['앱 기본값', 'App default'],
};
const c = (command: string): SourceInline => ({ command });

const introSource: Text = ['Fretline은 GP 형식 악보를 열고 편집·연습·출력하는 오프라인 앱입니다. 이 도움말은 앱에 내장되어 있어 네트워크 없이 읽을 수 있고, 명령 링크를 누르면 실제 명령이 실행됩니다.', 'Fretline is an offline app that opens, edits, practices and prints GP-format scores. This help is built into the app, so it works without a network, and clicking a command link runs the real command.'];

const guideSource: readonly SourceTopic[] = [
  { id: 'open', title: ['악보 열기와 문서 탭', 'Opening scores and document tabs'], paragraphs: [
    [['GP3·GP4·GP5·GPX·GP7·GP8, MusicXML, MIDI, .fretline 파일을 ', 'Open GP3 · GP4 · GP5 · GPX · GP7 · GP8, MusicXML, MIDI and .fretline files with '], c('file.open'), ['로 엽니다. 열린 문서마다 탭이 생기고, 수정된 문서는 탭에 점이 표시됩니다.', '. Every open document gets a tab, and a modified document shows a dot on its tab.']],
    [['GP 파일을 열면 호환성 보고서가 먼저 나타납니다. 읽은 항목은 지원, 읽지 않은 항목은 검증 안 됨으로 표시되며 원본 파일은 바이트 그대로 보관됩니다. 편집하려면 ', 'Opening a GP file first shows the compatibility report. Items that were read are marked Supported, items that were not are marked Unverified, and the original file is kept byte for byte. To edit, create an editable copy with '], c('file.editableCopy'), ['로 편집 사본을 만듭니다.', '.']],
  ] },
  { id: 'save', title: ['저장과 GP 내보내기는 다릅니다', 'Saving and exporting GP are different'], paragraphs: [
    [c('file.save'), ['는 항상 Fretline 자체 형식(.fretline)으로 저장합니다. 원본 GP 파일을 덮어쓰지 않습니다.', ' always saves in Fretline\'s own format (.fretline). It never overwrites the original GP file.']],
    [['.gp 파일이 필요하면 ', 'If you need a .gp file, create a separate file with '], c('file.export.gp'), ['로 별도 파일을 만듭니다. 내보내기 전 손실 보고서가 표시되고, 확인해야 파일이 쓰입니다. 변경하지 않은 원본이 필요하면 ', '. A loss report is shown before exporting and the file is written only after you acknowledge it. If you need the unchanged original, '], c('file.export.original'), ['이 바이트 그대로 꺼냅니다.', ' extracts it byte for byte.']],
    [['편집한 내용은 1초 안에 복구 저장소에 기록되며 비정상 종료 후 ', 'Edits are written to the recovery store within one second; after an abnormal exit, '], c('file.recovery'), ['에서 복원·버림·사본 저장을 고를 수 있습니다.', ' lets you restore, discard or save a copy.']],
  ] },
  { id: 'edit', title: ['편집: 키보드 중심 입력', 'Editing: keyboard-first entry'], paragraphs: [
    [['박을 클릭하고 줄 위에서 숫자를 누르면 프렛이 입력됩니다. 두 자리 프렛은 숫자를 이어서 누릅니다. 화살표로 이동하고 Tab / Shift+Tab으로 보표를 옮깁니다.', 'Click a beat and type a number on a string to enter a fret. Type two digits in a row for a two-digit fret. Move with the arrow keys and switch staves with Tab / Shift+Tab.']],
    [c('note.durationShorter'), ['와 ', ' and '], c('note.durationLonger'), ['로 음 길이를 바꾸고, ', ' change the duration, and '], c('note.rest'), ' · ', c('note.dot'), ' · ', c('note.tie'), ' · ', c('note.tuplet'), ['으로 쉼표·부점·붙임줄·잇단음표를 넣습니다.', ' insert rests, dots, ties and tuplets.']],
    [['주법은 선택한 음표에 적용됩니다: ', 'Techniques apply to the selected notes: '], c('effects.bend'), ' · ', c('effects.hammerPull'), ' · ', c('effects.slide'), ' · ', c('effects.palmMute'), ' · ', c('effects.vibrato'), ['. 성부는 ', '. Voices are '], c('note.voice.1'), '~', c('note.voice.4'), [', 다성부 편집은 ', ', and multivoice editing is '], c('note.multivoice'), ['입니다.', '.']],
    [c('edit.undo'), ' · ', c('edit.redo'), ['는 음표 ID까지 정확히 되돌립니다. ', ' restore everything exactly, down to note IDs. '], c('edit.specialPaste'), ['는 튜닝이 다른 트랙에 음높이를 유지해 붙여넣습니다.', ' pastes into a track with a different tuning while keeping the pitches.']],
  ] },
  { id: 'loop', title: ['드래그한 구간만 반복 연습', 'Loop practice on exactly the dragged range'], paragraphs: [
    [['악보 위에서 박을 드래그하면 파란 선택 영역이 생깁니다. 가장자리를 끌어 늘리거나 줄일 수 있고, 거꾸로 드래그해도 같은 구간입니다.', 'Dragging across beats on the score creates a blue selection. Drag either edge to extend or shrink it; dragging backwards gives the same range.']],
    [c('sound.loop'), ['을 켜고 ', ' and press '], c('sound.playPause'), ['를 누르면 선택한 첫 음부터 마지막 음 끝까지만 반복됩니다. 선택이 없으면 커서부터 끝까지 재생한 뒤 곡 전체를 반복합니다.', ' to repeat only from the first selected note to the end of the last one. With no selection, playback runs from the cursor to the end and then loops the whole song.']],
    [['재생 중 선택을 바꾸면 다음 반복부터가 아니라 즉시 새 구간으로 옮겨 갑니다. ', 'Changing the selection during playback moves to the new range immediately, not at the next loop. '], c('selection.clear'), ['로 선택을 지우면 반복이 켜져 있어도 다음 재생은 곡 전체입니다.', ' clears the selection; even with Loop on, the next playback covers the whole song.']],
    [c('sound.stop'), ['은 구간 시작으로 돌아가고 ', ' returns to the start of the range and '], c('sound.playFromBeginning'), ['은 처음부터 재생합니다.', ' plays from the beginning.']],
  ] },
  { id: 'practice', title: ['속도·메트로놈·반주', 'Speed, metronome and backing track'], paragraphs: [
    [c('practice.relativeSpeed'), ['(10–300%)는 음높이를 유지한 채 속도만 바꿉니다. 재생 중 + / - 키는 속도를 5%씩 조절합니다. ', ' (10–300%) changes only the speed while keeping the pitch. During playback the + / - keys adjust the speed in 5% steps. '], c('practice.fixedBpm'), ['은 템포를 고정하고, ', ' fixes the tempo, and '], c('practice.trainer'), ['은 반복마다 속도를 올립니다.', ' raises the speed on every loop.']],
    [c('practice.metronome'), ['과 ', ' and '], c('practice.countIn'), ['은 악보 시간에 맞춰 울립니다. 트랙 볼륨·팬·음소거·솔로는 Global View 아래 믹서에서 바꿉니다.', ' sound in score time. Track volume, pan, mute and solo are changed in the mixer under the Global View.']],
    [c('backing.import'), ['로 오디오 파일을 불러오면 파형이 악보 아래에 표시됩니다. 동기점을 찍어 악보와 맞추고, 반주와 악보 소리를 함께 듣습니다. 반주 동기화 중에는 고정 템포를 쓸 수 없습니다.', ' loads an audio file and shows its waveform under the score. Place sync points to align it with the score and hear the backing track together with the score. A fixed tempo cannot be used while backing sync is on.']],
  ] },
  { id: 'panels', title: ['화면 구성과 명령 팔레트', 'Screen layout and the command palette'], paragraphs: [
    [['화면 배치: 위 툴바, 문서 탭, 왼쪽 편집 팔레트(', 'Layout: toolbar on top, document tabs, Editing Palette on the left ('], c('view.palette'), ['), 가운데 악보, 오른쪽 Song / Track 검사기(', '), score in the centre, Song / Track Inspector on the right ('], c('view.songInspector'), ' · ', c('view.trackInspector'), ['), 아래 Global View(', '), Global View at the bottom ('], c('view.globalView'), ').'],
    [c('tools.commandPalette'), ['를 열고 명령 이름을 입력하면 실제 단축키와 함께 찾을 수 있습니다. 모든 메뉴 항목은 단축키 탭에 나열됩니다.', ' opens a search where typing a command name finds it together with its real shortcut. Every menu item is listed on the Shortcuts tab.']],
    [['악보의 템포·조표·박자·튜닝·섹션 기호를 직접 클릭하면 해당 대화상자가 열립니다.', 'Clicking a tempo, key signature, time signature, tuning or section marker on the score opens the matching dialog.']],
  ] },
  { id: 'output', title: ['인쇄와 출력', 'Printing and export'], paragraphs: [
    [c('file.print'), ' · ', c('file.export.pdf'), ' · ', c('file.export.png'), ' · ', c('file.export.svg'), ['는 실제 배치된 페이지를 출력합니다. ', ' output the pages exactly as laid out. '], c('file.export.wav'), ['와 ', ' and '], c('file.export.stems'), ['는 48 kHz 16비트 스테레오 PCM으로 렌더링합니다.', ' render 48 kHz 16-bit stereo PCM.']],
    [c('file.export.musicxml'), ' · ', c('file.export.midi'), ' · ', c('file.export.alphatex'), ['는 각 형식이 표현할 수 있는 범위로 내보내며, 빠지는 항목은 내보내기 전 보고서에 적힙니다.', ' export within what each format can represent; omitted items are listed in the report before exporting.']],
  ] },
];

const compatibilitySource: readonly SourceGroup[] = [
  { id: 'files', title: ['파일 형식', 'File formats'], rows: [
    { area: ['GP3 · GP4 · GP5 · GPX(GP6) · GP7 · GP8 읽기', 'Reading GP3 · GP4 · GP5 · GPX (GP6) · GP7 · GP8'], status: 'supported', text: [['열기 후 호환성 보고서가 항목별 상태를 보여 줍니다. 보고서에 없는 항목이 손실 없이 읽혔다는 뜻은 아닙니다.', 'After opening, the compatibility report shows the status of each item. An item missing from the report does not mean it was read without loss.']] },
    { area: ['.gp 쓰기 (형식 8.1.3)', 'Writing .gp (format 8.1.3)'], status: 'supported', text: [c('file.export.gp'), ['로 별도 파일을 만듭니다. 음표·리듬·트랙·튜닝·반복·선언된 주법이 내보내지고, 손실 항목은 내보내기 전에 표시됩니다. 형식 7까지만 읽는 프로그램에서는 열리지 않을 수 있습니다.', ' creates a separate file. Notes, rhythm, tracks, tuning, repeats and declared techniques are exported, and lost items are shown before exporting. Programs that read only format 7 may not open it.']] },
    { area: ['GP3 · GP4 · GP5 · GPX 쓰기', 'Writing GP3 · GP4 · GP5 · GPX'], status: 'unsupported', text: [['이 형식으로는 저장하거나 내보낼 수 없습니다. .gp 내보내기만 제공합니다.', 'These formats cannot be saved or exported. Only .gp export is provided.']] },
    { area: ['GP 파일 바이트 단위 왕복', 'Byte-exact round trip of GP files'], status: 'unsupported', text: [['열었다가 다시 내보낸 .gp가 원본과 같은 바이트라고 약속하지 않습니다. 원본은 ', 'A .gp file that was opened and exported again is not promised to be byte-identical to the original. The original can be extracted as-is with '], c('file.export.original'), ['로 그대로 꺼낼 수 있습니다.', '.']] },
    { area: 'MusicXML 4.0 (.musicxml / .mxl)', status: 'supported', text: [['성부·화음·쉼표·붙임줄·잇단음표·반복·가사·줄/프렛을 읽고 씁니다. GP 전용 표기와 오디오 설정은 보고서에 표시됩니다.', 'Voices, chords, rests, ties, tuplets, repeats, lyrics and string/fret are read and written. GP-specific notation and audio settings are listed in the report.']] },
    { area: ['MIDI (SMF 0/1 읽기, SMF 1 쓰기)', 'MIDI (reads SMF 0/1, writes SMF 1)'], status: 'supported', text: [['읽을 때는 1/16(또는 셋잇단) 그리드로 양자화한 미리보기를 확인한 뒤 문서가 됩니다. 기보 세부(주법·표기)는 MIDI에 없으므로 복원되지 않습니다.', 'On import you review a preview quantized to a 1/16 (or triplet) grid before it becomes a document. Notation details (techniques, markings) do not exist in MIDI and are not restored.']] },
    { area: ['PowerTab · TablEdit · ASCII 탭', 'PowerTab · TablEdit · ASCII tab'], status: 'unsupported', text: [['열거나 저장할 수 없습니다.', 'Cannot be opened or saved.']] },
  ] },
  { id: 'sound', title: ['음색과 재생', 'Sounds and playback'], rows: [
    { area: ['전용 음색 · 페달 모델', 'Proprietary sounds · pedal models'], status: 'unsupported', text: [['Fretline은 내장 SoundFont 신디사이저로 소리를 냅니다. 파일을 만든 프로그램의 전용 음색·이펙트 체인·페달 설정과 같은 소리가 나지 않으며, 파일 안의 그 설정은 읽지 않습니다.', 'Fretline plays through a built-in SoundFont synthesizer. It does not sound like the proprietary sounds, effect chains or pedal settings of the program that created the file, and those settings inside the file are not read.']] },
    { area: ['GP 파일 안의 읽지 않은 정보', 'Unread data inside GP files'], status: 'unverified', text: [['호환성 보고서의 "검증 안 됨" 항목은 보존 여부를 확인하지 못한 정보입니다. 편집 사본으로 바꾸면 그 정보는 내보낸 파일에 들어가지 않습니다.', '"Unverified" items in the compatibility report are data whose preservation could not be confirmed. After converting to an editable copy, that data is not included in exported files.']] },
    { area: ['트랙 볼륨 · 팬 · 음소거 · 솔로 · EQ', 'Track volume · pan · mute · solo · EQ'], status: 'supported', text: [['Global View 믹서와 ', 'Adjust them in the Global View mixer and in '], c('sound.trackEq'), ' · ', c('sound.masterEq'), ['에서 조절합니다. 반주와 악보 소리는 같은 시계로 재생됩니다.', '. The backing track and the score play on the same clock.']] },
    { area: ['반주 동기화 중 고정 템포', 'Fixed tempo during backing sync'], status: 'unsupported', text: [['반주 동기화가 켜져 있으면 ', 'While backing sync is on, '], c('practice.fixedBpm'), ['은 비활성입니다. 고정 템포를 쓰려면 동기화를 끕니다.', ' is disabled. Turn sync off to use a fixed tempo.']] },
  ] },
  { id: 'defaults', title: ['설명서에 없어 앱 기본값으로 정한 동작', 'Behaviour not covered by the manual, decided as app defaults'], rows: [
    { area: ['Esc 후 반복', 'Loop after Esc'], status: 'default', text: [c('selection.clear'), ['는 선택을 지웁니다. 반복이 켜진 채라면 다음 재생은 곡 전체를 반복합니다.', ' clears the selection. If Loop stays on, the next playback loops the whole song.']] },
    { area: ['반복 끄기', 'Turning Loop off'], status: 'default', text: [c('sound.loop'), ['을 끄면 현재 재생은 곡 끝까지 이어지고 선택은 유지됩니다.', ' turned off lets the current playback continue to the end of the song and keeps the selection.']] },
    { area: ['선택 구간 안의 반복 기호', 'Repeat signs inside the selection'], status: 'default', text: [['선택 구간 연습은 그 안의 반복·엔딩·진행 기호를 무시하고 한 번 선형으로 연주합니다. 곡 전체 재생은 기호를 따릅니다. "악보 반복 따르기" 옵션으로 바꿀 수 있습니다.', 'Selection practice ignores repeats, endings and directions inside the range and plays it once, linearly. Whole-song playback follows them. The "Follow score repeats" option changes this.']] },
    { area: ['반복 중 구간 밖 클릭', 'Clicking outside the range while looping'], status: 'default', text: [['편집 커서만 옮겨지고 재생은 구간 안에 머뭅니다. 새로 드래그하거나 선택을 지워야 구간이 바뀝니다.', 'Only the edit cursor moves; playback stays inside the range. Drag a new range or clear the selection to change it.']] },
    { area: ['반복 중 탐색', 'Seeking while looping'], status: 'default', text: [['구간 밖으로 이동 요청은 구간 경계로 고정됩니다. ', 'A seek outside the range is clamped to its boundary. '], c('sound.stop'), ['은 구간 시작으로 돌아갑니다.', ' returns to the start of the range.']] },
    { area: ['Windows 명령 팔레트 키', 'Windows command palette key'], status: 'default', text: [['macOS는 ⌘E, Windows 키맵은 Ctrl+E를 씁니다.', 'macOS uses ⌘E; the Windows keymap uses Ctrl+E.']] },
    { area: ['음 길이 바꾸기와 채우기', 'Changing duration and filling'], status: 'default', text: [['길이를 늘리면 바로 뒤의 쉼표만 흡수하고, 마디를 넘치면 다음 마디로 붙임줄로 나뉩니다. 다른 음과 겹치면 명령이 거부됩니다.', 'Lengthening absorbs only the rest immediately after; overflowing a bar splits into the next bar with a tie. Overlapping another note rejects the command.']] },
  ] },
  { id: 'excluded', title: ['제공하지 않는 기능', 'Features not provided'], rows: [
    { area: ['mySongBook · 클라우드 계정 · 협업', 'mySongBook · cloud accounts · collaboration'], status: 'unsupported', text: [['온라인 서비스가 없습니다. 모든 기능은 로컬 파일로 동작합니다.', 'There is no online service. Everything works on local files.']] },
    { area: ['VST / AU 플러그인 · 외부 MIDI 하드웨어 · Line-in 앰프 모델링', 'VST / AU plug-ins · external MIDI hardware · line-in amp modelling'], status: 'unsupported', text: [['지원하지 않으며 메뉴에도 없습니다. 튜너 마이크 입력과 앱 내 EQ는 제공합니다.', 'Not supported and absent from the menus. Tuner microphone input and in-app EQ are provided.']] },
    { area: ['원본 프로그램과 같은 픽셀 단위 악보 배치', 'Pixel-identical score layout to the original program'], status: 'unsupported', text: [['기보 엔진이 다르므로 줄 바꿈·간격이 다를 수 있습니다. ', 'The engraving engine differs, so line breaks and spacing may differ. Adjust them with '], c('view.lineBreak'), ' · ', c('view.beatSpacing'), ['으로 직접 조정합니다.', '.']] },
    { area: ['Windows · Linux 실행', 'Running on Windows · Linux'], status: 'unverified', text: [['이 빌드는 macOS(Apple Silicon)에서 검증했습니다. 다른 운영체제에서 동작을 확인하지 않았습니다.', 'This build was verified on macOS (Apple Silicon). Behaviour on other operating systems has not been checked.']] },
  ] },
];

const isCommand = (inline: SourceInline): inline is { readonly command: string } => typeof inline === 'object' && !Array.isArray(inline);

export function helpContent(language: Language = getLanguage()): HelpContent {
  const text = (value: Text): string => typeof value === 'string' ? value : pick(value, language);
  const inline = (value: SourceInline): HelpInline => isCommand(value) ? value : text(value);
  return {
    intro: text(introSource),
    guideTopics: guideSource.map(topic => ({ id: topic.id, title: text(topic.title), paragraphs: topic.paragraphs.map(paragraph => paragraph.map(inline)) })),
    compatibilityGroups: compatibilitySource.map(group => ({ id: group.id, title: text(group.title),
      rows: group.rows.map(row => ({ area: text(row.area), status: row.status, text: row.text.map(inline) })) })),
    statusLabels: { supported: text(statusLabelSource.supported), unsupported: text(statusLabelSource.unsupported),
      unverified: text(statusLabelSource.unverified), default: text(statusLabelSource.default) },
  };
}

export const helpCommandReferences = (): readonly string[] => {
  const ids = new Set<string>();
  const collect = (inlines: readonly SourceInline[]): void => { for (const inline of inlines) if (isCommand(inline)) ids.add(inline.command); };
  for (const topic of guideSource) for (const paragraph of topic.paragraphs) collect(paragraph);
  for (const group of compatibilitySource) for (const row of group.rows) collect(row.text);
  return [...ids];
};
