# Ruler Board — 두 단계 눈금 진행판 (Claude Code 플러그인)

큰 일을 **큰 눈금**(M1, M2 …)으로 나누고, 각 큰 눈금을 **작은 눈금**(M1.1, M1.2 …)으로 쪼개 진행률을 봅니다.
Claude Code 세션은 MCP 도구 8개로 계획·진행·막힘·승인 요청을 기록하고, 훅은 모델 토큰 없이 활동을 기록합니다.
로컬 웹 진행판에서 퍼센트 진행률·승인 대기열·에이전트 관계도·최근 이벤트를 보고, 승인 버튼을 누를 수 있습니다.

- 의존성 없음: `node` 18 이상만 있으면 됩니다.
- 원본은 추가만 하는 로그(JSONL). 상태는 늘 로그에서 다시 계산합니다.
- 로컬 전용: 진행판은 `127.0.0.1`에만 열립니다. 외부 전송 없음.

## 설치

Claude Code 안에서 두 줄:

```
/plugin marketplace add luk-e-lab/ruler-board
/plugin install ruler-board@ruler-board
```

저장소를 내려받아 쓰거나 고쳐 보려면 폴더 경로로 마켓플레이스를 추가합니다(Claude Code CLI `claude plugin marketplace add <경로>`. 데스크톱 앱의 마켓플레이스 추가 창은 https 주소만 받습니다).

```
claude plugin marketplace add C:/path/to/ruler-board
claude plugin install ruler-board@ruler-board
```

설치하면 MCP 서버 `ruler`와 훅(SessionStart·UserPromptSubmit·PostToolUse·Stop·SubagentStop)이 함께 켜집니다.
진행판 주소는 `ruler_status` 첫 줄에 나옵니다. 기본은 **http://127.0.0.1:47810**이고, 그 포트를 다른 프로그램이 쓰고 있으면 알아서 다음 빈 포트를 고릅니다. 먼저 뜬 세션 하나가 맡고, 그 세션이 끝나면 다른 세션이 이어받습니다.

플러그인을 못 쓰는 환경이면 프로젝트의 `.mcp.json`에 직접 넣습니다(이 경우 훅은 빠집니다).

```json
{ "mcpServers": { "ruler": { "command": "node", "args": ["C:/path/to/ruler-board/server/mcp.js"] } } }
```

## 쓰는 사람별 설정

| 경우 | 할 일 |
|---|---|
| 계정 하나, PC 하나 | 아무것도 안 함. 데이터는 `%APPDATA%\ruler`(Windows) 또는 `~/.config/ruler` |
| 한 PC에서 계정 여러 개 | 아무것도 안 해도 계정이 자동으로 구분됩니다. 이름을 붙이려면 `config.json`에 `"accounts"` |
| PC 여러 대 | 각 PC의 `config.json`에 한 줄: `{ "home": "D:/OneDrive/ruler" }` (동기화 폴더) |

여러 PC는 서버 없이 동기화 폴더로 이어집니다. PC마다 `events/<pc>.jsonl`에만 쓰므로 동기화 충돌이 나지 않고, 읽을 때 모든 조각을 시간 순으로 합칩니다.

## config.json

위치: `%APPDATA%\ruler\config.json` (Windows) / `~/.config/ruler/config.json`. 모든 칸이 선택입니다.

```json
{
  "home": "D:/OneDrive/ruler",
  "pc": "desk",
  "port": 47810,
  "accounts": { "<계정 UUID 또는 짧은 id>": "개인" }
}
```

| 칸 | 뜻 | 기본값 |
|---|---|---|
| `home` | 데이터 폴더. 환경 변수 `RULER_HOME`이 우선 | 설정 폴더 자체 |
| `pc` | 이 PC 이름(로그 조각 파일 이름). `RULER_PC`가 우선 | 컴퓨터 이름 |
| `port` | 진행판 선호 포트. 쓰이고 있으면 다음 빈 포트로. `RULER_PORT`가 우선 | `47810` |
| `accounts` | 계정 별명. 키는 `CLAUDE_CODE_ACCOUNT_UUID` 또는 진행판에 보이는 짧은 id(8자리) | `계정 ab12` |

`home`을 옮겼다면 `<home>/config.json`도 읽습니다. 여러 PC가 같이 쓸 별명은 거기 두면 됩니다.

## 쓰는 법

- 큰 일: `ruler_plan`(큰 눈금 제안, 사용자 승인) → `ruler_split`(작은 눈금) → `ruler_tick`(doing/done/blocked).
- 결정이 필요하면 `ruler_ask` → 진행판에서 승인·거절 → 다음 도구 호출 때 훅이 결과를 그 세션에 한 번 전달합니다.
- `project`를 안 주면 현재 폴더 이름이 프로젝트입니다. `ruler_bind`는 선택(표시 이름·맡은 큰 눈금 연결).
- `ruler_tick`으로 작은 눈금을 시작하면, 같은 프로젝트에서 일하는 다른 세션(다른 계정 포함)이 답에 붙습니다.
- `ruler_status({account: "개인"})`로 특정 계정 것만 볼 수 있습니다.

진행판은 계정이 2개 이상일 때만 계정 칩·필터를, PC가 2대 이상일 때만 PC 이름을 보여 줍니다.

## 블록 추가하기

1. `web/blocks/<이름>.js`:

```js
Ruler.block('mine', {
  title: '내 블록',
  wide: false,                       // true면 가로 전체
  render({ S, P, el, esc, ago, LABEL, decide, chip, show, multi, pcTag }) {
    // S: /api/state 전체, P: 선택된 프로젝트, el: 그릴 곳
    // chip(account): 계정 칩(계정 2개 이상일 때만), show(account): 계정 필터 통과 여부
    const rows = S.feed.filter((f) => show(f.account)).slice(-5);
    el.innerHTML = rows.map((f) => `<p>${chip(f.account)} ${esc(f.k)} ${ago(f.t)}</p>`).join('') || '<p>없음</p>';
  },
});
```

2. `web/layout.json`의 `blocks`에 `"mine"`을 넣습니다(순서 = 화면 순서). 새로고침만 하면 됩니다.

## 개발

```
npm test            # 스모크(설정 없음·두 계정·두 PC·옛 로그) + 통합 데모, 네트워크 없음
npm run demo:keep   # 두 계정 데모를 띄워 두고 http://127.0.0.1:47806 에서 보기
```

계약: `schema/CONTRACT.md`.

## 한계

- 여러 PC의 이벤트는 각 PC 시계(`t`)로 정렬합니다. 시계가 크게 어긋나면 순서가 틀어질 수 있습니다.
- 동기화가 늦으면 다른 PC의 진행이 늦게 보입니다. 같은 눈금을 두 PC에서 동시에 바꾸면 나중 시각이 이깁니다.
- 진행판 포트는 PC당 하나입니다. 같은 PC에서 계정마다 `home`을 다르게 주면 먼저 뜬 쪽 데이터만 보입니다.
- MCP 서버가 세션 id를 환경에서 못 받으면(`proc-…`), 웹 승인 결과는 같은 계정·같은 프로젝트 세션에 전달됩니다.
- 훅은 도구를 쓸 때마다 Node를 한 번 띄우고 로그를 읽습니다. 로그가 아주 커지면 느려집니다.
- 작업 목록 동기화는 제목으로 맞춥니다. 제목을 바꾸면 새 작은 눈금으로 잡힙니다.

## 라이선스

MIT — [LICENSE](LICENSE). 만든 곳: [luk-e-lab](https://github.com/luk-e-lab).
