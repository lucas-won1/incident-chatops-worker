# 운영 가이드

이 문서는 `incident-chatops-worker`를 로컬 셸 또는 macOS `launchd`에서 운영하는 절차를 설명한다. 운영자는 실제 토큰을 문서나 로그에 남기지 말고, 검증용 실행에서는 예제 값이나 fake 모드만 사용한다.

## 로컬 셸 운영

작업은 저장소 루트에서 실행한다.

```bash
pnpm install
pnpm build
cp .env.example .env
cp incident-worker.config.example.yaml incident-worker.config.yaml
```

`.env`에는 Slack, Sentry, selected Git provider 토큰과 운영 값을 넣는다. `incident-worker.config.yaml`에는 Sentry 프로젝트 매핑, Slack 채널, repo allowlist, worktree root, runner allowlist, Git provider MR/PR 정책처럼 비밀이 아닌 정책만 둔다. 실제 토큰, auth header, cookie 값을 YAML이나 문서에 넣지 않는다.

첫 점검은 `doctor`로 한다.

```bash
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
```

`doctor`는 설정 파싱, polling interval, repo allowlist, runner 정의, 토큰 존재 여부를 확인한다. 일반 운영에서는 토큰 reachability도 점검하므로 실제 네트워크와 권한이 필요할 수 있다. 예제 값만 확인할 때는 `--example-mode`를 붙여 reachability를 건너뛸 수 있다.

```bash
node dist/cli.js doctor --example-mode --env-file .env --config incident-worker.config.yaml
```

단발성 점검은 `run-once`로 한다.

```bash
node dist/cli.js run-once --source sentry --env-file .env --config incident-worker.config.yaml
```

`run-once`는 Sentry를 한 번 polling하고, 새 incident가 있으면 Slack thread 생성 흐름으로 넘긴다. Slack approval 전에는 분석이나 수정 작업을 자동 실행하지 않는다.

상주 운영은 `daemon`으로 한다.

```bash
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml
```

`daemon`은 Slack Socket Mode를 시작하고 Sentry polling scheduler를 켠다. 종료 신호를 받으면 scheduler와 Slack adapter를 멈춘 뒤 `clean shutdown`을 출력한다.

배포 직후 smoke test에는 `daemon --once`를 사용한다.

```bash
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml --once
```

`daemon --once`는 daemon startup 경로를 그대로 지나가되 polling을 한 번만 실행하고 종료한다. 정상 출력에는 `Sentry polling scheduler: poll interval 300s`, poll 결과, `one poll cycle complete`, `clean shutdown`이 포함된다.

상태 확인은 `status`, 감사 로그 확인은 `logs`로 한다.

```bash
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
node dist/cli.js logs --env-file .env --config incident-worker.config.yaml
```

`status`는 `SQLite: ok`, connection mode, `polling: interval 300s`, incident/job 카운트를 보여준다. `logs`는 SQLite audit row를 시간, actor, action, job 상태 전이, details 형식으로 출력한다. 아직 감사 row가 없으면 `No audit entries`가 정상 empty-state다.

## fake와 example mode

`FAKE_MODE=1`과 `doctor --example-mode`는 운영 전 검증 전용이다. fake mode는 live Slack/Sentry/Git provider credential 없이 CLI 경로와 SQLite 쓰기를 확인할 때만 사용한다. fake mode에서 통과한 결과는 실제 토큰 권한, Slack 앱 설치, Sentry 조직 접근, Git provider MR/PR 권한을 증명하지 않는다.

테스트 fixture는 운영 설정이 아니다. 공개 운영자는 `.env.example`과 `incident-worker.config.example.yaml`을 복사한 뒤 자기 환경에 맞게 수정한다.

## launchd 운영

macOS에서 상주 실행할 때는 `launchd` agent를 둔다. 아래 예시는 경로만 보여주며 토큰 값을 포함하지 않는다. `node`, `dist/cli.js`, `.env`, config 경로는 모두 절대 경로로 바꾼다.

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

로드와 재시작은 다음처럼 한다.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.incident-chatops-worker.plist
launchctl kickstart -k gui/$(id -u)/local.incident-chatops-worker
```

수정 후에는 `pnpm build`를 다시 실행하고 `launchctl kickstart -k ...`로 새 프로세스를 띄운다. plist 자체를 바꿨다면 unload/load 절차를 운영 표준에 맞춰 수행한다.

## Polling 간격과 degraded 상태

기본 polling 간격은 `.env`의 `SENTRY_POLL_INTERVAL_SECONDS=300`이다. 너무 자주 polling하면 Sentry rate limit과 운영 소음을 키울 수 있으므로, 특별한 이유가 없으면 300초 이상을 유지한다. 최소 허용값은 `SENTRY_POLL_MIN_INTERVAL_SECONDS`로 둔다.

daemon poll이 실패하거나 Sentry가 backoff를 요구하면 결과는 `degraded`로 기록된다. daemon은 실패를 조용히 삼키지 않고 `Sentry polling scheduler: degraded ...`를 출력하며, redaction된 details를 SQLite audit에 남긴다. poll 결과에 backoff가 있으면 `backoffSeconds=<seconds>`가 함께 표시될 수 있다. 운영자는 `logs`로 degraded audit row를 확인하고, 토큰 권한, Sentry rate limit, 네트워크, config mapping을 점검한다.

## State DB와 SQLite 권한

`STATE_DB_PATH`를 생략하면 worker는 OS별 durable state 경로를 자동으로 사용한다. macOS는 `$HOME/Library/Application Support/incident-chatops-worker/state.sqlite`, Linux는 `${XDG_STATE_HOME:-$HOME/.local/state}/incident-chatops-worker/state.sqlite`, Windows는 `%LOCALAPPDATA%\incident-chatops-worker\state.sqlite`를 사용한다. `.env`의 `STATE_DB_PATH`는 선택 override이며, 설정하면 자동 경로보다 우선한다.

SQLite 파일에는 incident, job, audit 상태가 저장된다. state store는 DB 파일을 owner-only 권한인 `0600`으로 만들고, 기존 파일이 group-readable처럼 넓은 권한이면 open 시 owner-only로 복구한다. 운영자는 DB 파일과 상위 디렉터리가 같은 사용자 계정에서 읽고 쓸 수 있는지 확인한다. 운영 모델은 single-daemon-per-state-DB이다. 같은 state DB를 여러 daemon이 동시에 공유하지 않는다.

```bash
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
node dist/cli.js logs --env-file .env --config incident-worker.config.yaml
node dist/cli.js logs --db "$STATE_DB_PATH"
```

`logs --db`는 직접 지정한 SQLite 파일을 읽는 override이다. 일반 운영에서는 `logs --env-file --config`가 daemon/status와 같은 automatic-or-overridden state DB 경로를 resolve한다.

## Audit review

정기 review에서는 다음을 확인한다.

- `logs` 출력에 예상하지 못한 `sentry.poll_degraded`가 반복되는지 확인한다.
- runner, Slack action, MR 관련 audit action이 incident 대응 절차와 맞는지 확인한다.
- details에 raw secret이 보이면 운영을 중지하고 토큰을 교체한다. 정상 경로는 token-like 값을 redaction한다.
- `status`의 active job 수가 오래 유지되면 daemon 상태와 worktree를 함께 점검한다.

## backup과 restore

backup은 daemon을 멈춘 뒤 SQLite state DB와 운영 config를 함께 복사하는 방식이 가장 단순하다. `.env`는 비밀 파일이므로 암호화된 비밀 저장소나 운영 표준 백업 절차에 따르고, 일반 문서 저장소에 올리지 않는다.

```bash
node dist/cli.js logs --env-file .env --config incident-worker.config.yaml
cp <resolved-state-db-path> backups/state.sqlite
cp incident-worker.config.yaml backups/incident-worker.config.yaml
```

restore는 daemon이 꺼진 상태에서 백업 DB를 resolved state DB 위치로 되돌리고 권한을 owner-only로 맞춘 뒤 `status`로 확인한다. `STATE_DB_PATH`를 설정한 운영은 그 override 위치를 쓰고, 생략한 운영은 OS별 automatic durable path를 쓴다.

```bash
cp backups/state.sqlite <resolved-state-db-path>
chmod 600 <resolved-state-db-path>
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
```

복구 후에는 `logs`로 마지막 audit 상태를 확인하고, pending job이나 pending Slack thread가 있으면 중복 대응이 생기지 않도록 Slack thread와 Git provider MR/PR 상태를 대조한다.

## Upgrade와 rebuild

업그레이드 절차는 소스 갱신, 의존성 설치, rebuild, smoke test, daemon 재시작 순서로 진행한다.

```bash
pnpm install
pnpm build
node dist/cli.js doctor --env-file .env --config incident-worker.config.yaml
node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml --once
node dist/cli.js status --env-file .env --config incident-worker.config.yaml
```

`dist/cli.js`가 없거나 오래된 경우에는 운영 명령 전에 반드시 `pnpm build`를 다시 실행한다. build 산출물과 config가 맞지 않으면 CLI surface와 문서가 어긋날 수 있다.

## Worktree와 state cleanup

runner가 사용하는 worktree root는 config의 `worktree.root`가 정한다. 정상 workflow는 작업 후 worktree cleanup을 시도하지만, 실패 audit이 남거나 호스트가 중단된 경우에는 Git 상태를 직접 확인해야 한다.

cleanup 전에는 반드시 다음을 확인한다.

- 해당 worktree에서 실행 중인 job이 없는지 `status`와 `logs`로 확인한다.
- Git provider MR/PR 또는 Slack thread에 필요한 변경이 이미 push되었는지 확인한다.
- dirty worktree를 삭제해도 되는지 운영자가 판단한다.

state cleanup은 더 보수적으로 한다. SQLite DB를 삭제하면 seen incident, job, audit history가 사라져 중복 Slack thread나 대응 이력 손실이 생길 수 있다. 테스트용 state만 삭제하고, 운영 state는 backup을 만든 뒤 restore 경로까지 확인한 다음 정리한다.
