# Fretline 단축키

이 표는 `src/renderer/commands/catalog.ts`와 `keymap.ts`에서 `shortcutsMarkdown()`으로 생성한다. 손으로 고치지 말고
`bun -e "import { shortcutsMarkdown } from './src/renderer/help/shortcuts'; await Bun.write('docs/shortcuts.md', shortcutsMarkdown())"`로 다시 만든다.
앱 안의 도움말 > 단축키 탭은 같은 목록을 현재 플랫폼 기준으로 보여 주고, 각 행에서 명령을 바로 실행할 수 있다.

키가 없는 행은 메뉴·명령 팔레트(⌘E / Ctrl+E)로만 실행한다. 재생 중에는 `playback` 문맥의 키만 듣고, 입력 필드와 대화상자 안에서는 악보 명령 키가 전달되지 않는다.
Windows 열은 키맵 데이터이며 Windows 실행 검증을 뜻하지 않는다.

## 파일 (File)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 새 악보 | `file.new` | ⌘N | Ctrl+N |
| 열기 | `file.open` | ⌘O | Ctrl+O |
| 템플릿 | `file.templates` | 메뉴 | 메뉴 |
| 최근 문서 | `file.recent` | 메뉴 | 메뉴 |
| 저장 | `file.save` | ⌘S | Ctrl+S |
| 다른 이름으로 저장 | `file.saveAs` | ⇧⌘S | Ctrl+Shift+S |
| 문서 닫기 | `file.close` | ⌘W | Ctrl+W |
| 모든 문서 닫기 | `file.closeAll` | ⇧⌘W | Ctrl+Shift+W |
| 복구 | `file.recovery` | 메뉴 | 메뉴 |
| 편집 가능한 사본으로 변환 | `file.editableCopy` | 메뉴 | 메뉴 |
| GP 파일(.gp) 내보내기 | `file.export.gp` | 메뉴 | 메뉴 |
| MusicXML 내보내기 | `file.export.musicxml` | 메뉴 | 메뉴 |
| MIDI 내보내기 | `file.export.midi` | 메뉴 | 메뉴 |
| alphaTex 내보내기 | `file.export.alphatex` | 메뉴 | 메뉴 |
| 원본 파일(바이트 그대로) 내보내기 | `file.export.original` | 메뉴 | 메뉴 |
| PDF 내보내기 | `file.export.pdf` | 메뉴 | 메뉴 |
| PNG 이미지 내보내기 | `file.export.png` | 메뉴 | 메뉴 |
| SVG 이미지 내보내기 | `file.export.svg` | 메뉴 | 메뉴 |
| WAV 오디오 내보내기 | `file.export.wav` | 메뉴 | 메뉴 |
| 트랙별 WAV 내보내기 | `file.export.stems` | 메뉴 | 메뉴 |
| MusicXML 가져오기 | `file.import.musicxml` | 메뉴 | 메뉴 |
| MIDI 가져오기 | `file.import.midi` | 메뉴 | 메뉴 |
| 인쇄 | `file.print` | ⌘P | Ctrl+P |
| 페이지 설정 | `file.pageSetup` | 메뉴 | 메뉴 |
| Fretline 종료 | `file.quit` | ⌘Q | Alt+F4 |

## 편집 (Edit)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 실행 취소 | `edit.undo` | ⌘Z | Ctrl+Z |
| 다시 실행 | `edit.redo` | ⇧⌘Z | Ctrl+Y |
| 복사 | `edit.copy` | ⌘C | Ctrl+C |
| 잘라내기 | `edit.cut` | ⌘X | Ctrl+X |
| 붙여넣기 | `edit.paste` | ⌘V | Ctrl+V |
| 특수 붙여넣기 | `edit.specialPaste` | ⇧⌘V | Ctrl+Shift+V |
| 모든 트랙 복사 | `edit.copyAllTracks` | ⇧⌘C | Ctrl+Shift+C |
| 모든 트랙 잘라내기 | `edit.cutAllTracks` | ⇧⌘X | Ctrl+Shift+X |
| 현재 트랙 전체 선택 | `selection.all` | ⌘A | Ctrl+A |
| 선택 해제 | `selection.clear` | Esc | Esc |
| 왼쪽으로 이동 | `navigate.left` | ← | ← |
| 왼쪽으로 선택 확장 | `selection.left` | ⇧← | Shift+← |
| 오른쪽으로 이동 | `navigate.right` | → | → |
| 오른쪽으로 선택 확장 | `selection.right` | ⇧→ | Shift+→ |
| 위으로 이동 | `navigate.up` | ↑ | ↑ |
| 위으로 선택 확장 | `selection.up` | ⇧↑ | Shift+↑ |
| 아래으로 이동 | `navigate.down` | ↓ | ↓ |
| 아래으로 선택 확장 | `selection.down` | ⇧↓ | Shift+↓ |
| 다음 보표 | `navigate.nextStaff` | Tab | Tab |
| 이전 보표 | `navigate.previousStaff` | ⇧Tab | Shift+Tab |

## 트랙 (Track)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 트랙 추가 | `track.add` | ⌥⌘N | Ctrl+Shift+Insert |
| 트랙 삭제 | `track.delete` | ⌥⌘R | Delete |
| 트랙 복제 | `track.copy` | 메뉴 | 메뉴 |
| 튜닝 | `track.tuning` | 메뉴 | 메뉴 |
| 카포 | `track.capo` | 메뉴 | 메뉴 |
| 악기 | `track.instrument` | 메뉴 | 메뉴 |
| 이조 | `track.transpose` | 메뉴 | 메뉴 |
| 드럼 트랙 | `track.drums` | 메뉴 | 메뉴 |
| 다음 트랙 | `track.next` | ⌘↓ | Ctrl+↓ |
| 이전 트랙 | `track.previous` | ⌘↑ | Ctrl+↑ |

## 마디 (Bar)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 마디 삽입 | `bar.insert` | ⌘+ | Insert |
| 마디 삭제 | `bar.delete` | ⌃- | Ctrl+Delete |
| 박자표 | `bar.meter` | ⌘T | Ctrl+T |
| 조표 | `bar.key` | ⌘K | Ctrl+K |
| 템포 | `bar.tempo` | 메뉴 | 메뉴 |
| 반복 시작 | `bar.repeatOpen` | [ | [ |
| 반복 끝 | `bar.repeatClose` | ] | ] |
| 다른 엔딩 | `bar.endings` | 메뉴 | 메뉴 |
| 진행 기호 | `bar.directions` | D | D |
| 못갖춘마디 | `bar.pickup` | 메뉴 | 메뉴 |
| 자유 박자 | `bar.freeTime` | | | | |
| 마디 재분할 | `bar.rebar` | 메뉴 | 메뉴 |

## 음표 (Note)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 프렛 0 | `note.fret.0` | 0 | 0 |
| 프렛 1 | `note.fret.1` | 1 | 1 |
| 프렛 2 | `note.fret.2` | 2 | 2 |
| 프렛 3 | `note.fret.3` | 3 | 3 |
| 프렛 4 | `note.fret.4` | 4 | 4 |
| 프렛 5 | `note.fret.5` | 5 | 5 |
| 프렛 6 | `note.fret.6` | 6 | 6 |
| 프렛 7 | `note.fret.7` | 7 | 7 |
| 프렛 8 | `note.fret.8` | 8 | 8 |
| 프렛 9 | `note.fret.9` | 9 | 9 |
| 음 길이 줄이기 | `note.durationShorter` | +, = | +, = |
| 음 길이 늘리기 | `note.durationLonger` | -, _ | -, _ |
| 쉼표 | `note.rest` | R | R |
| 음표 삭제 | `note.delete` | ⌫ | ⌫ |
| 부점 | `note.dot` | . | . |
| 박 삽입 | `note.insertBeat` | ⌃+ | Ctrl+Insert |
| 밀어내기 편집 | `note.ripple` | 메뉴 | 메뉴 |
| 붙임줄 | `note.tie` | L | L |
| 잇단음표 | `note.tuplet` | / | / |
| 꾸밈음 | `note.grace` | G | G |
| 박 위 꾸밈음 | `note.graceOnBeat` | ⌥G | Ctrl+Alt+G |
| 박 붙임줄 | `note.tieBeat` | ⇧L | Shift+L |
| 성부 이동 | `note.moveVoice` | 메뉴 | 메뉴 |
| 다성부 편집 | `note.multivoice` | ⌘M | Ctrl+M |
| 성부 1 | `note.voice.1` | ⌘1 | Ctrl+1 |
| 성부 2 | `note.voice.2` | ⌘2 | Ctrl+2 |
| 성부 3 | `note.voice.3` | ⌘3 | Ctrl+3 |
| 성부 4 | `note.voice.4` | ⌘4 | Ctrl+4 |

## 효과 (Effects)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 벤드 | `effects.bend` | B | B |
| 해머온 / 풀오프 | `effects.hammerPull` | H | H |
| 슬라이드 | `effects.slide` | S | S |
| 팜 뮤트 | `effects.palmMute` | P | P |
| 데드 노트 | `effects.dead` | X | X |
| 하모닉스 | `effects.harmonic` | Y | Y |
| 비브라토 | `effects.vibrato` | V | V |
| 렛 링 | `effects.letRing` | I | I |
| 태핑 | `effects.tap` | ) | ) |
| 슬랩 | `effects.slap` | $ | $ |
| 팝 | `effects.pop` | 메뉴 | 메뉴 |
| 악센트 | `effects.accent` | ; | ; |
| 스타카토 | `effects.staccato` | ! | ! |
| 트릴 | `effects.trill` | N | N |
| 페이드 인 | `effects.fadeIn` | < | < |
| 페이드 아웃 | `effects.fadeOut` | > | > |
| 브러시 다운 | `effects.brushDown` | ⌘D | Ctrl+D |
| 다운 피킹 | `effects.pickDown` | ⇧D | Shift+D |
| 라스게아도 | `effects.rasgueado` | ⇧R | Shift+R |
| 운지 표시 | `effects.fingering` | 메뉴 | 메뉴 |
| 서스테인 페달 | `effects.sustainPedal` | 메뉴 | 메뉴 |
| 음표 오디오 설정 | `effects.audioSettings` | ⇧F | Shift+F |
| 트레몰로 피킹 | `effects.tremoloPicking` | 메뉴 | 메뉴 |
| 트레몰로 바 | `effects.tremoloBar` | 메뉴 | 메뉴 |
| 고스트 노트 | `effects.ghost` | O | O |
| 레가토 | `effects.legato` | ⇧H | Shift+H |
| 브러시 업 | `effects.brushUp` | 메뉴 | 메뉴 |
| 업 피킹 | `effects.pickUp` | ⇧U | Shift+U |
| 박 팜 뮤트 | `effects.palmMuteBeat` | ⇧P | Shift+P |

## 섹션 (Section)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 섹션 표시 | `section.edit` | ⌥⌘+ | Shift+Insert |
| 다음 섹션 | `section.next` | ⌥⌘→ | Ctrl+Alt+→ |
| 이전 섹션 | `section.previous` | ⌥⌘← | Ctrl+Alt+← |
| 텍스트 | `section.text` | T | T |
| 가사 | `section.lyrics` | 메뉴 | 메뉴 |
| 코드 | `section.chord` | A | A |
| 자동화 | `section.automation` | F10 | F10 |

## 도구 (Tools)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 명령 팔레트 | `tools.commandPalette` | ⌘E | Ctrl+E |
| 악기 보기 | `tools.instrument` | 메뉴 | 메뉴 |
| 튜너 | `tools.tuner` | 메뉴 | 메뉴 |
| 코드 도구 | `tools.chord` | 메뉴 | 메뉴 |
| 스케일 도구 | `tools.scale` | 메뉴 | 메뉴 |
| 설정 | `tools.preferences` | ⌘, | Ctrl+, |

## 사운드 (Sound)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 재생 / 일시정지 | `sound.playPause` | Space | Space |
| 구간 반복 | `sound.loop` | F9 | F9 |
| 처음부터 재생 | `sound.playFromBeginning` | ⇧Space | Ctrl+Space |
| 한 박 뒤로 | `sound.stepBackward` | ⌥← | Alt+← |
| 한 박 앞으로 | `sound.forward` | ⌥→ | Alt+→ |
| 되감기 | `sound.rewind` | ⌘← | Ctrl+← |
| 빨리 감기 | `sound.fastForward` | ⌘→ | Ctrl+→ |
| 속도 높이기 | `sound.speedUp` | +, = | +, = |
| 속도 낮추기 | `sound.speedDown` | -, _ | -, _ |
| 정지 | `sound.stop` | 메뉴 | 메뉴 |
| 위치 이동 | `sound.seek` | 메뉴 | 메뉴 |
| 음표 미리 듣기 | `sound.audition` | 메뉴 | 메뉴 |
| 자동 스크롤 재개 | `sound.resumeFollow` | 메뉴 | 메뉴 |
| 음소거 | `sound.mute` | 메뉴 | 메뉴 |
| 솔로 | `sound.solo` | 메뉴 | 메뉴 |
| 볼륨 | `sound.volume` | 메뉴 | 메뉴 |
| 팬 | `sound.pan` | 메뉴 | 메뉴 |
| 포커스 | `sound.focus` | 메뉴 | 메뉴 |
| 트랙 EQ | `sound.trackEq` | 메뉴 | 메뉴 |
| 마스터 EQ | `sound.masterEq` | 메뉴 | 메뉴 |
| 재생 속도 | `practice.relativeSpeed` | 메뉴 | 메뉴 |
| 고정 템포 | `practice.fixedBpm` | 메뉴 | 메뉴 |
| 속도 훈련 | `practice.trainer` | 메뉴 | 메뉴 |
| 메트로놈 | `practice.metronome` | 메뉴 | 메뉴 |
| 카운트인 | `practice.countIn` | 메뉴 | 메뉴 |
| 반주 가져오기 | `backing.import` | 메뉴 | 메뉴 |
| 파형 표시 | `backing.waveform` | 메뉴 | 메뉴 |
| 동기점 | `backing.anchors` | 메뉴 | 메뉴 |
| 반주 오프셋 | `backing.offset` | 메뉴 | 메뉴 |
| 반주 동기화 | `backing.sync` | 메뉴 | 메뉴 |
| 반주 볼륨 | `backing.gain` | 메뉴 | 메뉴 |
| 반주 음소거 | `backing.mute` | 메뉴 | 메뉴 |

## 보기 (View)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 편집 팔레트 | `view.palette` | F2 | F2 |
| 멀티트랙 | `view.multitrack` | F3 | F3 |
| Song 검사기 | `view.songInspector` | F5 | F5 |
| Track 검사기 | `view.trackInspector` | F6 | F6 |
| 스타일시트 | `view.stylesheet` | F7 | F7 |
| Global View | `view.globalView` | F8 | F8 |
| 확대 | `view.zoomIn` | ⌘> | Ctrl++ |
| 축소 | `view.zoomOut` | ⌘< | Ctrl+- |
| 기보 방식 | `view.notation` | 메뉴 | 메뉴 |
| 음자리표 | `view.clef` | 메뉴 | 메뉴 |
| 임시표 표기 | `view.spelling` | 메뉴 | 메뉴 |
| 예방 임시표 | `view.courtesyAccidental` | 메뉴 | 메뉴 |
| 페이지 보기 | `view.page` | 메뉴 | 메뉴 |
| 가로 보기 | `view.horizontal` | 메뉴 | 메뉴 |
| 파트 보기 | `view.part` | 메뉴 | 메뉴 |
| 전체 악보 | `view.fullScore` | 메뉴 | 메뉴 |
| 디자인 모드 | `view.design` | ⌃⌥D | Ctrl+Alt+D |
| 줄 바꿈 | `view.lineBreak` | ⌘↩ | Ctrl+↩ |
| 박 간격 | `view.beatSpacing` | 메뉴 | 메뉴 |
| 악보 설정 | `view.scoreSettings` | 메뉴 | 메뉴 |

## 윈도우 (Window)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 최소화 | `window.minimize` | 메뉴 | 메뉴 |
| 전체 화면 | `window.fullscreen` | F11 | F11 |

## 도움말 (Help)

| 명령 | ID | macOS | Windows |
| --- | --- | --- | --- |
| 사용 설명서 | `help.guide` | 메뉴 | 메뉴 |
| 단축키 | `help.shortcuts` | 메뉴 | 메뉴 |
| 호환성 | `help.compatibility` | 메뉴 | 메뉴 |
| Fretline 정보 | `help.about` | 메뉴 | 메뉴 |
