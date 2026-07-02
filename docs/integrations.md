# 연동, runner, worktree, Git providers

이 문서는 현재 MVP가 실제로 연결하는 외부 표면만 설명합니다. Slack은 Socket Mode 버튼 UI, Sentry는 polling 기반 감지와 context fetch, GitLab/GitHub는 MR/PR 생성 대상입니다. runner와 local git worktree는 Slack approval 이후에만 실행되는 내부 실행 경계입니다.

## Slack 앱

Slack 앱은 Socket Mode를 켠 Bolt 앱으로 동작합니다. `SLACK_APP_TOKEN`은 app-level token이며 `connections:write` scope가 필요합니다. `SLACK_BOT_TOKEN`은 bot token이며 incident thread와 결과 메시지를 쓰기 위해 `chat:write` scope가 필요합니다.

채널 접근은 별도 정책입니다. 설정된 incident 채널에 bot을 초대하거나, public channel 이름을 라우팅에 쓰는 경우 채널 조회 권한을 맞춰야 합니다. 채널 ID를 YAML에 직접 넣는 운영에서는 bot이 해당 채널에 들어가 있는지가 더 중요합니다.

Interactivity는 반드시 켜야 합니다. 현재 adapter는 Socket Mode로 들어오는 `block_actions` payload만 처리하고, `action_id`가 `incident.`로 시작하는 버튼을 `incident.analyze`, `incident.fix_mr`, `incident.fix_after_analysis`, `incident.ignore`, `incident.close` intent로 파싱합니다. Slack 메시지 이벤트나 멘션 이벤트는 현재 감지 경로가 아닙니다.

## Sentry polling과 context fetch

Sentry 설정은 읽기 전용 토큰을 전제로 합니다. `SENTRY_AUTH_TOKEN`은 organization issue 목록과 issue event를 읽을 수 있어야 하고, `SENTRY_BASE_URL`은 Sentry API base를 가리킵니다. 프로젝트 매핑은 `sentry.projects`의 `organizationSlug`, `projectSlug`, `slackChannel` 정책으로 관리합니다.

감지는 Sentry polling으로만 수행합니다. poller는 organization issue 목록에서 `is:unresolved project:<projectSlug>` 검색을 실행하고, rate limit 또는 429 응답을 만나면 `degraded` 상태와 backoff 초를 반환합니다. 이미 저장된 issue는 `lastSeen` 값이 그대로면 중복 Slack thread를 만들지 않고, root thread가 아직 `pending`이면 다시 게시를 시도할 수 있습니다.

context fetch는 runner 실행 직전에 incident context를 준비하는 단계입니다. 저장된 Sentry snapshot이 있으면 먼저 재사용하고, 없으면 `organizations/<organizationSlug>/issues/<issueId>/events/`에서 event 목록을 가져옵니다. runner에 넘기는 context에는 `trustBoundary: "untrusted_external_sentry"`가 붙으며, 저장 또는 전달 전에 설정된 secret 값은 redaction 됩니다. Sentry 제목, stack trace, event message는 명령이 아니라 신뢰하지 않는 입력 데이터로 취급해야 합니다.

## Git provider MR/PR

현재 Git provider는 GitLab Merge Request와 GitHub Pull Request를 지원합니다. 토큰은 env-only 값인 `GITLAB_TOKEN` 또는 `GITHUB_TOKEN`으로 주입하고 YAML에는 넣지 않습니다. 토큰 소유자는 대상 project/repository에 MR/PR REST API 호출 권한만 갖도록 최소화합니다.

Branch push는 로컬 git remote credential이 처리합니다. Git provider token은 branch push에 사용하지 않습니다.

`mr.gitlab` 정책은 API base, project, labels, draft 여부를 담습니다. API base는 GitLab API v4 base를 의미하고, project는 GitLab project path입니다. `mr.defaultTargetBranch`는 MR의 target branch가 되며, source branch는 incident workflow가 만든 branch입니다. labels는 GitLab 요청에서 쉼표로 합쳐져 전달되고, draft 설정은 boolean 그대로 사용됩니다.

`mr.github` 정책은 GitHub API base, owner, repo, labels, draft 여부를 담습니다. GitHub.com은 기본값 `https://api.github.com`을 사용하고, GitHub Enterprise는 해당 REST API base URL을 설정합니다. `mr.defaultTargetBranch`는 PR의 base branch가 되며, source branch는 incident workflow가 만든 branch입니다. labels는 PR 생성 후 Issues labels REST API로 적용됩니다.

workflow의 push timing은 보수적입니다. `fix_and_mr` runner가 완료된 뒤 `verificationResults`가 통과 상태인지 확인하고, 그 다음 `git push <remote> <branch>`를 실행합니다. push가 끝난 뒤 selected provider의 REST API로 GitLab MR 또는 GitHub PR을 만들며, 생성 또는 label 적용이 실패하면 branch는 remote에 남고 incident state는 `mr_failed_after_push`로 기록됩니다.

MR/PR 생성이 성공하면 workflow는 cleanup 전에 handoff context를 SQLite에 저장합니다. 저장 항목은 Sentry issue id, repo id/path, MR/PR URL, `sourceBranch`, target branch, `headSha`, 분석/변경/검증 요약, readiness, follow-up prompt입니다. raw Sentry payload는 handoff에 저장하지 않고, runner summary와 follow-up prompt는 secret redaction 후 저장합니다. worker worktree cleanup 실패는 `cleanup_failed` audit로 남으며 이미 저장한 handoff와 MR/PR 결과를 잃게 하지 않습니다.

## runner provider selection

`runners.provider` selects one daemon-global runner provider: `codex`, `claude-code`, or `generic`. The selected provider is loaded from YAML config; Slack actions and incident text cannot choose a provider. Provider settings are non-secret policy. Tokens stay in `.env` or the process environment and are not YAML values.

Legacy `runners.genericCommandAllowlist` and `runners.definitions` remain parseable during migration, but new examples use `runners.generic.commandAllowlist` and `runners.generic.definitions`.

## project environment wrapper

`runners.projectEnv`가 설정되면 selected runner command를 프로젝트 환경 wrapper 안에서 실행합니다. worker는 `pnpm`, `node`, `turbo` 같은 프로젝트 tool을 직접 해석하지 않습니다. 대신 `mise exec --`, `direnv exec . --`, `nix develop --command`, `devbox run --`처럼 운영자가 명시한 wrapper가 worktree cwd에서 toolchain을 준비합니다.

예:

```yaml
runners:
  projectEnv:
    command: /Users/won/.local/bin/mise
    args:
      - exec
      - --
```

Codex provider라면 실제 process boundary는 `mise exec -- codex exec ...` 형태가 됩니다. child env allowlist, secret redaction, workspace cwd, timeout은 기존 runner 정책을 그대로 따릅니다.

## Codex runner

Codex provider는 `codex exec`만 실행합니다. `runners.codex.bin`이 있으면 그 실행 파일을 사용하고, 없으면 `codex`를 실행합니다. 터미널에 미리 로드된 `CODEX_BIN`은 사용하지 않습니다. `runners.codex.home`을 설정하면 child process의 `CODEX_HOME`이 되고, 이 값은 Codex config/auth/session root입니다. 터미널의 ambient `CODEX_HOME`은 기본 전달되지 않습니다. `runners.codex`의 `profile`, `model`, `bin` 필드는 invocation override이며 `CODEX_HOME/profile/model/bin` 같은 경로 조합이 아닙니다.

child process env는 allowlist 기반이며 기본적으로 `PATH`, `HOME`과 `runners.codex.home`으로 설정된 `CODEX_HOME`만 전달됩니다. token류 env는 runner 출력 redaction 대상이 될 수 있지만, child process에 자동으로 모두 전달되지는 않습니다.

실행 argv는 `Codex exec` 형태입니다. runner는 `exec --json --cd <workspace> --sandbox <mode> --output-last-message <file> -`를 사용하고, prompt는 stdin으로 전달합니다. `analysis_only`는 read-only sandbox를 사용하고 prompt contract에 no-write, no-commit, no-push, no-MR을 명시합니다. 실행 후 workspace가 dirty 상태이면 성공으로 보지 않습니다.

`fix_and_mr`는 workspace-write sandbox를 사용합니다. 이 모드에서는 workspace 수정이 가능하지만, runner가 직접 push하거나 MR/PR을 만들면 안 됩니다. runner는 변경 요약, 검증 결과, 프로젝트 규칙을 반영한 `mergeRequestBody`를 JSON으로 반환하고, workflow가 clean/verification 확인 후 push와 Git provider MR/PR 생성을 담당합니다.

dev server smoke나 package fetch가 필요한 repo에서는 `runners.codex.workspaceWriteNetworkAccess: true`를 설정합니다. 이 값은 Codex CLI에 `sandbox_workspace_write.network_access=true`를 전달해 `workspace-write` sandbox command가 network/listen을 사용할 수 있게 합니다.

`--output-last-message` 파일은 성공 판정의 핵심 경계입니다. process exit code가 0이어도 파일이 없거나 JSON이 malformed이면 실패합니다. `analysis_only` 출력 JSON contract는 `{"analysis": string}`이고, `fix_and_mr` 출력 JSON contract는 `{"analysis": string, "changesSummary": string, "verificationResults": string, "branchInfo": string, "mrReadiness": string, "mergeRequestBody": string}`입니다.

Codex App 후속 수정은 Codex runner 설정으로 선택하지 않습니다. worker가 MR/PR과 handoff를 만든 뒤, 운영자는 repo-local `incident-handoff` plugin과 MCP를 사용해 App follow-up을 시작합니다.

## Claude Code runner

Claude Code runner는 `runners.claudeCode` 설정을 사용해 headless CLI를 실행합니다. GUI Claude 앱이나 desktop session 제어와 attach는 지원하지 않습니다.

실행 argv는 `claude -p --output-format json --json-schema <schema>` 형태입니다. 설정된 경우 `runners.claudeCode.settingsPath`, `model`, `permissionMode`, `allowedTools`, `disallowedTools`가 CLI invocation override로 전달됩니다. 위험한 permission bypass 값은 설정 로딩이나 runner 생성 시 거부됩니다.

`runners.claudeCode.configDir`는 child process의 `CLAUDE_CONFIG_DIR`로 전달되어 process config 파일 위치를 분리합니다. macOS에서는 Claude Code login credential이 Keychain에 저장될 수 있으므로 `configDir`만으로 별도 로그인 credential 저장소가 항상 보장되지는 않습니다.

## generic command runner

generic command runner는 YAML의 `runners.generic.definitions`에서 `id`, `command`, `args`를 찾고, `runners.generic.commandAllowlist`에 command가 들어 있을 때만 실행합니다. 이 command allowlist는 실행 파일 이름 기준이며, command id만 맞는다고 실행되지 않습니다. provider가 `generic`이면 `analysis_only`는 `runners.generic.analysisCommandId`, `fix_and_mr`는 `runners.generic.fixCommandId`를 사용합니다.

generic command도 shell 없이 argv 배열로 실행됩니다. 실행 파일과 인자는 null byte, shell metacharacter, 위험한 Codex override flag를 포함할 수 없습니다. shell interpreter나 command string 실행 형태는 거부됩니다. `analysis_only`에서는 allowlist에 들어 있어도 commit, push, MR/PR 성격의 token이 포함된 command는 거부됩니다.

generic runner의 결과는 별도 last-message 파일을 읽지 않습니다. process stdout이 `analysis`, `stdout`으로 저장되고 stderr도 함께 저장됩니다. 출력은 `defaultOutputLimitBytes` 기준으로 truncate 되고 secret 값은 redaction 됩니다. child process가 timeout을 넘기면 kill 되고 실패로 처리됩니다.

## runner output JSON contract

workflow가 공통으로 기대하는 runner result는 `analysis`, `command`, `mode`, `stdout`, `stderr`를 포함합니다. `fix_and_mr`에서는 여기에 `changesSummary`, `verificationResults`, `branchInfo`, `mrReadiness`, `mergeRequestBody`가 추가됩니다. `mergeRequestBody`는 runner가 작업 workspace 안의 MR/PR 문서와 규칙을 확인해 작성한 Markdown 본문입니다. `verificationResults`는 실제 검증 명령과 관찰 결과를 담아야 하며, 실패 또는 누락 상태를 통과처럼 표현하면 push 이전 검증 단계에서 막힙니다.

malformed_input/runner output 경계는 fail-closed입니다. Codex 또는 Claude Code output JSON이 schema와 맞지 않거나 비어 있으면 성공 stdout으로 대체하지 않습니다. Sentry context는 prompt 안에 들어가지만 `trustBoundary`가 명시되며, runner는 그 내용을 지시문이 아니라 incident 데이터로만 다뤄야 합니다.

## local git worktree 안전 경계

local git worktree adapter는 repo allowlist를 realpath 값으로 비교합니다. 요청 repo path가 존재하지 않거나, symlink 해석 후 allowlist에 없는 경로이면 git command를 실행하기 전에 거부합니다. `worktree.root`도 생성 후 realpath로 정규화하고, job id는 worktree path 구성에 안전한 문자만 허용합니다.

clean-repo precondition이 있습니다. worktree를 열기 전 원본 repo에서 `git status --porcelain=v1` 결과가 비어 있어야 합니다. 열린 job worktree도 runner 이후 dirty checks 대상입니다. 특히 `analysis_only`는 read-only sandbox와 별개로 실행 후 dirty 상태를 실패로 처리합니다.

선택적으로 `worktree.prepare.commands`를 설정하면 workflow가 runner 시작 전에 새 worktree cwd에서 project bootstrap을 실행합니다. 이 단계는 `runners.projectEnv` wrapper를 공유하므로 `mise exec -- pnpm install --frozen-lockfile --prefer-offline`처럼 repository toolchain으로 dependency layout을 만든 뒤 Codex, Claude Code, generic runner를 시작할 수 있습니다. 준비 command가 실패하면 runner를 시작하지 않고 workflow가 실패합니다.

`analysis_only`는 예외적으로 worker git worktree를 열지 않고 configured source repo path에서 실행합니다. 따라서 `worktree.prepare.commands`도 실행하지 않고, branch 생성, push, GitLab MR, GitHub PR 생성을 하지 않습니다. source repo가 실행 전 dirty이거나 runner 이후 dirty가 되면 분석 실패로 기록됩니다.

`fix_and_mr`는 worker git worktree를 열고 준비 command, selected runner, verification, push, MR/PR 생성, handoff 저장, cleanup 순서로 진행합니다. cleanup은 마지막 정리 단계이며 실패해도 warning/audit 대상입니다.

branch prefix 정책은 branch name이 설정된 `branch.prefix`로 시작하고 안전한 문자 패턴을 만족해야 한다는 뜻입니다. prefix 밖의 branch, `..`, 중복 slash 등은 branch prefix rejection으로 막힙니다. push 단계에서도 같은 branch prefix 검사를 다시 수행합니다.

cleanup은 `git worktree remove --force <worktreePath>`로 수행됩니다. cleanup 실패는 workflow를 다시 덮어쓰지 않고 audit에 `cleanup_failed`로 기록됩니다. session close는 중복 호출되어도 한 번만 제거합니다.

git command timeout은 기본 60초입니다. `git status`, `git worktree add`, `git push`, `git worktree remove --force` 같은 git 호출이 timeout을 넘기면 typed timeout error로 실패하며 무한 대기하지 않습니다. runner child process timeout은 별도이며 기본값은 30분입니다.

## 현재 extension boundaries

현재 확장 가능한 경계는 `SlackActionDispatcher`, `WorkflowSentryContextProvider`, `RunnerAdapter`, `MergeRequestProvider`, `WorkflowRepoAdapter`입니다. 다만 shipped MVP에서 운영자가 바로 사용할 수 있는 표면은 Slack Socket Mode, Sentry polling/context fetch, GitLab Merge Request, GitHub Pull Request, Codex exec runner, Claude Code runner, generic command runner, local git worktree입니다.

지원하지 않는 표면을 지원되는 것처럼 설정하지 마세요. Sentry 감지는 polling 경로만 사용하고, MR/PR 생성은 GitLab/GitHub REST API 경로만 사용합니다. Bitbucket, Gitea/Forgejo/Codeberg, Azure DevOps Repos, AWS CodeCommit, Gerrit provider는 이 릴리스에서 지원하지 않습니다. runner는 승인된 workspace 안에서만 실행되어야 하며, command allowlist와 repo allowlist를 우회하는 운영 방식은 현재 문서 범위 밖입니다.

## MCP handoff와 Codex App follow-up

handoff MCP server는 로컬 SQLite를 읽는 stdio server입니다.

```bash
node dist/cli.js mcp --db <state.sqlite>
```

`--db`를 생략하면 `STATE_DB_PATH`를 먼저 보고, 없으면 daemon/status와 같은 OS별 automatic DB path를 사용합니다. MCP는 token-light/read-only surface입니다. Slack, Sentry, GitLab, GitHub, runner 토큰이 필요하지 않고 daemon, polling scheduler, runner, branch push, MR/PR 생성을 시작하지 않습니다.

Codex App follow-up은 이 저장소의 repo-local `incident-handoff` plugin을 설치하거나 활성화한 뒤 Local project에서 `$incident <issue-id>`를 호출해 시작합니다. plugin은 MCP tool `incident_get_handoff`를 먼저 호출하고, Slack/Sentry/MR/PR 텍스트만으로 follow-up을 진행하지 않습니다.

Codex에 추가하는 방법은 다음과 같습니다.

1. `pnpm build`로 `dist/cli.js`를 만듭니다.
2. Codex App에서 이 저장소를 Local project로 열고 Codex를 재시작합니다.
3. **Plugins**에서 repo marketplace `incident-chatops-worker`의 `Incident Handoff`를 찾아 **Add to Codex**로 설치합니다.
4. CLI에서는 이 저장소에서 `codex`를 실행하고 `/plugins`를 열어 같은 plugin을 설치합니다.

repo marketplace가 보이지 않으면 `codex plugin marketplace add /Users/won/Work/incident-chatops-worker`로 marketplace root를 추가한 뒤 `codex plugin marketplace list`로 확인합니다. plugin bundle은 `plugins/incident-handoff`, marketplace 파일은 `.agents/plugins/marketplace.json`입니다. bundled MCP는 `node ../../dist/cli.js mcp`를 사용하므로 운영 DB가 automatic path가 아니라면 Codex 실행 환경의 `STATE_DB_PATH` 또는 plugin MCP 설정의 `--db <state.sqlite>`를 맞춥니다.

App follow-up은 handoff의 `sourceBranch`에서 Codex App-managed worktree를 만들거나 같은 incident App worktree를 계속 사용합니다. default branch나 worker-created worktree folder는 후속 수정의 대상이 아닙니다. 이미 같은 incident App worktree 안에서 호출했다면 public git checks로 현재 `HEAD`가 `headSha`와 같거나, `headSha`가 현재 `HEAD`의 ancestor이고 현재 branch/upstream/ref가 `sourceBranch`와 충돌하지 않는지 확인합니다. unrelated App worktree에서 호출하면 차단하거나 강하게 경고하고 Local project에서 `$incident <issue-id>`를 다시 실행하게 합니다.
