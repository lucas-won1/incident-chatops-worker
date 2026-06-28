# 아키텍처와 워크플로

이 문서는 현재 구현된 incident-chatops-worker의 런타임 구조를 설명한다. 흐름은 `Sentry polling`으로 감지한 이슈를 Slack 승인으로 처리하고, 로컬 `worktree`에서 runner를 실행한 뒤 필요한 경우 GitLab MR을 만드는 방식이다.

## 컴포넌트 맵

- Sentry polling: Sentry 이슈를 주기적으로 조회하고 새 incident 후보를 `IncidentWorkflow.handleDetectedIncident`로 넘긴다. 감지 즉시 수정 작업을 시작하지 않는다.
- Workflow: incident 생성, Slack 액션 처리, job claim, 상태 전이, audit 기록을 조율한다. 이 레이어가 한 incident에 동시에 하나의 활성 job만 허용한다.
- Slack Block Kit: root `Slack thread` 메시지에는 `[분석하기] [수정해서 MR] [무시]` 버튼을 렌더링하고, 분석 완료 메시지에는 `[수정하기] [닫기]` 버튼을 렌더링한다.
- Runner: 승인된 job만 실행한다. 분석은 `analysis_only`, 수정은 `fix_and_mr` 모드로 요청된다.
- Repo adapter: job별 branch와 로컬 `worktree`를 열고, 검증을 통과한 수정 branch를 원격으로 `push`한다.
- MR provider: 현재 문서화 대상 구현은 GitLab MR 생성 경로다. MR URL은 SQLite에 저장되고 Slack 상태 메시지로 게시된다.
- SQLite state store: incident, job, approval, 분석 요약, verification 요약, MR 링크, Sentry snapshot, audit 데이터를 저장한다.

## 시퀀스 플로

1. Sentry polling이 이슈를 감지하면 workflow가 `sentry_issue_id` 기준으로 incident를 upsert한다.
2. 새 incident이면 Slack root `Slack thread`에 감지 메시지를 올린다. 메시지는 `[분석하기] [수정해서 MR] [무시]` 버튼을 포함한다.
3. root thread timestamp가 비어 있거나 `pending`이면 Slack 게시 결과의 `ts`로 incident를 갱신한다. 기존 incident가 아직 pending root-thread 상태라면 다음 감지에서 root-thread 게시를 다시 시도한다.
4. `[무시]`는 runner 없이 workflow를 `ignored`로 전이하고 상태 메시지를 남긴다.
5. `[분석하기]`는 Slack action idempotency key로 analysis job을 claim하고 workflow를 `analysis_requested`에서 `analysis_running`으로 전이한다.
6. analysis-only 경로는 먼저 incident context를 준비한 뒤 로컬 `worktree`를 연다. runner는 `analysis_only` 모드로 실행되고, 결과의 구조화된 분석 필드가 SQLite 분석 요약으로 저장된다.
7. 분석이 끝나면 workflow는 `analysis_completed`가 되고 Slack thread에 root-cause summary와 `[수정하기] [닫기]` 버튼을 게시한다. `[닫기]`는 runner 없이 `closed`로 전이한다.
8. `[수정해서 MR]` 또는 분석 후 `[수정하기]`는 fix job을 claim하고 workflow를 `fix_requested`에서 `fix_running`으로 전이한다.
9. fix 경로는 로컬 `worktree`를 열고 runner를 `fix_and_mr` 모드로 실행한다.
10. runner 결과에서 verification summary를 SQLite에 먼저 저장한다. 그 다음 `verification` 결과를 검사하며, 실패하면 `push`와 GitLab MR 생성을 하지 않는다.
11. verification이 통과하면 repo adapter가 branch를 원격으로 `push`한다.
12. push 후 GitLab MR을 생성하고, MR 링크를 SQLite에 저장한 뒤 workflow를 `mr_created`로 전이한다.
13. Slack thread에는 MR URL, verification 상태, 변경 요약을 포함한 상태 메시지를 게시한다.
14. analysis와 fix 모두 `finally` 단계에서 `worktree` cleanup을 시도한다.

## 상태와 audit 데이터 모델

SQLite는 전체 구현의 단일 로컬 상태 저장소다. 문서는 전체 schema를 덤프하지 않고 역할만 설명한다.

- `incidents`: Sentry issue, repo, Slack channel/thread, 현재 workflow state, 최초/최근 감지 시각을 보관한다. `sentry_issue_id`는 중복 감지를 합치는 기준이다.
- `jobs`: analysis/fix job claim과 실행 상태를 보관한다. `queued` 또는 `running` job은 incident별로 하나만 존재할 수 있다.
- `approvals`: Slack 승인 결정을 action idempotency key와 함께 남겨 같은 버튼 액션을 재처리하지 않게 한다.
- `analysis_summaries`: `analysis_only` runner가 반환한 root-cause summary를 job과 incident에 연결해 저장한다.
- `verification_summaries`: `fix_and_mr` runner 결과에서 만든 verification 상태와 요약을 저장한다. 이 저장은 push보다 먼저 일어난다.
- `mr_links`: GitLab MR 생성 성공 시 provider와 URL을 저장한다.
- `sentry_issue_snapshots`: Sentry context fetch 결과를 저장해 이후 fix 요청에서도 같은 incident context를 재사용할 수 있게 한다.
- `audit_log`: actor, action, state_from, state_to, job_id, details를 기록한다. 상태 전이, job claim, 활성 job 거절, cleanup failure 같은 운영 판단 근거가 여기에 남는다.

## Trust Boundary

이 시스템의 `trust boundary`는 Slack 사용자 액션, Sentry issue context, runner 출력, GitLab API 응답, 로컬 git 작업 사이에 있다.

- Sentry issue context는 외부 입력으로 취급한다. runner prompt에 들어가더라도 신뢰된 운영 명령으로 승격하지 않는다.
- Slack 버튼은 승인 신호지만, 중복 액션과 오래된 액션은 SQLite idempotency와 활성 job 제약으로 다시 검증한다.
- Runner 출력은 transport stdout이 아니라 구조화된 결과 필드 기준으로 저장하고 게시한다. 분석 요약은 `analysis` 필드를 사용한다.
- verification이 통과하기 전에는 branch를 push하지 않는다.
- GitLab MR 응답은 MR URL 저장과 Slack 게시에만 사용한다.
- audit와 사용자-visible Slack 오류는 secret redaction을 거친 메시지를 사용해야 한다.

## Failure State

- 일반 analysis 실패: Sentry context fetch, `worktree` open, runner 실행 같은 단계에서 오류가 나면 workflow는 실패 상태로 전이하고 Slack에 redacted 오류를 게시한다. runner가 시작되기 전 실패할 수도 있다.
- `verification_failed`: `fix_and_mr` runner 결과의 verification이 실패하면 verification summary는 저장되지만 `push`와 GitLab MR 생성은 실행하지 않는다. Slack에는 verification 실패 상태가 게시된다.
- `mr_failed_after_push`: verification 통과 후 branch `push`는 성공했지만 GitLab MR 생성이 실패한 상태다. audit details에는 branch와 remote가 남고, Slack에는 branch가 retry를 위해 남아 있다는 상태가 게시된다.
- cleanup failure: `worktree` cleanup 실패는 `cleanup_failed` audit action으로 기록한다. 이미 완료된 analysis summary나 MR 성공 결과를 실패로 덮어쓰지 않는다.
- malformed input/scenario fixture: dev scenario CLI는 YAML fixture를 schema로 파싱한다. 잘못된 fixture는 workflow를 실행하기 전에 거부된다.

## Concurrency와 Idempotency

`concurrency`와 `idempotency`는 SQLite 제약과 workflow-level serialization으로 처리한다.

- Sentry polling 중 같은 issue가 반복 감지되면 `sentry_issue_id` 기준으로 incident를 재사용한다.
- 같은 issue의 감지 처리는 메모리 큐로 직렬화되어 root thread 생성 race를 줄인다.
- `jobs`에는 incident별 활성 job을 하나로 제한하는 제약이 있다. 이미 `queued` 또는 `running` job이 있으면 다른 Slack 액션은 `job.rejected_active` audit를 남기고 "already in progress" 상태를 게시한다.
- 같은 Slack 액션은 `action_idempotency_key`로 deduplicate된다. 이미 처리된 job이면 새 runner, push, GitLab MR side effect 없이 "already handled" 또는 "already in progress" 메시지를 돌려준다.
- stale_state 성격의 액션, 예를 들어 analysis가 실행 중일 때 들어온 별도 fix 요청은 두 번째 runner를 실행하지 않고 안전하게 거절된다.
- pending root-thread retry는 thread timestamp가 비어 있거나 `pending`인 incident에만 적용된다. 이미 정상 thread timestamp가 저장된 incident는 중복 root 메시지를 만들지 않는다.

## Extension Point

현재 확장 지점은 구현된 인터페이스 안에서만 본다.

- Sentry source: polling source가 workflow에 `WorkflowDetectedIncident`를 넘기는 구조라서 감지 입력을 같은 shape로 유지하면 교체가 가능하다.
- Slack adapter: workflow는 `postMessage` 동작에 의존하므로 Block Kit 메시지 렌더링과 전송 계층을 분리할 수 있다.
- Runner adapter: `analysis_only`와 `fix_and_mr` 요청/응답 계약을 지키는 runner를 추가할 수 있다. verification 결과는 `passed`, `failed`, `missing` 의미를 유지해야 한다.
- Repo adapter: `openWorktree`, `pushBranch`, cleanup 계약을 지키는 로컬 git 구현을 교체할 수 있다.
- MR provider: 현재 운영 문서는 GitLab MR provider를 기준으로 한다. 다른 provider를 추가하려면 MR 생성 입력, audit, failure handling이 같은 신뢰 경계와 상태 전이를 지켜야 한다.
- SQLite state store: table 역할과 idempotency 제약을 유지해야 workflow의 one-active-job, duplicate Slack action handling, audit 추적이 깨지지 않는다.
