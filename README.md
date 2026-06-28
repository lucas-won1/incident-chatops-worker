# incident-chatops-worker

`incident-chatops-worker`는 Sentry 이슈를 주기적으로 확인하고, Slack에서 사람의 승인을 받은 뒤에만 분석 또는 GitLab Merge Request 작업을 실행하는 로컬 우선 ChatOps 워커입니다.

이 저장소의 공개 진입점은 README입니다. README는 설치와 첫 실행, 안전 기본값, 문서 맵을 빠르게 안내하고, 세부 운영/설계 설명은 `docs/` 문서로 나눕니다.

## 프로젝트 위치

- 로컬 우선 운영 모델입니다. 공개 인바운드 서버나 호스팅 제어면 없이, 사용자가 소유한 노트북 또는 내부 호스트에서 headless daemon으로 실행합니다.
- Sentry 감지는 polling 기반입니다. 기본 주기는 `SENTRY_POLL_INTERVAL_SECONDS=300`이며 `.env`에서 조정합니다.
- Slack Socket Mode가 사람과 만나는 UI입니다. 워커는 Slack thread에 incident를 올리고, 분석 또는 수정 작업은 Slack approval 이후에만 진행합니다.
- 상태와 감사 로그는 로컬 SQLite에 저장합니다. 기본 경로는 `.env`의 `STATE_DB_PATH`로 정합니다.
- MVP의 MR 공급자는 GitLab입니다. MVP는 `no webhook default`이며, Sentry webhook, GitHub provider, GUI, hosted control plane, live-token QA는 현재 지원 범위가 아닙니다.

## MVP와 비목표

MVP는 다음 흐름에 집중합니다.

1. Sentry polling이 새 이슈 또는 갱신된 이슈를 찾습니다.
2. Slack root thread에 incident 요약과 승인 버튼을 게시합니다.
3. 사용자가 Slack에서 분석 또는 수정/MR 작업을 승인합니다.
4. runner가 허용된 로컬 repo/worktree 안에서 작업합니다.
5. 검증이 끝난 뒤 GitLab Merge Request를 만들고 Slack thread에 결과를 남깁니다.

다음은 의도적으로 제외합니다.

- 감지 즉시 자동 수정
- 공개 HTTP ingress 또는 webhook 기본 운영
- GitHub MR/PR 공급자
- 웹 GUI 또는 대시보드
- 실제 토큰이 필요한 공개 QA 예시
- allowlist를 우회하는 broad shell wrapper

## Quick Start

1. 의존성을 설치하고 빌드합니다.

```bash
pnpm install
pnpm build
```

2. 예시 파일을 복사합니다. `.env`에는 로컬 secret과 운영 env 값을 넣고, YAML에는 secret이 아닌 정책만 둡니다.

```bash
cp .env.example .env
cp incident-worker.config.example.yaml incident-worker.config.yaml
```

3. 로컬 설정을 검사합니다.

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

4. Sentry polling을 한 번만 실행합니다.

```bash
node dist/cli.js run-once --source sentry --env-file .env --config incident-worker.config.yaml
```

5. 지속 실행 daemon을 시작합니다.

```bash
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml
```

CLI의 공개 command 목록은 다음과 같습니다.

- `daemon`: 로컬 워커 daemon을 시작합니다.
- `doctor`: 로컬 전제 조건과 설정을 검사합니다.
- `status`: 워커 상태를 출력합니다.
- `run-once`: 워커 사이클을 한 번 실행합니다.
- `logs`: 로컬 audit log를 출력합니다.
- `dev`: 개발/문서 검증 보조 명령을 실행합니다.

## Slack Setup

Slack app은 Socket Mode와 Interactivity를 사용합니다. 공개 request URL은 필요하지 않습니다.

필수 설정은 다음과 같습니다.

- Socket Mode를 켜고 `connections:write` scope가 있는 app-level token을 `SLACK_APP_TOKEN`에 둡니다.
- 메시지 게시를 위해 `chat:write`가 있는 bot token을 `SLACK_BOT_TOKEN`에 둡니다.
- 워커가 게시할 incident channel에 app을 초대합니다. channel 이름으로 라우팅한다면 channel 조회 권한이 필요할 수 있습니다.
- Interactivity를 켭니다. 현재 adapter는 `incident.`로 시작하는 Slack block action을 처리합니다.
- 현재 MVP는 Slack event 구독으로 incident를 감지하지 않습니다. 감지는 Sentry polling에서 시작합니다.

핵심 규칙은 Slack approval입니다. detection은 버튼을 게시할 뿐이며, 분석 실행, 수정 실행, branch push, GitLab Merge Request 생성은 명시적인 Slack 승인 이후에만 진행됩니다.

## 설정 파일

`.env.example`은 secret과 운영 env 값의 목록입니다.

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- `SENTRY_AUTH_TOKEN`
- `GITLAB_TOKEN`
- `SENTRY_BASE_URL`
- `SENTRY_POLL_INTERVAL_SECONDS`
- `SENTRY_POLL_MIN_INTERVAL_SECONDS`
- `STATE_DB_PATH`

`incident-worker.config.example.yaml`은 secret이 아닌 정책의 예시입니다.

- `sentry.projects`: Sentry organization/project와 Slack channel 매핑
- `repos.allowlist`: 작업을 허용할 로컬 repository 절대 경로
- `worktree.root`: 임시 worktree를 둘 로컬 디렉터리
- `branch.prefix`: incident branch prefix
- `slack.channels`: 기본 channel과 project별 routing
- `runners.genericCommandAllowlist`: generic runner가 실행할 수 있는 command allowlist
- `runners.definitions`: runner 정의
- `mr`: GitLab MR provider 정책과 기본 target branch

secret은 env-only입니다. YAML에 token처럼 보이는 값이 들어가면 설정 검증에서 거부됩니다.

## 문서 맵

- [아키텍처](docs/architecture.md): component map, Sentry polling부터 Slack thread, runner, worktree, GitLab MR까지의 흐름
- [설정](docs/configuration.md): `.env.example`과 `incident-worker.config.example.yaml` 필드별 설명
- [보안](docs/security.md): 로컬 우선 모델, Slack approval, allowlist, redaction, prompt injection 대응
- [연동](docs/integrations.md): Slack Socket Mode, Sentry polling, GitLab, runner adapter 경계
- [운영](docs/operations.md): daemon, run-once, status, logs, doctor, launchd, SQLite state 운영
- [문제 해결](docs/troubleshooting.md): 설정 실패, Slack 버튼, Sentry polling, repo/runner/MR 오류 대응

## 보안 기본값

- 감지 즉시 자동 수정하지 않습니다. Slack approval이 필요합니다.
- repository는 `repos.allowlist` 안의 절대 경로만 허용합니다.
- branch는 설정된 `branch.prefix`를 따라야 합니다.
- generic runner command는 `runners.genericCommandAllowlist`에 있어야 합니다.
- runner output, audit entry, log, Slack message에는 secret redaction을 적용합니다.
- Sentry 제목, stack trace, Slack message, 외부 댓글은 모두 untrusted input입니다. prompt injection이 가능하다고 보고 runner prompt와 command 경계를 분리합니다.
- 감사 기록은 로컬 SQLite에 남기며 `node dist/cli.js logs --db <state-db-path>`로 확인합니다.
- 실제 token, auth header, private org/project/repo 이름, private log를 공개 문서나 evidence에 넣지 않습니다.

## 운영 명령

한 번 실행:

```bash
node dist/cli.js run-once --source sentry --env-file .env --config incident-worker.config.yaml
```

지속 실행:

```bash
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml
```

상태 확인:

```bash
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
```

감사 로그 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

로컬 설정 검사:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

## launchd 예시

macOS에서 계속 실행하려면 checkout 경로와 env/config 경로를 절대 경로로 지정합니다. secret 값은 plist에 직접 쓰지 말고 `.env` 파일에 둡니다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.incident-chatops-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/example/incident-chatops-worker/dist/cli.js</string>
    <string>daemon</string>
    <string>--env-file</string>
    <string>/Users/example/incident-chatops-worker/.env</string>
    <string>--config</string>
    <string>/Users/example/incident-chatops-worker/incident-worker.config.yaml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/example/incident-chatops-worker</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

로드와 재시작:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.incident-chatops-worker.plist
launchctl kickstart -k gui/$(id -u)/local.incident-chatops-worker
```

## 검증 명령

공개 문서와 범위 guardrail을 확인합니다.

```bash
node dist/cli.js dev validate-docs
node dist/cli.js dev verify-scope --strict
```

README quick start 회귀 테스트:

```bash
pnpm exec vitest run tests/docs/readme-quick-start.test.ts
```

## 문제 해결

- `doctor`가 env 누락을 보고하면 `.env.example`의 모든 key가 `.env`에 있는지 확인합니다.
- polling이 너무 잦으면 `SENTRY_POLL_INTERVAL_SECONDS`를 `300` 이상으로 둡니다. 더 낮은 값은 최소 주기 정책에 의해 거부될 수 있습니다.
- Slack 버튼이 동작하지 않으면 Socket Mode, Interactivity, app 설치 channel을 확인합니다.
- repo가 거부되면 의도한 절대 경로만 `repos.allowlist`에 추가합니다.
- runner가 거부되면 executable 이름이 `runners.genericCommandAllowlist`에 있는지 확인하고 argument는 명시적으로 둡니다.
- GitLab Merge Request 생성이 실패하면 token 권한, target branch, project 권한을 확인합니다. token 값은 출력하지 않습니다.
