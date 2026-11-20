# Ruler 계약 v1.0 (lite)

함께 있는 파일: `event.schema.json`(로그 한 줄), `state.schema.json`(`GET /api/state`).

## 1. 원칙

- 원본은 **추가만 하는 이벤트 로그**. 상태는 언제나 로그를 처음부터 다시 읽어 리듀서로 계산한다. 상태 파일 없음.
- 쓰는 쪽(MCP 서버·훅)은 한 줄 append만 한다. 잠금 없음. 한 줄 4 KB 이하.
- 깨진 줄은 건너뛴다. 모르는 `k`·필드는 무시한다.
- 로컬 전용: HTTP는 `127.0.0.1`에만. 외부 전송 없음. Node 18+ 내장 모듈만.

## 2. 저장 위치

| 항목 | 값 |
|---|---|
| 기본 폴더 | Windows `%APPDATA%\ruler`, 그 밖 `$XDG_CONFIG_HOME/ruler` 또는 `~/.config/ruler` |
| 설정 | `<기본 폴더>/config.json`. `home`을 옮겼으면 `<home>/config.json`도 읽음(기본 폴더 쪽이 우선) |
| home | 환경 `RULER_HOME` > 설정 `home` > 기본 폴더 |
| 로그 조각 | `<home>/events/<pc>.jsonl` — **이 PC는 자기 조각에만 쓴다** |
| 옛 로그 | `<home>/events.jsonl` 있으면 읽기만 |
| 훅 오류 | `<home>/hook-errors.log` |

- `pc` = 환경 `RULER_PC` > 설정 `pc` > `os.hostname()`. 소문자, `[a-z0-9_-]` 밖은 `-`, 40자.
- 읽기: 모든 조각 + 옛 로그를 합쳐 `t` 순 **안정 정렬**(같은 시각은 옛 로그 → 조각 이름 순 → 파일 안 순서).
- ETag = 파일마다 `size-mtime`을 이은 값.
- home을 동기화 폴더(OneDrive·Dropbox·Syncthing)에 두면 여러 PC가 서버 없이 같은 판을 본다. 파일마다 쓰는 PC가 하나라 충돌이 없다.

설정 예:

```json
{ "home": "D:/OneDrive/ruler", "pc": "desk", "port": 47810,
  "accounts": { "<계정 UUID 또는 짧은 id>": "개인" } }
```

### 2-1. 진행판 포트

- 선호 포트 = `RULER_PORT` → config `port` → 47810. 거기서부터 20개를 차례로 본다.
- 포트에 `GET /api/ping`을 보내 `{app:"ruler", home, pc}`가 오고 home·pc가 같으면 이미 맡은 세션이 있는 것 → 띄우지 않고 `RULER_RETRY_MS`(기본 15초)마다 다시 봐서 그 세션이 끝나면 이어받는다.
- 그 밖(다른 프로그램, 다른 home의 ruler)이 쥐고 있으면 다음 포트로. 20개가 다 막히면 OS가 주는 빈 포트.
- 실제로 뜬 포트는 `<home>/board-<pc>.json` `{port, pid}`(PC마다 따로). pid가 죽었으면 없는 것으로 본다. `ruler_status` 첫 줄이 이 주소.

## 3. 신원

| 필드 | 정하는 법 |
|---|---|
| `account` | `CLAUDE_CODE_ACCOUNT_UUID`의 sha1 앞 8자리. 없으면 `local`. **어떤 계정도 쓰기를 막지 않는다** |
| 표시 이름 | 설정 `accounts`의 별명(키는 UUID 또는 짧은 id). 없으면 `계정 ab12`, `local`은 `기본` |
| `session` | `CLAUDE_CODE_HOST_SESSION_ID` > `CLAUDE_CODE_SESSION_ID` > 훅은 입력의 `session_id` > 프로세스별 `proc-<pid>-…` |
| `pc` | 2번 |
| 프로젝트 | 도구 인자 `project` > 이 프로세스가 마지막에 쓴 것 > 이 세션이 로그에 마지막으로 쓴 것 > `CLAUDE_PROJECT_DIR`(없으면 cwd)의 폴더 이름 |

## 4. 이벤트

모든 줄: `k`, `t`(ISO), `account`, `session`, `pc`. 선택: `p`(프로젝트), `a`(에이전트 표시 이름).

| k | 누가 | 필드 | 효과 |
|---|---|---|---|
| `plan` | 도구 | `majors[]`, `note?` | 큰 눈금 제안 → 승인 `A#`(kind=plan). 승인 전엔 반영 안 됨 |
| `ask` | 도구 | `text`, `target?` | 승인 요청 `A#`. target 눈금은 `approval` |
| `decide` | 도구·웹 | `id`, `ok`, `note?` | 승인·거절. plan 승인이면 큰 눈금 교체(같은 제목은 유지). 웹은 `a: "user(web)"` |
| `split` | 도구 | `major`, `add[]`, `drop[]` | 작은 눈금 추가/제외. 첫 쪼개기 뒤 추가분은 `grew` |
| `tick` | 도구 | `id`, `st`, `note?` | 상태 변경. 작은 눈금이 다 끝나면 큰 눈금 자동 완료 |
| `handoff` | 도구·훅 | `to`, `from?`, `note?`, `via` | 관계도 화살표. `via`: `ruler`/`message`/`session`/`agent` |
| `bind` | 도구 | `major?`, `cwd?` | 선택. 세션 ↔ 이름·프로젝트·큰 눈금 |
| `hplan` | 훅 | `items[]` 또는 `advance`/`done[]`/`start`/`wrap` | 세션 작업 목록 → bind된 큰 눈금의 작은 눈금으로 동기화 |
| `hook` | 훅 | `ev`, `tool?`, `info?`, `cwd?`, `notable?` | 활동 표시. 피드에는 `notable`만 |
| `deliv` | 훅 | `p`, `id` | 웹 결정을 요청 세션에 전달했음(한 번만) |

상태: `wait` `doing` `done` `blocked` `approval` (+ 작은 눈금 `dropped`).
id: 큰 눈금 `M1…`, 작은 눈금 `M1.1…`, 승인 `A1…` — 프로젝트 안 순번, 재사용 안 함.

## 5. 상태 (`GET /api/state`)

```
{ projects: { <id>: { id, majors[{id,title,st,minors[{id,title,st,agent,account,session}],total,done,grew}],
                      approvals[{id,kind,text,st,agent,account,session,...}], pending, cur, updated, proposed } },
  sessions: { <id>: { id, account, pc, agent?, project?, major?, cwd?, plan? } },
  agents:   { <name>: { name, account, pc, seen, tool, project, sessions[] } },
  accounts: { <id>: { id, name, seen } },
  pcs: [ "<pc>", … ],
  edges: [ { from, to, note, t, via, account } ],
  feed: [ 최근 200개, 각 항목에 who, notes[] ],
  last }
```

- `notes[].kind`(`major_done`/`blocked`/`approval`)만 알림 근거.
- 필드를 더하는 것은 자유, 지우거나 뜻을 바꾸는 것은 계약 변경.
- `POST /api/decide` `{project, id, ok, note}` — 헤더 `X-Ruler: 1` 필수(CSRF 막기).

## 6. MCP 도구 (서버 이름 `ruler`, stdio)

| 도구 | 필수 | 선택 | 답 |
|---|---|---|---|
| `ruler_plan` | `majors[]` | `project`, `agent`, `note` | `A# 승인대기 (<프로젝트>)` |
| `ruler_split` | `major` | `add[]`, `drop[]` | `M1: M1.1,M1.2…` |
| `ruler_tick` | `id`, `st` | `note` | `ok M1 2/3 doing` — 작은 눈금 `doing`이면 `여기서 일하는 다른 세션: …`(같은 프로젝트, 다른 세션·계정) |
| `ruler_ask` | `text` | `target` | `A# 승인대기 (…)` |
| `ruler_decide` | `id`, `ok` | `note` | `ok` — 사용자가 채팅에서 답했을 때만 |
| `ruler_handoff` | `to` | `note` | `ok` |
| `ruler_bind` | — | `project`, `agent`, `major` | `ok <프로젝트> …` — 선택 |
| `ruler_status` | — | `project`, `all`, `account`(id 또는 별명) | 요약 텍스트 |

`project`·`agent`는 한 번 주면 그 프로세스가 기억한다.

## 7. 훅

- 플러그인 `hooks/hooks.json`: `SessionStart`, `UserPromptSubmit`, `PostToolUse`(`*`), `Stop`, `SubagentStop` → `node hooks/hook.js`.
- 훅은 자기 PC 조각에 append만 하고 항상 exit 0. stdout은 비운다.
- 예외: 웹에서 결정된 승인은 요청한 세션(같은 `session`, 또는 서버가 `proc-…`였다면 같은 계정·같은 프로젝트 세션)의 다음 `PostToolUse`/`UserPromptSubmit`에서
  `hookSpecificOutput.additionalContext`로 `ruler: <p> A# 승인됨|거절됨 — 메모`를 한 번만 넣고 `deliv`를 쓴다.
- `mcp__…ruler…__ruler_*` 도구 호출은 서버가 이미 기록하므로 훅은 쓰지 않는다.
