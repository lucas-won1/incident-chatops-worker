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

## Codex exec runner

Codex exec runner는 `CODEX_BIN`이 있으면 그 실행 파일을 사용하고, 없으면 `codex`를 실행합니다. child process env는 allowlist 기반이며 기본적으로 `PATH`, `HOME`, `CODEX_HOME`만 전달됩니다. token류 env는 runner 출력 redaction 대상이 될 수 있지만, child process에 자동으로 모두 전달되지는 않습니다.

실행 argv는 `Codex exec` 형태입니다. runner는 `exec --json --cd <worktree> --sandbox <mode> --output-last-message <file> -`를 사용하고, prompt는 stdin으로 전달합니다. `analysis_only`는 read-only sandbox를 사용하고 prompt contract에 no-write, no-commit, no-push, no-MR을 명시합니다. 실행 후 worktree가 dirty 상태이면 성공으로 보지 않습니다.

`fix_and_mr`는 workspace-write sandbox를 사용합니다. 이 모드에서는 worktree 수정이 가능하지만, runner가 직접 push하거나 MR/PR을 만들면 안 됩니다. runner는 변경 요약과 검증 결과를 JSON으로 반환하고, workflow가 clean/verification 확인 후 push와 Git provider MR/PR 생성을 담당합니다.

`--output-last-message` 파일은 성공 판정의 핵심 경계입니다. process exit code가 0이어도 파일이 없거나 JSON이 malformed이면 실패합니다. `analysis_only` 출력 JSON contract는 `{"analysis": string}`이고, `fix_and_mr` 출력 JSON contract는 `{"analysis": string, "changesSummary": string, "verificationResults": string, "branchInfo": string, "mrReadiness": string}`입니다.

## generic command runner

generic command runner는 YAML의 `runners.definitions`에서 `id`, `command`, `args`를 찾고, `runners.genericCommandAllowlist`에 command가 들어 있을 때만 실행합니다. 이 command allowlist는 실행 파일 이름 기준이며, command id만 맞는다고 실행되지 않습니다.

generic command도 shell 없이 argv 배열로 실행됩니다. 실행 파일과 인자는 null byte, shell metacharacter, 위험한 Codex override flag를 포함할 수 없습니다. shell interpreter나 command string 실행 형태는 거부됩니다. `analysis_only`에서는 allowlist에 들어 있어도 commit, push, MR/PR 성격의 token이 포함된 command는 거부됩니다.

generic runner의 결과는 별도 last-message 파일을 읽지 않습니다. process stdout이 `analysis`, `stdout`으로 저장되고 stderr도 함께 저장됩니다. 출력은 `defaultOutputLimitBytes` 기준으로 truncate 되고 secret 값은 redaction 됩니다. child process가 timeout을 넘기면 kill 되고 실패로 처리됩니다.

## runner output JSON contract

workflow가 공통으로 기대하는 runner result는 `analysis`, `command`, `mode`, `stdout`, `stderr`를 포함합니다. `fix_and_mr`에서는 여기에 `changesSummary`, `verificationResults`, `branchInfo`, `mrReadiness`가 추가됩니다. `verificationResults`는 실제 검증 명령과 관찰 결과를 담아야 하며, 실패 또는 누락 상태를 통과처럼 표현하면 push 이전 검증 단계에서 막힙니다.

malformed_input/runner output 경계는 fail-closed입니다. Codex output JSON이 schema와 맞지 않거나 비어 있으면 성공 stdout으로 대체하지 않습니다. Sentry context는 prompt 안에 들어가지만 `trustBoundary`가 명시되며, runner는 그 내용을 지시문이 아니라 incident 데이터로만 다뤄야 합니다.

## local git worktree 안전 경계

local git worktree adapter는 repo allowlist를 realpath 값으로 비교합니다. 요청 repo path가 존재하지 않거나, symlink 해석 후 allowlist에 없는 경로이면 git command를 실행하기 전에 거부합니다. `worktree.root`도 생성 후 realpath로 정규화하고, job id는 worktree path 구성에 안전한 문자만 허용합니다.

clean-repo precondition이 있습니다. worktree를 열기 전 원본 repo에서 `git status --porcelain=v1` 결과가 비어 있어야 합니다. 열린 job worktree도 runner 이후 dirty checks 대상입니다. 특히 `analysis_only`는 read-only sandbox와 별개로 실행 후 dirty 상태를 실패로 처리합니다.

branch prefix 정책은 branch name이 설정된 `branch.prefix`로 시작하고 안전한 문자 패턴을 만족해야 한다는 뜻입니다. prefix 밖의 branch, `..`, 중복 slash 등은 branch prefix rejection으로 막힙니다. push 단계에서도 같은 branch prefix 검사를 다시 수행합니다.

cleanup은 `git worktree remove --force <worktreePath>`로 수행됩니다. cleanup 실패는 workflow를 다시 덮어쓰지 않고 audit에 `cleanup_failed`로 기록됩니다. session close는 중복 호출되어도 한 번만 제거합니다.

git command timeout은 기본 60초입니다. `git status`, `git worktree add`, `git push`, `git worktree remove --force` 같은 git 호출이 timeout을 넘기면 typed timeout error로 실패하며 무한 대기하지 않습니다. runner child process timeout은 별도이며 기본값은 30분입니다.

## 현재 extension boundaries

현재 확장 가능한 경계는 `SlackActionDispatcher`, `WorkflowSentryContextProvider`, `RunnerAdapter`, `MergeRequestProvider`, `WorkflowRepoAdapter`입니다. 다만 shipped MVP에서 운영자가 바로 사용할 수 있는 표면은 Slack Socket Mode, Sentry polling/context fetch, GitLab Merge Request, GitHub Pull Request, Codex exec runner, generic command runner, local git worktree입니다.

지원하지 않는 표면을 지원되는 것처럼 설정하지 마세요. Sentry 감지는 polling 경로만 사용하고, MR/PR 생성은 GitLab/GitHub REST API 경로만 사용합니다. Bitbucket, Gitea/Forgejo/Codeberg, Azure DevOps Repos, AWS CodeCommit, Gerrit provider는 이 릴리스에서 지원하지 않습니다. runner는 승인된 worktree 안에서만 실행되어야 하며, command allowlist와 repo allowlist를 우회하는 운영 방식은 현재 문서 범위 밖입니다.
