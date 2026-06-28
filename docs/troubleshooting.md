# 문제 해결

이 문서는 현재 CLI와 테스트에서 확인되는 실패만 다룹니다. 모든 항목은 증상 -> 원인 -> 확인 -> 해결 순서로 읽으면 됩니다. 운영 secret 값, auth header, private log 전문은 명령 출력이나 이 문서에 남기지 마세요.

## 설정과 config

### `Missing required option: --config`

- 증상: `doctor`, `status`, `run-once`, `daemon` 실행 시 `Config invalid: Missing required option: --config`가 출력됩니다.
- 원인: 설정 YAML 경로가 CLI에 전달되지 않았습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: 운영 YAML을 만든 뒤 모든 운영 명령에 `--config incident-worker.config.yaml`을 붙입니다. 처음 설정 중이면 `incident-worker.config.example.yaml`을 복사해 secret이 아닌 정책만 채웁니다.

### env 값 누락 또는 `.env` 파일 읽기 실패

- 증상: `Config invalid: Invalid environment: ... must be set in env` 또는 `Config invalid: Unable to read ...`가 출력됩니다.
- 원인: `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITLAB_TOKEN` 같은 필수 env가 비었거나, `--env-file` 경로가 잘못되었습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: `.env.example`을 기준으로 `.env`를 만들고, secret은 env 또는 `--env-file`에만 둡니다. YAML에는 token, password, auth, api key 성격의 값을 넣지 않습니다.

### env 파일 형식 오류

- 증상: `Config invalid: Invalid env file line ... expected KEY=value` 또는 `Invalid env file key ...`가 출력됩니다.
- 원인: `.env`에 `KEY=value`가 아닌 줄이 있거나 env key 형식이 잘못되었습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: 빈 줄과 `#` 주석을 제외한 모든 줄을 `KEY=value` 형식으로 정리합니다. 따옴표나 export 문법에 의존하지 말고 값만 둡니다.

### invalid YAML 또는 secret이 들어간 YAML

- 증상: `Config invalid: Invalid YAML config: ...` 또는 `YAML config must not contain secrets at ...`가 출력됩니다.
- 원인: YAML 문법이 깨졌거나, 정책 파일에 secret처럼 보이는 key/value가 들어갔습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: `incident-worker.config.example.yaml` 구조에 맞춰 `sentry.projects`, `repos.allowlist`, `worktree.root`, `branch.prefix`, `slack.channels`, `runners`, `mr`만 둡니다. secret은 `.env`로 옮기고 YAML에는 repo/channel/runner/MR 정책만 남깁니다.

### `SENTRY_POLL_INTERVAL_SECONDS`가 최소값보다 낮음

- 증상: `Config invalid: SENTRY_POLL_INTERVAL_SECONDS must be greater than or equal to SENTRY_POLL_MIN_INTERVAL_SECONDS`가 출력됩니다.
- 원인: polling 주기가 `SENTRY_POLL_MIN_INTERVAL_SECONDS`보다 작습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: `.env`에서 `SENTRY_POLL_INTERVAL_SECONDS`를 최소값 이상으로 올립니다. 기본 운영값은 `300`초이고, 기본 최소값은 `60`초입니다.

## Slack

### Slack Socket Mode 연결 경고

- 증상: `doctor` 출력의 `Slack app token` 행에 `reachability warning: apps.connections.open ...`가 표시됩니다.
- 원인: `SLACK_APP_TOKEN`이 app-level token이 아니거나, Socket Mode가 꺼져 있거나, `connections:write` 권한이 부족합니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: Slack app에서 Socket Mode를 켜고 `connections:write` scope가 있는 app-level token을 `SLACK_APP_TOKEN`에 둡니다. 출력에 token 값이 보이면 공유하지 말고 토큰을 교체합니다.

### Slack bot 또는 channel 접근 경고

- 증상: `doctor` 출력의 `Slack bot token` 행에 `reachability warning: auth.test ...`가 표시되거나, incident thread가 channel에 게시되지 않습니다.
- 원인: `SLACK_BOT_TOKEN`이 잘못되었거나 `chat:write` 권한이 없거나, app이 `slack.channels.default` 또는 project별 channel에 초대되지 않았습니다. channel 이름 라우팅을 쓰면 channel 조회 권한도 필요할 수 있습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: bot token 권한을 확인하고 app을 대상 incident channel에 초대합니다. Interactivity도 켜야 `incident.`로 시작하는 Slack block action이 처리됩니다.

### Slack 버튼을 눌러도 작업이 시작되지 않음

- 증상: Slack root thread는 보이지만 `[분석하기]`, `[수정해서 MR]`, `[무시]` 같은 버튼 반응이 없습니다.
- 원인: Interactivity가 꺼져 있거나 Socket Mode 연결이 끊겼습니다. 같은 incident에 이미 active job이 있으면 중복 action은 `already in progress` 상태로 거부됩니다.
- 확인:

```bash
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml
```

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: Slack Socket Mode와 Interactivity를 다시 확인하고 daemon을 재시작합니다. `logs`에서 `job.claimed` 뒤에 `job.rejected_active`가 보이면 중복 클릭이나 동시에 들어온 다른 action을 기다린 뒤 다시 시도합니다.

## Sentry polling

### Sentry token 또는 API 접근 경고

- 증상: `doctor` 출력의 `Sentry token` 행에 `reachability warning: organizations probe HTTP ...`가 표시됩니다.
- 원인: `SENTRY_AUTH_TOKEN` 권한, `SENTRY_BASE_URL`, 네트워크, organization 접근 권한 중 하나가 맞지 않습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: token이 organization issue 목록과 issue event를 읽을 수 있는지 확인합니다. 자체 호스팅 Sentry를 쓰면 `SENTRY_BASE_URL`이 `/api/0` base를 가리키는지 확인합니다.

### `degraded` polling 또는 rate-limit

- 증상: daemon 출력에 `Sentry polling scheduler: degraded ...` 또는 `backoffSeconds=...`가 보이고, audit log에 `sentry.poll_degraded`가 반복됩니다.
- 원인: Sentry가 HTTP 429를 반환했거나 `x-sentry-rate-limit-remaining: 0` 계열 rate-limit header를 보냈습니다. polling 중 외부 API 오류가 발생해 degraded 상태로 기록될 수도 있습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

```bash
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
```

- 해결: `SENTRY_POLL_INTERVAL_SECONDS`를 늘리고, token 권한과 project mapping을 확인합니다. `backoffSeconds`가 표시되면 그 시간 이후 재시도합니다.

### malformed Sentry response

- 증상: `SentryExternalApiError`, `Malformed Sentry issues response`, 또는 `Malformed Sentry issues response JSON` 계열 실패가 보입니다.
- 원인: Sentry API 응답이 현재 schema와 맞지 않거나 JSON으로 파싱되지 않았습니다.
- 확인:

```bash
node dist/cli.js run-once --source sentry --env-file .env --config incident-worker.config.yaml
```

- 해결: `SENTRY_BASE_URL`, organization/project slug, token 권한을 확인합니다. 자체 프록시나 내부 Sentry를 쓰는 경우 응답이 Sentry issue list shape인지 확인합니다.

## repo, branch, worktree

### repo outside allowlist

- 증상: `repo denied by allowlist: ... not in ...`가 출력됩니다.
- 원인: incident가 가리키는 repo path가 `repos.allowlist`의 realpath 목록에 없습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: 의도한 로컬 repository의 절대 경로만 `repos.allowlist`에 추가합니다. 상대 경로, `..`, symlink 우회 경로는 사용하지 않습니다.

### unsafe branch prefix

- 증상: `branch prefix denied: expected ...` 또는 `branch prefix is unsafe`가 출력됩니다.
- 원인: branch name이 설정된 `branch.prefix`로 시작하지 않거나, prefix/name에 `..`, `//`, 허용되지 않는 문자가 포함되었습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: YAML의 `branch.prefix`를 `incident/`처럼 안전한 prefix로 둡니다. runner나 workflow가 만드는 branch도 같은 prefix를 사용해야 합니다.

### dirty repo 또는 dirty worktree

- 증상: `repository must be clean before opening a worktree`, `worktree is dirty: ...`, 또는 `analysis-only runner left dirty worktree ...`가 출력됩니다.
- 원인: 원본 repo에 미정리 변경이 있거나, runner가 `analysis_only` 모드에서 파일을 변경했습니다.
- 확인:

```bash
git status --porcelain=v1
```

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: 운영자가 의도한 변경을 먼저 정리한 뒤 다시 승인합니다. `analysis_only`는 no-write 모드이므로 수정이 필요한 경우 Slack에서 fix 흐름을 승인해야 합니다.

## runner

### unallowlisted runner command

- 증상: `runner command ... is not configured` 또는 `command ... is outside generic command allowlist`가 출력됩니다.
- 원인: Slack action이 요청한 runner id가 `runners.definitions`에 없거나, generic runner의 executable이 `runners.genericCommandAllowlist`에 없습니다.
- 확인:

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

- 해결: 사용할 runner를 `runners.definitions`에 명시하고, generic command executable을 `runners.genericCommandAllowlist`에 추가합니다. shell interpreter나 broad wrapper는 허용하지 않습니다.

### analysis-only mutation denial

- 증상: `analysis_only mode denies commit, push, and MR commands` 또는 `analysis-only runner left dirty worktree ...`가 출력됩니다.
- 원인: 분석 전용 승인에서 commit, push, MR 생성, 파일 변경 같은 mutation을 시도했습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: 분석 단계에서는 읽기 전용 조사만 수행합니다. 변경이 필요하면 Slack thread의 fix 버튼으로 `fix_and_mr` 흐름을 승인합니다.

### malformed runner output 또는 stale Codex output

- 증상: `RunnerOutputParseError`, `Codex output-last-message JSON is missing`, `Codex output-last-message JSON is invalid`, 또는 `Codex output-last-message JSON could not be read`가 출력됩니다.
- 원인: Codex runner가 `--output-last-message` 파일에 현재 실행의 JSON을 쓰지 않았거나, mode별 schema와 맞지 않는 JSON을 썼습니다. 테스트는 stale output 재사용도 실패로 처리합니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: runner adapter가 현재 실행의 마지막 메시지를 mode별 계약에 맞게 쓰는지 확인합니다. `analysis_only`는 `analysis`가 필요하고, `fix_and_mr`는 `analysis`, `branchInfo`, `changesSummary`, `mrReadiness`, `verificationResults`가 필요합니다.

### runner process timeout 또는 non-zero exit

- 증상: `RunnerTimeoutError`, `RunnerProcessError`, `<command> timed out after ...`, `<command> exited with code ...`가 출력됩니다.
- 원인: runner process가 제한 시간 안에 끝나지 않았거나 non-zero exit code로 종료되었습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: runner command와 인자를 줄이고, 필요한 env만 allowlist로 전달합니다. stderr는 redaction 후 저장되지만 private log 전문을 공유하지 않습니다.

## verification, push, MR

### `verification failed`로 push 전 중단

- 증상: Slack thread에 `verification failed`가 표시되고 Git push 또는 MR 생성이 일어나지 않습니다.
- 원인: `fix_and_mr` runner 결과의 `verificationResults`가 통과로 해석되지 않았습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: runner가 실패한 검증을 먼저 고친 뒤 다시 fix를 승인합니다. 현재 workflow는 verification summary를 저장한 뒤 push 전에 `WorkflowVerificationFailedError`로 중단합니다.

### `MR creation failed after push`

- 증상: Slack thread에 `MR creation failed after push. Branch retained for retry: ...`가 표시됩니다.
- 원인: verification은 통과했고 branch push도 끝났지만, GitLab Merge Request 생성 API가 실패했습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: GitLab token 권한, `mr.gitlab.baseUrl`, `mr.gitlab.project`, target branch, project 접근 권한을 확인합니다. 이미 push된 branch는 message와 audit의 branch 이름으로 찾아 MR 생성을 재시도하거나 수동 복구합니다.

## SQLite state와 audit

### SQLite state DB 열기 또는 읽기 오류

- 증상: `StateStoreOpenError: ...`, `SQLite database does not exist: ...`, `StateStoreReadOnlyError`, `StateStoreDataError`가 출력됩니다.
- 원인: `STATE_DB_PATH`의 parent directory 권한이 없거나, DB 파일이 없는데 read mode 명령을 실행했거나, 읽기 전용 store에서 write operation을 호출했거나, 저장된 row shape가 기대와 다릅니다.
- 확인:

```bash
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
```

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: `.env`의 `STATE_DB_PATH`가 쓰기 가능한 로컬 경로인지 확인합니다. 처음 실행이면 `daemon`, `daemon --once`, `run-once`처럼 write path를 한 번 실행해 DB와 migration을 만들고, 그 다음 `status`와 `logs`를 확인합니다.

### audit/log inspection

- 증상: workflow가 어디서 멈췄는지 Slack thread만으로 판단하기 어렵습니다.
- 원인: 실패 상세는 SQLite audit row에 action과 redacted details로 남습니다.
- 확인:

```bash
node dist/cli.js logs --db <state-db-path>
```

- 해결: `workflow.failed`, `workflow.verification_failed`, `workflow.mr_failed_after_push`, `cleanup_failed`, `sentry.poll_degraded`, `job.rejected_active` action을 기준으로 최근 row를 확인합니다. `No audit entries`는 DB는 열렸지만 아직 감사 row가 없는 정상 empty-state입니다.

## 문서와 공개 저장소 guardrail

### stale docs validator failures

- 증상: `node dist/cli.js dev validate-docs` 또는 `node dist/cli.js dev verify-scope --strict --plan ...`가 `FAIL ...`을 출력합니다.
- 원인: README/YAML/env example 또는 public docs가 현재 guardrail과 어긋났습니다. 테스트는 `.env.example` 누락, malformed YAML, plan path 누락, no-webhook/Slack approval 문구 누락, unsupported surface, strict source pattern을 실패로 다룹니다.
- 확인:

```bash
node dist/cli.js dev validate-docs
```

```bash
node dist/cli.js dev verify-scope --strict --plan docs-plan.md
```

- 해결: 실패 label이 가리키는 문서나 예시 파일만 수정합니다. webhook, GitHub provider, GUI, hosted control plane, unsafe command execution을 지원되는 기능처럼 쓰지 않습니다.

### raw secret scan failures

- 증상: `validate-docs` 또는 `verify-scope`가 `FAIL no raw secret patterns`를 출력합니다.
- 원인: README, example config, source, public docs 중 하나에 Slack/Sentry/GitLab token-looking 문자열이 들어갔습니다.
- 확인:

```bash
node dist/cli.js dev validate-docs --inject-secret-example
```

```bash
node dist/cli.js dev verify-scope --strict --plan docs-plan.md
```

- 해결: token-looking 값을 제거하고 placeholder 또는 redacted wording만 남깁니다. 공개 문서에는 운영 secret, auth header, private org/project/repo 이름, private log 전문을 넣지 않습니다.
