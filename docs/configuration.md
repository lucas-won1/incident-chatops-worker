# 설정 레퍼런스

이 문서는 `incident-chatops-worker`의 설정을 `.env`와 `incident-worker.config.yaml`로 나누어 설명합니다. `.env`에는 실행에 필요한 비밀값과 운영값을 두고, YAML에는 비밀이 아닌 정책만 둡니다. YAML config must not contain secrets. YAML 안에 credential 성격의 키나 token 형태의 값이 들어가면 설정 파서가 거부합니다.

## 기본 원칙

- 비밀값은 env-only입니다. `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITLAB_TOKEN`, `GITHUB_TOKEN`은 `.env`나 실행 환경 변수에만 둡니다.
- YAML은 저장소, 브랜치, Slack 채널, runner, Git provider MR/PR 정책처럼 공유 가능한 비밀 없는 값만 담습니다.
- `repos.allowlist`와 `worktree.root`는 절대 경로여야 하며, `..` 경로나 NUL 문자를 포함할 수 없습니다.
- Sentry polling 기본값은 `SENTRY_POLL_INTERVAL_SECONDS=300`입니다. `SENTRY_POLL_MIN_INTERVAL_SECONDS` 기본값은 `60`이고, polling interval은 min interval보다 작을 수 없습니다.
- MR/PR provider는 GitLab과 GitHub를 지원합니다. `mr.provider`는 `gitlab` 또는 `github`만 지원합니다.
- Generic runner의 `command`는 반드시 `runners.genericCommandAllowlist`에 들어 있어야 합니다.

## `.env` 키

아래 키는 `.env.example`의 전체 키입니다. 실제 운영값은 로컬 `.env`에만 넣고 문서, YAML, 로그, 이슈, MR 설명에 붙이지 않습니다.

| 키 | 필수 여부 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `SLACK_APP_TOKEN` | 필수 | 없음 | Slack Socket Mode 연결에 쓰는 앱 레벨 비밀값입니다. env-only로 관리합니다. |
| `SLACK_BOT_TOKEN` | 필수 | 없음 | Slack 메시지 게시와 버튼 응답에 쓰는 봇 비밀값입니다. env-only로 관리합니다. |
| `SENTRY_AUTH_TOKEN` | 필수 | 없음 | Sentry issue와 event context를 읽기 위한 비밀값입니다. env-only로 관리합니다. |
| `GITLAB_TOKEN` | GitLab provider 선택 시 필수 | 없음 | GitLab MR API 호출에 쓰는 비밀값입니다. env-only로 관리합니다. |
| `GITHUB_TOKEN` | GitHub provider 선택 시 필수 | 없음 | GitHub PR API 호출에 쓰는 비밀값입니다. env-only로 관리합니다. |
| `SENTRY_BASE_URL` | 선택 | `https://sentry.io/api/0` | Sentry API base URL입니다. 자체 호스팅 Sentry를 쓰는 경우에만 바꿉니다. |
| `SENTRY_POLL_INTERVAL_SECONDS` | 선택 | `300` | Sentry polling 주기입니다. 양의 정수 문자열이어야 하며 min interval 이상이어야 합니다. |
| `SENTRY_POLL_MIN_INTERVAL_SECONDS` | 선택 | `60` | 허용할 최소 polling 주기입니다. 양의 정수 문자열이어야 합니다. |
| `STATE_DB_PATH` | 선택 override | OS별 durable state 경로 | 로컬 SQLite state와 audit log 파일 경로입니다. 설정하면 자동 경로보다 우선합니다. |

`STATE_DB_PATH`를 생략하면 worker는 durable state path를 자동으로 선택합니다. macOS는 `$HOME/Library/Application Support/incident-chatops-worker/state.sqlite`, Linux는 `${XDG_STATE_HOME:-$HOME/.local/state}/incident-chatops-worker/state.sqlite`, Windows는 `%LOCALAPPDATA%\incident-chatops-worker\state.sqlite`를 사용합니다. 명시한 `STATE_DB_PATH`는 이 자동 경로보다 항상 우선합니다.

비밀값 자리에는 실제 로컬 값을 직접 입력해야 합니다. 아래 템플릿은 credential 형태의 예시 문자열을 넣지 않은 안전한 형태입니다. Branch push는 로컬 git credential이 처리합니다. Git provider token은 MR/PR REST API 호출에만 사용합니다.

```dotenv
SLACK_APP_TOKEN=<fill locally>
SLACK_BOT_TOKEN=<fill locally>
SENTRY_AUTH_TOKEN=<fill locally>
GITLAB_TOKEN=<fill locally>
# GITHUB_TOKEN=<fill locally>
SENTRY_BASE_URL=https://sentry.io/api/0
SENTRY_POLL_INTERVAL_SECONDS=300
SENTRY_POLL_MIN_INTERVAL_SECONDS=60
# STATE_DB_PATH=/absolute/path/to/state.sqlite
```

## YAML 전체 예시

아래 YAML은 비밀값이 없는 정책 예시입니다. `/Users/example/...` 경로는 실행할 머신의 실제 절대 경로로 바꾸어 사용합니다.

```yaml
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
      slackChannel: "#incidents"
repos:
  allowlist:
    - /Users/example/work/service-repo
worktree:
  root: /Users/example/.local/share/incident-chatops-worker/worktrees
branch:
  prefix: incident/
slack:
  channels:
    default: "#incidents"
    routing:
      frontend: "#frontend-incidents"
runners:
  genericCommandAllowlist:
    - echo
  definitions:
    - id: echo-safe
      type: generic
      command: echo
      args:
        - incident-analysis-placeholder
mr:
  provider: gitlab
  gitlab:
    baseUrl: https://gitlab.com/api/v4
    project: example-group/service-repo
    defaultLabels:
      - incident-chatops
    draft: true
  defaultTargetBranch: main
```

GitHub를 선택할 때는 YAML의 `mr.provider`를 `github`으로 바꾸고 `mr.github` 정책을 둡니다. token은 YAML이 아니라 `GITHUB_TOKEN` env에만 둡니다.

```yaml
mr:
  provider: github
  github:
    baseUrl: https://api.github.com
    owner: example-org
    repo: service-repo
    defaultLabels:
      - incident-chatops
    draft: true
  defaultTargetBranch: main
```

## `sentry.projects`

`sentry.projects`는 Sentry project와 Slack channel을 연결하는 목록입니다. 최소 1개 항목이 필요합니다.

| 필드 | 설명 |
| --- | --- |
| `organizationSlug` | Sentry organization slug입니다. 빈 문자열은 허용되지 않습니다. |
| `projectSlug` | Sentry project slug입니다. 빈 문자열은 허용되지 않습니다. |
| `slackChannel` | incident를 보낼 Slack 채널입니다. `#incidents`처럼 `#`로 시작하고 영문, 숫자, `_`, `-`만 사용합니다. |

## `repos.allowlist`

`repos.allowlist`는 worker가 접근할 수 있는 Git 저장소의 허용 목록입니다.

- 최소 1개 이상의 절대 경로가 필요합니다.
- 상대 경로, `..` traversal, NUL 문자는 거부됩니다.
- incident fix 작업은 이 목록에 들어 있는 저장소에서만 worktree를 만들고 branch를 생성합니다.
- 예시: `/Users/example/work/service-repo`

## `worktree.root`

`worktree.root`는 임시 Git worktree를 만들 루트 디렉터리입니다.

- 절대 경로만 허용됩니다.
- `..` traversal과 NUL 문자는 거부됩니다.
- 운영 계정이 쓰기 권한을 가진 로컬 디렉터리여야 합니다.
- 예시: `/Users/example/.local/share/incident-chatops-worker/worktrees`

## `branch.prefix`

`branch.prefix`는 incident fix branch 앞에 붙는 문자열입니다.

- 영문자나 숫자로 시작해야 합니다.
- 영문, 숫자, `.`, `_`, `-`, `/`를 사용할 수 있습니다.
- 반드시 `/`로 끝나야 합니다. 예: `incident/`
- `..` 또는 `//`를 포함하면 거부됩니다.

## `slack.channels`

`slack.channels`는 기본 incident 채널과 project별 routing을 정의합니다.

| 필드 | 설명 |
| --- | --- |
| `slack.channels.default` | 기본 Slack 채널입니다. `#incidents`처럼 채널명 형태여야 합니다. |
| `slack.channels.routing` | 선택 필드입니다. key는 routing 이름이고 value는 Slack 채널입니다. 생략하면 `{}`로 처리됩니다. |

## `runners.genericCommandAllowlist`

`runners.genericCommandAllowlist`는 generic runner가 실행할 수 있는 command 목록입니다.

- 최소 1개 이상이 필요합니다.
- command는 영문, 숫자, `.`, `_`, `/`, `-`만 사용할 수 있습니다.
- `..`가 들어간 command는 거부됩니다.
- `runners.definitions[*].command`는 이 목록의 멤버여야 합니다.
- 안전한 예시로는 `echo`처럼 단일 executable 이름을 사용합니다.

## `runners.definitions`

`runners.definitions`는 worker가 사용할 runner 목록입니다. 최소 1개 이상이 필요합니다.

| 필드 | 설명 |
| --- | --- |
| `id` | runner 식별자입니다. 영문자로 시작하고 영문, 숫자, `_`, `-`만 사용할 수 있습니다. |
| `type` | 현재 YAML 예시는 `generic`만 사용합니다. |
| `command` | 실행할 command입니다. 반드시 `runners.genericCommandAllowlist`에 포함되어야 합니다. |
| `args` | 선택 인자 배열입니다. 생략하면 빈 배열로 처리됩니다. 각 항목은 빈 문자열일 수 없습니다. |

위 예시의 `echo-safe` runner는 `command: echo`를 사용하고, `echo`가 `genericCommandAllowlist`에 있으므로 허용됩니다.

## `mr.provider`

`mr.provider`는 Git provider를 고릅니다. 현재 지원값은 `gitlab`과 `github`입니다.

- `gitlab`은 GitLab Merge Request REST API provider입니다.
- `github`은 GitHub Pull Request REST API provider입니다.
- Bitbucket, Gitea/Forgejo/Codeberg, Azure DevOps Repos, AWS CodeCommit, Gerrit 같은 future provider는 이 릴리스에서 지원하지 않습니다.

## `mr.gitlab`

`mr.gitlab`은 GitLab MR 생성 정책입니다. 비밀값은 포함하지 않습니다.

| 필드 | 설명 |
| --- | --- |
| `mr.gitlab.baseUrl` | GitLab API base URL입니다. GitLab.com은 `https://gitlab.com/api/v4`를 사용합니다. |
| `mr.gitlab.project` | GitLab project path입니다. 예: `example-group/service-repo`. `..`, `//`, 앞뒤 특수 문자는 거부됩니다. |
| `mr.gitlab.defaultLabels` | 선택 필드입니다. 생략하면 `incident-chatops` label이 기본값입니다. |
| `mr.gitlab.draft` | 선택 필드입니다. 생략하면 `false`입니다. `true`면 draft MR로 생성합니다. |

GitLab 인증값은 `GITLAB_TOKEN` env에만 둡니다. YAML에는 인증 header, credential 값, 개인 접근 값을 넣지 않습니다.

## `mr.github`

`mr.github`는 GitHub PR 생성 정책입니다. 비밀값은 포함하지 않습니다.

| 필드 | 설명 |
| --- | --- |
| `mr.github.baseUrl` | GitHub REST API base URL입니다. GitHub.com은 기본값 `https://api.github.com`을 사용합니다. GitHub Enterprise는 해당 API base URL을 설정합니다. |
| `mr.github.owner` | GitHub repository owner 또는 organization입니다. |
| `mr.github.repo` | GitHub repository 이름입니다. |
| `mr.github.defaultLabels` | 선택 필드입니다. 생략하면 `incident-chatops` label이 기본값입니다. |
| `mr.github.draft` | 선택 필드입니다. 생략하면 `false`입니다. `true`면 draft PR로 생성합니다. |

GitHub 인증값은 `GITHUB_TOKEN` env에만 둡니다. YAML에는 인증 header, credential 값, 개인 접근 값을 넣지 않습니다.

## `mr.defaultTargetBranch`

`mr.defaultTargetBranch`는 MR의 기본 대상 branch입니다.

- 빈 문자열은 허용되지 않습니다.
- 일반적인 값은 `main` 또는 `develop`입니다.
- fix workflow는 `branch.prefix`로 만든 incident branch를 이 target branch로 MR 생성합니다.

## 검증 명령

설정 파일을 만든 뒤 실제 실행 전 `doctor`로 확인합니다.

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

문서와 예시가 공개 저장소에 안전한지 확인하려면 다음 명령을 사용합니다.

```bash
node dist/cli.js dev validate-docs
```

## 흔한 거부 조건

- `.env`에 필수 env-only 비밀값이 비어 있습니다.
- `SENTRY_POLL_INTERVAL_SECONDS`가 `SENTRY_POLL_MIN_INTERVAL_SECONDS`보다 작습니다.
- `repos.allowlist`나 `worktree.root`가 절대 경로가 아닙니다.
- `branch.prefix`가 `/`로 끝나지 않거나 `..`를 포함합니다.
- `runners.definitions[*].command`가 `runners.genericCommandAllowlist`에 없습니다.
- YAML에 secret 성격의 key나 credential 형태의 value가 들어 있습니다.
- `mr.provider`가 `gitlab` 또는 `github`이 아닙니다.
- selected provider가 `gitlab`인데 `GITLAB_TOKEN`이 없거나, selected provider가 `github`인데 `GITHUB_TOKEN`이 없습니다.
