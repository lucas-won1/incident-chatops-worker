# incident-chatops-worker

`incident-chatops-worker`는 Sentry 이슈를 주기적으로 확인하고, Slack에서 사람의 승인을 받은 뒤에만 분석 또는 Git provider MR/PR 작업을 실행하는 로컬 우선 ChatOps 워커입니다.

이 저장소의 공개 진입점은 README입니다. README는 설치와 첫 실행, 안전 기본값, 문서 맵을 빠르게 안내하고, 세부 운영/설계 설명은 `docs/` 문서로 나눕니다.

## 프로젝트 위치

- 로컬 우선 운영 모델입니다. 공개 인바운드 서버나 호스팅 제어면 없이, 사용자가 소유한 노트북 또는 내부 호스트에서 headless daemon으로 실행합니다.
- Sentry 감지는 polling 기반입니다. 기본 주기는 `SENTRY_POLL_INTERVAL_SECONDS=300`이며 `.env`에서 조정합니다.
- Slack Socket Mode가 사람과 만나는 UI입니다. 워커는 Slack thread에 incident를 올리고, 분석 또는 수정 작업은 Slack approval 이후에만 진행합니다.
- 상태와 감사 로그는 로컬 SQLite에 저장합니다. `STATE_DB_PATH`를 생략하면 OS별 durable state 경로를 자동으로 쓰고, `.env`에 `STATE_DB_PATH`를 두면 그 값이 자동 경로보다 우선합니다.
- MVP의 Git provider는 GitLab Merge Request와 GitHub Pull Request입니다. 둘 다 REST API를 직접 호출하며 `glab`, `gh`, provider CLI는 필요하지 않습니다. MVP는 `no webhook default`이며, Sentry webhook, GUI, hosted control plane, live-token QA는 현재 지원 범위가 아닙니다.

## MVP와 비목표

MVP는 다음 흐름에 집중합니다.

1. Sentry polling이 새 이슈 또는 갱신된 이슈를 찾습니다.
2. Slack root thread에 incident 요약과 승인 버튼을 게시합니다.
3. 사용자가 Slack에서 분석 또는 수정/MR 작업을 승인합니다.
4. runner가 허용된 로컬 repo/worktree 안에서 작업합니다.
5. 검증이 끝난 뒤 GitLab Merge Request 또는 GitHub Pull Request를 만들고 Slack thread에 결과를 남깁니다.
6. 수정 MR/PR이 만들어지면 후속 Codex App 작업에 필요한 handoff context를 로컬 SQLite에 저장합니다.

다음은 의도적으로 제외합니다.

- 감지 즉시 자동 수정
- 공개 HTTP ingress 또는 webhook 기본 운영은 지원하지 않습니다.
- 웹 GUI 또는 대시보드는 지원하지 않습니다.
- 실제 토큰이 필요한 공개 QA 예시
- allowlist를 우회하는 broad shell wrapper

Future Git provider TODOs:

- [ ] Bitbucket
- [ ] Gitea/Forgejo/Codeberg
- [ ] Azure DevOps Repos
- [ ] AWS CodeCommit
- [ ] Gerrit

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
- `mcp`: 저장된 incident handoff를 읽기 전용 MCP stdio server로 노출합니다.
- `dev`: 개발/문서 검증 보조 명령을 실행합니다.

## Slack Setup

Slack app은 Socket Mode와 Interactivity를 사용합니다. 공개 request URL은 필요하지 않습니다.

필수 설정은 다음과 같습니다.

- Socket Mode를 켜고 `connections:write` scope가 있는 app-level token을 `SLACK_APP_TOKEN`에 둡니다.
- 메시지 게시를 위해 `chat:write`가 있는 bot token을 `SLACK_BOT_TOKEN`에 둡니다.
- 워커가 게시할 incident channel에 app을 초대합니다. channel 이름으로 라우팅한다면 channel 조회 권한이 필요할 수 있습니다.
- Interactivity를 켭니다. 현재 adapter는 `incident.`로 시작하는 Slack block action을 처리합니다.
- 현재 MVP는 Slack event 구독으로 incident를 감지하지 않습니다. 감지는 Sentry polling에서 시작합니다.

핵심 규칙은 Slack approval입니다. detection은 버튼을 게시할 뿐이며, 분석 실행, 수정 실행, branch push, Git provider MR/PR 생성은 명시적인 Slack 승인 이후에만 진행됩니다.

## 설정 파일

`.env.example`은 secret과 운영 env 값의 목록입니다.

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- `SENTRY_AUTH_TOKEN`
- `GITLAB_TOKEN`
- `GITHUB_TOKEN`
- `SENTRY_BASE_URL`
- `SENTRY_POLL_INTERVAL_SECONDS`
- `SENTRY_POLL_MIN_INTERVAL_SECONDS`
- `STATE_DB_PATH` (선택 override; 생략하면 OS별 durable state 경로 자동 사용)

`incident-worker.config.example.yaml`은 secret이 아닌 정책의 예시입니다.

- `sentry.projects`: Sentry organization/project와 Slack channel 매핑
- `repos.allowlist`: 작업을 허용할 로컬 repository 절대 경로
- `worktree.root`: 임시 worktree를 둘 로컬 디렉터리
- `worktree.prepare`: runner 시작 전에 새 worktree에서 실행할 dependency bootstrap 명령
- `branch.prefix`: incident branch prefix
- `slack.channels`: 기본 channel과 project별 routing
- `runners.provider`: daemon이 사용할 runner provider (`codex`, `claude-code`, `generic`)
- `runners.codex`: Codex runner 설정. Codex provider는 `codex exec`만 사용합니다. `home`은 `CODEX_HOME` config/auth/session root이고, `bin`, `profile`, `model`, `outputRoot`는 실행 invocation override입니다. dev server smoke가 필요하면 `workspaceWriteNetworkAccess`를 켭니다.
- `runners.claudeCode`: Claude Code headless CLI 설정. `configDir`는 process config를 분리하지만 macOS Keychain login credential 저장소까지 항상 분리한다고 보장하지는 않습니다.
- `runners.generic`: generic runner mode command id, command allowlist, 정의
- `mr`: GitLab MR 또는 GitHub PR provider 정책과 기본 target branch

secret은 env-only입니다. YAML에 token처럼 보이는 값이 들어가면 설정 검증에서 거부됩니다.

## 분석, 수정, handoff 경로

`analysis_only`는 configured source repo path에서만 실행되는 읽기 전용 분석입니다. 시작 전에 source repo가 clean이어야 하고, worker git worktree를 만들지 않으며, `worktree.prepare`, branch 생성, push, GitLab MR, GitHub PR 생성을 실행하지 않습니다. 분석 runner가 source workspace를 dirty 상태로 만들면 실패로 처리합니다.

`fix_and_mr`는 별도 worker git worktree를 만들고 `worktree.prepare`와 `runners.projectEnv`를 적용한 뒤 runner, verification, push, GitLab MR 또는 GitHub PR 생성을 순서대로 수행합니다. MR/PR 생성 후에는 handoff context를 SQLite에 저장하고 나서 worker worktree cleanup을 시도합니다. cleanup 실패는 warning/audit로 남기며, 이미 저장된 handoff와 MR/PR 결과를 잃지 않습니다.

handoff context에는 Sentry issue id, repo id/path, MR/PR URL, `sourceBranch`, target branch, `headSha`, 분석/변경/검증 요약, readiness, follow-up prompt가 저장됩니다. raw Sentry payload는 저장하지 않고, runner summary와 prompt는 secret redaction 후 저장합니다.

Codex App 후속 작업은 repo-local `incident-handoff` plugin을 설치한 뒤 Local project에서 `$incident <issue-id>`로 시작합니다. 이 plugin은 worker MCP를 통해 handoff를 읽고, `sourceBranch`에서 Codex App-managed worktree를 만들거나 같은 incident App worktree를 계속 사용합니다. default branch나 worker-created worktree folder에서 후속 수정을 시작하지 않습니다.

### Codex에 incident plugin 추가

이 저장소는 repo-local Codex marketplace를 함께 제공합니다.

- marketplace 파일: `.agents/plugins/marketplace.json`
- plugin bundle: `plugins/incident-handoff`
- bundled skill: `incident`
- bundled MCP server: `incident_handoff`

설치 전에 한 번 빌드해 `dist/cli.js`가 존재하게 합니다.

```bash
pnpm install
pnpm build
```

Codex App에서 설치하려면 이 저장소를 Local project로 열고, Codex를 재시작한 뒤 **Plugins**에서 `Incident Handoff`를 찾아 **Add to Codex**로 설치합니다. 이 repo marketplace가 보이지 않으면 CLI에서 marketplace root를 명시적으로 추가할 수 있습니다.

```bash
codex plugin marketplace add /Users/won/Work/incident-chatops-worker
codex plugin marketplace list
```

CLI에서 설치하려면 이 저장소에서 `codex`를 열고 `/plugins`를 실행한 뒤 `incident-chatops-worker` marketplace의 `incident-handoff` plugin을 설치합니다.

```text
/plugins
```

설치 후 새 Codex App thread를 Local project에서 열고 다음처럼 호출합니다.

```text
$incident <issue-id>
```

`incident_handoff` MCP는 `node ../../dist/cli.js mcp`를 실행합니다. 기본적으로 daemon/status와 같은 automatic state DB path를 사용하고, 운영 DB를 따로 쓰면 Codex를 시작한 환경에 `STATE_DB_PATH=<state-db-path>`를 설정하거나 plugin MCP 설정에 `--db <state-db-path>`를 추가합니다. 이 MCP는 읽기 전용이며 Slack, Sentry, GitLab, GitHub, runner token을 요구하지 않습니다.

이 plugin은 repo-local bundle입니다. `plugins/incident-handoff`만 다른 위치로 복사하면 `../../dist/cli.js` 상대 경로가 깨질 수 있으므로, 이 저장소 marketplace에서 설치하거나 MCP command를 worker checkout의 절대 경로로 바꾼 뒤 개인 marketplace에 등록합니다.

## 문서 맵

- [아키텍처](docs/architecture.md): component map, Sentry polling부터 Slack thread, runner, worktree, Git provider MR/PR까지의 흐름
- [설정](docs/configuration.md): `.env.example`과 `incident-worker.config.example.yaml` 필드별 설명
- [보안](docs/security.md): 로컬 우선 모델, Slack approval, allowlist, redaction, prompt injection 대응
- [연동](docs/integrations.md): Slack Socket Mode, Sentry polling, GitLab/GitHub REST API, runner adapter 경계
- [운영](docs/operations.md): daemon, run-once, status, logs, doctor, launchd, SQLite state 운영
- [문제 해결](docs/troubleshooting.md): 설정 실패, Slack 버튼, Sentry polling, repo/runner/MR 오류 대응

## 보안 기본값

- 감지 즉시 자동 수정하지 않습니다. Slack approval이 필요합니다.
- repository는 `repos.allowlist` 안의 절대 경로만 허용합니다.
- branch는 설정된 `branch.prefix`를 따라야 합니다.
- 선택한 runner는 `runners.provider`가 정합니다. legacy `runners.genericCommandAllowlist`와 `runners.definitions`는 migration 동안 parseable하지만 새 설정은 `runners.generic.commandAllowlist`와 `runners.generic.definitions`를 사용합니다.
- runner output, audit entry, log, Slack message에는 secret redaction을 적용합니다.
- Sentry 제목, stack trace, Slack message, 외부 댓글은 모두 untrusted input입니다. prompt injection이 가능하다고 보고 runner prompt와 command 경계를 분리합니다.
- 감사 기록은 로컬 SQLite에 남기며 `node dist/cli.js logs --env-file .env --config incident-worker.config.yaml` 또는 `node dist/cli.js logs --db <state-db-path>`로 확인합니다.
- Git provider token은 MR/PR API 호출에만 사용합니다. Branch push는 로컬 git remote credential이 처리합니다.
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

`logs --db`는 명시 경로 override입니다. 일반 운영에서는 `logs --env-file --config`가 daemon/status와 같은 automatic-or-overridden state DB 경로를 resolve합니다.

로컬 설정 검사:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

incident handoff MCP 실행:

```bash
node dist/cli.js mcp --db <state-db-path>
```

`mcp`는 `--db`, `STATE_DB_PATH`, 또는 OS별 automatic DB path를 사용합니다. 읽기 전용 token-light surface이므로 Slack, Sentry, Git provider 토큰이 필요하지 않고 daemon, polling, runner, push, MR/PR 생성을 시작하지 않습니다.

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
- runner가 거부되면 `runners.provider`와 provider별 설정을 확인합니다. generic provider는 executable 이름이 `runners.generic.commandAllowlist`에 있어야 하고, analysis/fix mode command id가 `runners.generic.analysisCommandId`와 `runners.generic.fixCommandId`에 명시되어야 합니다.
- Git provider MR/PR 생성이 실패하면 selected provider token의 API 권한, target branch/base branch, project 또는 repository 권한을 확인합니다. Branch push 인증은 로컬 git remote credential을 확인하고, token 값은 출력하지 않습니다.
