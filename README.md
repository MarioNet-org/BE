# MarioNet Server

Express 5, TypeScript, Prisma 6.19.3, MySQL 8로 구성한 단일 프로세스 백엔드다. Node.js 22.15 이상에서 실행한다. MySQL의 계정 행 잠금과 트랜잭션으로 Refresh Token 회전, 비밀번호 변경, 접속 승인 경합을 처리한다. Prisma 버전은 현재 Node 런타임과 함께 검증한 버전으로 고정했다.

## Docker로 서버와 MySQL 실행

`server` 디렉터리에서 아래 명령 하나로 Express 서버와 MySQL을 함께 실행한다. `.env` 없이도 개발 기본값으로 실행할 수 있다.

```powershell
docker compose up -d --build --wait
docker compose ps
```

- API: `http://127.0.0.1:4000`, 상태 확인: `GET /health`.
- MySQL: 호스트에서는 `127.0.0.1:3307`, 서버 컨테이너에서는 `mysql:3306`.
- MySQL healthcheck 통과 후 서버가 시작되며, 시작 시 `prisma migrate deploy`를 실행하고 성공하면 Express를 실행한다. 기존 MySQL 데이터 볼륨을 그대로 사용한다.
- Dockerfile에서 Linux용 Prisma Client와 TypeScript 빌드를 생성한다. 호스트의 `.env`, `node_modules`, 빌드 결과는 이미지에 포함하지 않는다. 서버는 root 대신 `node` 사용자로 실행한다.
- 개발 메일은 `server-data` 볼륨의 `/app/.local/mail`에 저장한다. `docker compose cp server:/app/.local/mail ./.local/docker-mail`로 복사할 수 있다(먼저 `.local` 디렉터리 생성).

```powershell
docker compose logs -f server
# 코드 변경 후 서버 이미지를 다시 빌드하고 적용
docker compose up -d --build --wait server
# 컨테이너 중지. 데이터 볼륨은 유지된다.
docker compose down
```

개발 중 소스 변경을 자동 반영하려면 별도의 터미널에서 다음 명령을 실행한다.

```powershell
docker compose watch server
```

개발용 Compose 서버는 `yarn run dev`를 실행하며 `tsx watch`가 `src` 변경을 감지해 프로세스를 재시작한다. `package.json`, `yarn.lock`, `.env` 변경은 컨테이너 재빌드로 반영된다. 배포용 Docker 이미지 자체는 Dockerfile의 기본 명령으로 컴파일된 `dist/index.js`를 실행한다.

같은 4000 포트의 로컬 `npm run dev` 서버와 동시에 실행하지 않는다. 포트 충돌 시 기존 개발 서버를 종료하거나 `.env`의 `SERVER_PORT`를 변경하고 Client의 `MARIONET_API_URL`도 맞춘다. 다른 PC에서 API에 접속해야 한다면 `SERVER_BIND_ADDRESS=0.0.0.0`을 설정한다.

Compose는 `.env`의 메일·CORS 설정을 전달하지만 `HOST`, `PORT`, `DATABASE_URL`은 컨테이너용 값으로 지정한다. 호스트에서 실행 중인 SMTP에 연결하려면 Docker Desktop에서 `SMTP_HOST=host.docker.internal`을 사용한다. 이 Compose는 기존 개발용 DB 자격 증명과 파일 메일 기본값을 유지한다. 운영에서는 DB 자격 증명, SMTP, HTTPS와 외부 접근 설정을 별도로 구성한다.

## Node.js로 서버를 직접 실행

`server` 디렉터리에서 실행한다.

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d --wait mysql
npm run db:generate
npm run db:migrate
npm run dev
```

이미 `.env`가 있으면 복사하지 않고 필요한 값만 수정한다. Docker 설정은 **127.0.0.1:3307**에 개발용 MySQL을 실행하므로 기존 3306 MySQL과 분리된다. 개발 전용 자격 증명은 compose와 예제 환경 파일에 명시되어 있다. 기존 MySQL을 사용하려면 별도 앱 DB와 전용 계정을 만들고 `DATABASE_URL`을 변경한다. 비밀번호의 URL 특수문자는 퍼센트 인코딩한다.

기본 서버 주소는 `http://127.0.0.1:4000`, 상태 확인은 `GET /health`다. 다른 PC에서 연결할 환경에서는 `HOST`, TLS 역방향 프록시 및 허용 Origin을 구성한다. `npm run build` 후 `npm start`로 빌드된 서버를 실행할 수 있다.

## 인증 계약

- 계정 식별자는 소문자로 정규화한 이메일이다. 비밀번호는 12–128자이며 scrypt 해시로 저장한다.
- Access Token은 15분, 로그인 세션과 Refresh Token은 로그인 시점부터 최대 30일이다. 토큰은 256비트 난수이며 DB에는 SHA-256 해시만 보관한다. JWT가 아니므로 클라이언트에서 디코딩하지 않는다.
- 보호 API는 `Authorization: Bearer <accessToken>`을 사용한다. 쿠키 인증은 사용하지 않는다.
- Refresh 요청마다 두 토큰을 교체하고 이전 Access Token은 즉시 무효화한다. 사용한 Refresh Token을 다시 제출하면 해당 로그인 세션을 취소한다. Client/Host는 갱신 요청을 직렬화하고 네트워크 실패 시 같은 토큰을 자동 재시도하지 않는다.
- 이미 인증된 WebSocket은 로그인 세션에 연결되어 있어 정상적인 토큰 갱신 후 유지된다. 갱신은 만료 전에 수행한다. 로그아웃·세션 취소·비밀번호 변경 또는 만료 시 소켓과 원격 접속을 종료한다.
- 비밀번호 재설정·변경은 모든 로그인 세션을 취소한다. 재설정 토큰은 30분, 이메일 인증 토큰은 24시간이며 한 번만 사용 가능하다. 재발송하면 이전 토큰은 만료된다.
- 이메일 인증 전에도 로그인과 인증 메일 재발송은 가능하다. Host 등록에는 이메일 인증이 필요하다.
- 사용자 GET API는 제공하지 않는다. `signin` 응답에 `{ id, email, emailVerified }`를 제공한다.

## HTTP API

기본 경로는 `/api/v1`. 표의 요청은 JSON body다. 인증 필요 표시는 Bearer Token을 뜻한다. 성공 시 빈 응답은 `204`, 잘못된 입력은 `400`, 인증 실패는 `401`, 권한 부족은 `403`, 없는 리소스는 `404`, 중복 또는 잘못된 상태는 `409`, 요청 제한은 `429`다.

| 메서드·경로 | 인증 | 요청 | 성공 |
| --- | --- | --- | --- |
| POST `/auth/signup` | — | `{ email, password }` | 201 `{ user }`, 인증 메일 발송 |
| POST `/auth/signin` | — | `{ email, password }` | 200 토큰 쌍 및 `user` |
| POST `/auth/refresh` | — | `{ refreshToken }` | 200 새 토큰 쌍 |
| POST `/auth/signout` | 필요 | 없음 | 204, 현재 세션 종료 |
| POST `/auth/signout-all` | 필요 | 없음 | 204, 모든 세션 종료 |
| POST `/auth/password/forgot` | — | `{ email }` | 202, 등록 여부와 무관한 동일 메시지 |
| POST `/auth/password/reset` | — | `{ token, newPassword }` | 204 |
| PATCH `/auth/password` | 필요 | `{ currentPassword, newPassword }` | 204 |
| POST `/auth/email/verification/request` | 필요 | 없음 | 202 |
| POST `/auth/email/verification/confirm` | — | `{ token }` | 204 |
| POST `/nodes` | 필요 | `{ name, platform }` | 201 `{ node, nodeKey }` |
| GET `/nodes` | 필요 | 없음 | 200 `{ nodes }` |
| PATCH `/nodes/:nodeId` | 필요 | `{ name }` | 200 `{ node }` |
| DELETE `/nodes/:nodeId` | 필요 | 없음 | 204 |
| POST `/connections` | 필요 | `{ nodeId }` | 201 `{ connection }` |
| POST `/connections/:connectionId/accept` | 필요 + Node 키 | 없음 | 200 `{ connection }` |
| POST `/connections/:connectionId/reject` | 필요 + Node 키 | 없음 | 200 `{ connection }` |
| DELETE `/connections/:connectionId` | 필요 | 없음 | 204 |

토큰 응답은 `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn: 900 }`이다. `signin`에만 `user`가 추가된다. 오류 형태는 `{ error: { code, message, fields? } }`다. 비밀번호·토큰을 오류 응답에 반사하지 않는다.

Node 이름은 1–80자, `platform`은 `windows | macos | linux`, 계정당 최대 100대다. 목록에는 `id, name, platform, createdAt, lastSeenAt, online`을 포함한다. `online`은 살아 있는 Host WebSocket을 기준으로 한다. Node 키는 등록 응답에서 한 번만 전달하고 DB에는 해시를 저장한다. Host의 OS 보안 저장소에 보관한다. 키를 분실하면 Node를 해제하고 재등록한다.

접속 요청에는 Client와 대상 Host의 인증된 소켓이 모두 필요하다. 요청은 60초 후 만료된다. 승인·거절 시 `X-Node-Key: <nodeKey>`를 보내야 한다. 같은 계정이라도 대상 Host 키가 없으면 승인할 수 없다. 연결 종료는 요청한 Client 세션 또는 해당 Host 키를 가진 세션만 가능하다. Node 등록 해제 시 관련 접속 기록도 삭제하고 연결 종료 이벤트를 보낸다.

Connection 필드: `id, nodeId, requesterSessionId, status, createdAt, expiresAt, updatedAt`. `expiresAt`은 **승인 대기 만료 시각**이다. 상태는 `PENDING → ACCEPTED | REJECTED | EXPIRED | CLOSED`, 승인 후 종료 시 `ACCEPTED → CLOSED`다. 종료 API는 이미 종료된 상태에 대해 멱등적이다.

## WebSocket

`ws://127.0.0.1:4000/api/v1/ws`에 연결하고 5초 안에 첫 메시지를 보낸다. 토큰을 URL 쿼리에 넣지 않는다. 운영에서는 `wss://`를 사용한다.

```json
{ "type": "authenticate", "accessToken": "..." }
```

Host는 `nodeId`와 `nodeKey`를 함께 전달한다.

```json
{ "type": "authenticate", "accessToken": "...", "nodeId": "uuid", "nodeKey": "..." }
```

성공하면 `{ "type": "ready", "role": "client" }` 또는 `{ "type": "ready", "role": "host", "nodeId": "..." }`를 받는다. 로그인 세션당 Client 소켓 하나, Node당 Host 소켓 하나를 허용한다. 두 앱은 각각 로그인해 별도 세션을 사용한다. 재접속 시 정리 중이면 잠시 후 재시도한다. 소켓 재접속은 기존 원격 연결을 자동 재승인하지 않는다.

서버 이벤트:

- `node.status`: `{ type, nodeId, online }`, 해당 계정의 소켓에 전달.
- `connection.updated`: `{ type, connection }`, 요청 Client와 대상 Host에만 전달.
- `error`: `{ type, code }`.
- `signal`: 승인된 연결의 상대 참여자에게만 전달, `from: "host" | "client"` 추가.

승인 후 연결 정보 교환:

```json
{
  "type": "signal",
  "connectionId": "uuid",
  "kind": "offer",
  "payload": { "type": "offer", "sdp": "..." }
}
```

`kind`는 `offer | answer | ice`, payload는 64KiB 메시지 제한 내 JSON이다. 초당 영상·키보드 입력을 이 채널에 보내지 않는다. 실제 미디어와 입력은 이후 Client/Host의 전송 계층에서 처리한다. 신호 메시지는 이 서버가 SDP나 ICE의 의미까지 검증하지 않으므로 수신 앱에서도 검증해야 한다.

15초 간격 ping/pong으로 연결을 검사한다. 브라우저와 일반 WebSocket 라이브러리는 pong을 자동 처리한다. 세션 만료 검사도 이 간격으로 수행하고, 신호 전송 시에는 즉시 세션을 검사한다. 끊어진 소켓의 연결은 종료되며 승인 대기 요청은 정리 주기에서 만료 이벤트를 보낸다. HTTP 승인은 만료 시각을 즉시 검사한다.

## 이메일

개발 기본값 `MAIL_MODE=file`은 `.local/mail/*.json`에 메일을 저장한다. 이 파일에는 일회용 링크가 들어 있으므로 Git에서 제외한다. 링크는 `${PUBLIC_APP_URL}/verify-email#token=...` 또는 `/reset-password#token=...` 형태다. 후속 프론트엔드는 fragment에서 토큰을 읽어 위 API에 POST해야 한다. 서버는 토큰 소비용 GET 페이지를 제공하지 않는다.

운영은 `MAIL_MODE=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`를 설정한다. HTTPS `PUBLIC_APP_URL`과 SMTP 모드를 운영 시작 시 검증한다. SMTP 전송 실패는 비밀 정보 없는 서버 로그에 남기고 계정 생성은 유지한다. 현재 자동 재시도 큐는 없으므로 인증/재설정 메일을 재요청한다. 메일 요청 응답은 실제 수신을 보장하지 않는다.

## 검증

```powershell
npm run check
npm test
npm run build
```

MySQL 통합 테스트용 DB는 앱 DB와 분리한다. 기본 개발 컨테이너에서 한 번 생성한다.

```powershell
docker compose exec -T mysql mysql -uroot -plocal-root-only -e "CREATE DATABASE IF NOT EXISTS marionet_test; GRANT ALL PRIVILEGES ON marionet_test.* TO 'marionet'@'%';"
npm run test:integration
```

`.env`의 `TEST_DATABASE_URL`은 이름이 `_test`로 끝나는 전용 MySQL DB여야 한다. 테스트 명령은 이 URL에만 마이그레이션을 적용하며, 테스트가 생성한 무작위 이메일 계정만 정리한다. 실제 HTTP·WebSocket·MySQL을 사용해 인증, 토큰 만료·재사용·동시 사용, 계정 간 접근 차단, Host 승인, 신호 전달과 연결 종료를 검증한다.

## 운영 범위

현재는 **서버 프로세스 하나**를 실행한다. 온라인 소켓과 요청 제한 카운터가 메모리에 있으며, 시작할 때 이전 프로세스의 미종료 연결을 닫는다. 여러 인스턴스를 운영하려면 공유 presence, 이벤트 전달, 분산 rate limit과 연결 소유권 처리가 먼저 필요하다. 만료된 세션·토큰·접속 이력의 정기 정리 작업도 운영 규모에 맞춰 추가한다.

요청 본문 크기 제한, 인증 요청 제한, CORS 허용 목록과 Helmet을 적용했다. 프록시 뒤에서는 실제 신뢰하는 프록시 홉 수만 `TRUST_PROXY_HOPS`로 지정한다. Electron의 토큰은 렌더러의 localStorage 대신 메인 프로세스/OS 보안 저장소에서 관리한다. CORS를 계정 권한 검사 대용으로 사용하지 않는다.

이 서버가 구현하는 범위는 계정·Node·접속 승인·시그널링이다. 화면 캡처, 스트리밍, OS 키보드/마우스 입력, 다중 입력 배포, 매크로 실행, STUN/TURN 중계는 아직 구현하지 않았다. 연결 종료 이벤트를 받은 Client/Host는 미디어와 입력 세션도 직접 중단해야 한다.

참고: [Express 오류 처리](https://expressjs.com/en/guide/error-handling/), [Prisma MySQL 연결](https://www.prisma.io/docs/orm/v6/overview/databases/mysql), [Prisma 연결 URL](https://docs.prisma.io/docs/orm/v6/reference/connection-urls).

## Resend 테스트 메일

도메인이 없을 때는 Resend의 `onboarding@resend.dev`를 발신 주소로 사용할 수 있지만 Resend 가입 계정의 수신 주소로만 보낼 수 있습니다. 현재 테스트 수신 주소는 `kmc54320@gmail.com`입니다.

`server/.env`에 API 키를 직접 저장하고 다음 값을 사용합니다.

```dotenv
MAIL_MODE=resend
MAIL_FROM=MarioNet <onboarding@resend.dev>
RESEND_API_KEY=발급받은_키
RESEND_TEST_EMAIL=kmc54320@gmail.com
PUBLIC_APP_URL=http://127.0.0.1:4000
```

연결 테스트는 `node node_modules/tsx/dist/cli.mjs scripts/send-mail-test.ts`로 실행합니다. 테스트 주소 제한을 해제해 다른 사용자에게 보내려면 도메인을 Resend에서 인증하고 `MAIL_FROM`을 인증된 도메인 주소로 바꿉니다.

인증 메일 링크는 `/verify-email`에서 처리합니다. 링크 클릭 후 앱의 인증 대기 화면이 2.5초마다 상태를 확인해 자동으로 홈으로 이동합니다. 미인증 계정은 Node와 Connection API가 `EMAIL_NOT_VERIFIED`로 거절됩니다.
