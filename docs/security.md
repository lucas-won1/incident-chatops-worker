# 보안 모델

이 문서는 `incident-chatops-worker`를 공개 저장소에 두고 운영할 때의 위협 모델과 기본 보안값을 설명합니다. 이 MVP는 로컬 우선(local-first)으로 설계되어 있으며, 운영자가 소유한 로컬 머신이나 내부 호스트에서 실행하는 것을 전제로 합니다.

## 기본 위협 모델

- 로컬 우선: 기본 운영 모델은 Slack Socket Mode와 Sentry polling입니다. 외부에서 접근 가능한 공개 HTTP ingress, hosted control plane, 공개 webhook endpoint는 기본값에 없습니다.
- Sentry 감지는 신호일 뿐입니다. 새 이슈가 감지되면 Slack thread에 승인 버튼을 게시하지만, 감지만으로 분석, 수정, commit, push, MR 생성을 자동 수정하지 않습니다.
- Slack approval required: 분석과 수정/MR 흐름은 모두 Slack approval 이후에만 실행됩니다. Slack action은 사람의 승인 경계이며, 자동 승인으로 대체하지 않습니다.
- Sentry와 Slack에서 들어오는 제목, stack trace, event extra, comment, message는 모두 신뢰할 수 없는 입력입니다. prompt injection 가능성이 있는 외부 컨텍스트로 취급하고, 명령 원천이나 정책 원천으로 사용하지 않습니다.
- 저장소 변경은 허용된 repo allowlist, branch prefix, command allowlist 안에서만 진행됩니다.

## 비밀값과 설정

- 비밀값은 env-only입니다. `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITLAB_TOKEN`, `GITHUB_TOKEN` 같은 값은 `.env` 또는 프로세스 환경에만 둡니다.
- YAML secret은 거부됩니다. YAML 설정에 `token`, `secret`, `password`, `credential`, `api_key`, `auth` 같은 secret-looking key가 있거나 token-looking value가 있으면 설정 로딩이 실패합니다.
- YAML은 비밀이 아닌 정책만 담습니다. 예: Sentry project mapping, Slack channel routing, repo allowlist, worktree root, branch prefix, command allowlist, GitLab/GitHub project or repository metadata, base URL, default labels, draft flag, target branch.
- 공개 문서, evidence, issue, Slack 메시지에 실제 토큰, auth header, cookie, private log, PII를 붙여 넣지 않습니다.

## 승인과 실행 경계

- Slack approval 없이는 runner가 실행되지 않습니다. 감지 단계는 Slack 메시지를 만들고 상태를 저장하는 단계이며, repository mutation을 하지 않습니다.
- `analysis_only`는 분석 전용입니다. commit, push, MR/PR 생성 같은 mutation 의도는 차단됩니다.
- `fix_and_mr`도 무제한 실행이 아닙니다. 허용된 저장소 worktree에서 실행되고, 검증 결과가 통과해야 push와 Git provider MR/PR 생성으로 넘어갑니다.
- repo allowlist는 절대 경로 기준입니다. allowlist 밖의 repository나 realpath가 다른 경로는 거부되어야 합니다.
- branch prefix는 설정된 prefix를 따라야 합니다. traversal, 중복 separator, 위험한 branch 모양은 허용하지 않습니다.
- command allowlist는 generic runner의 실행 파일 이름을 제한합니다. allowlist에 없는 command는 실행하지 않습니다.

## Runner와 redaction

- runner child env는 최소화됩니다. 기본 child process에는 `PATH`, `HOME`, `CODEX_HOME`처럼 허용된 환경만 전달하고, 서비스 토큰 환경 변수는 전달하지 않습니다.
- 토큰 redaction은 별도로 유지됩니다. child env에 토큰을 넘기지 않더라도, runner output, stdout, stderr, parsed result에서 env-only secret value가 보이면 `[REDACTED]`로 마스킹합니다.
- redaction은 Slack/Sentry/GitLab/GitHub 계열 token-looking pattern과 설정에서 전달된 정확한 secret value를 대상으로 합니다.
- Sentry polling snapshot과 fetched Sentry context는 runner request, prompt, SQLite 저장 전에 redaction을 거칩니다. object key 위치에 들어간 secret value도 마스킹 대상입니다.
- audit log details는 저장 전에 redaction과 길이 제한을 거칩니다.

## 감사 로그와 상태 노출

- 상태와 audit log는 로컬 SQLite DB에 저장됩니다. 감사 이벤트는 `audit_log` 테이블에 append 형태로 남고, `logs` 명령은 이 로컬 감사 로그를 읽습니다.
- `status`, `logs`, daemon degraded polling 메시지, Slack status message는 secret value가 노출되지 않도록 redaction된 내용을 사용해야 합니다.
- SQLite 파일은 운영자가 관리하는 로컬 파일입니다. 백업, 권한, 보관 기간은 운영 환경 기준으로 정하고, 공개 저장소나 공유 채널에 업로드하지 않습니다.

## Git provider token 최소화

- Git provider token은 MR/PR API 호출에 필요한 최소 권한으로 발급합니다.
- Branch push는 로컬 git remote credential이 처리합니다.
- 가능하면 전용 계정이나 제한된 project/group membership을 사용하고, 개인의 광범위한 권한을 가진 token을 재사용하지 않습니다.
- GitLab/GitHub API base URL, project or repository identifier, default label, draft 여부, target branch는 YAML 정책입니다. Git provider token 자체는 env-only로 유지합니다.
- MR 생성 실패, push 이후 실패, API 오류를 기록할 때도 token value나 auth header를 로그에 남기지 않습니다.

## 프롬프트 인젝션 대응

- Sentry와 Slack 입력은 prompt injection 위험이 있는 외부 데이터입니다.
- incident title, stack trace, Sentry event payload, Slack message는 runner가 참고할 진단 자료이지, 정책을 바꾸거나 승인 절차를 우회할 수 있는 지시가 아닙니다.
- 운영자는 Slack 승인 전에 이슈 내용이 “규칙을 무시하라”, “비밀을 출력하라”, “허용되지 않은 명령을 실행하라” 같은 지시를 포함할 수 있음을 전제로 검토합니다.
- runner prompt와 request에는 trust boundary가 포함되어야 하며, 외부 입력은 `untrusted_external_sentry`로 취급합니다.

## 금지된 MVP surface

현재 MVP에서 다음 surface는 지원되는 운영 경로가 아닙니다.

- 공개 webhook server 또는 Sentry webhook setup. webhook 기본값은 없습니다.
- Bitbucket, Gitea/Forgejo/Codeberg, Azure DevOps Repos, AWS CodeCommit, Gerrit provider.
- GUI dashboard 또는 hosted control plane.
- live Slack/Sentry/Git provider credential QA.
- Sentry 감지 즉시 자동 수정, 자동 commit, 자동 push, 자동 MR 생성.
- allowlist를 우회하는 command runner, shell wrapper, 위험한 Codex override flag.

## 운영자가 반드시 지켜야 할 것

- [ ] `.env`와 프로세스 환경에만 비밀값을 둔다. YAML, README, issue, Slack thread, evidence에는 비밀값을 쓰지 않는다.
- [ ] Slack approval 없이 분석이나 수정이 실행되는 운영 방식을 만들지 않는다.
- [ ] Sentry 감지 후 자동 수정하지 않습니다. 승인 전에는 사람 검토가 먼저입니다.
- [ ] `repos.allowlist`에는 필요한 절대 경로만 넣고, 공유/임시/불명확한 경로를 넣지 않는다.
- [ ] `branch prefix`는 incident 전용 prefix로 두고, 다른 자동화와 충돌하지 않게 관리한다.
- [ ] `command allowlist`에는 필요한 runner command만 등록하고, shell interpreter나 wrapper를 넣지 않는다.
- [ ] Git provider token은 MR/PR API 호출 최소 권한으로 만들고, 주기적으로 교체한다.
- [ ] `status`, `logs`, SQLite audit log를 점검할 때 `[REDACTED]`가 유지되는지 확인한다.
- [ ] Sentry/Slack 내용은 prompt injection 가능성이 있는 외부 입력으로 보고, 승인 전에 의심스러운 지시문을 확인한다.
- [ ] 공개 저장소에 올리기 전 raw secret scan과 scope verification을 실행한다.
