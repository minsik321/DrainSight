# BEUM -> DrainSight 통합 API/DB 명세

문서 상태: 구현 기준안 v1.0
기준일: 2026-09-05
소유 컴포넌트: DrainSight Backend

이 문서는 BEUM을 이동형 Edge/Data Plane으로, DrainSight를 관제 Control Plane으로 연결하기 위한
공통 계약을 정의한다. 문서에 적힌 `MUST`는 구현자가 임의로 바꾸면 안 되는 계약이고, `SHOULD`는
MVP에서 지키되 운영 환경에 맞춰 조정할 수 있는 권고사항이다.

## 1. 결정 요약

1. 최종 서버는 DrainSight Backend다. BEUM `receiver_server.py`는 로컬 개발·통합 테스트용으로만 둔다.
2. 차량에서 서버로 보내는 원천 데이터 단위는 `drain_assessment` 한 건이다. 한 건은 한 빗물받이의 한 번의 방문 집계 결과다.
3. `Assessment`와 `Alert`를 분리한다. BEUM은 관측 사실인 Assessment를 보내고, DrainSight가 현재 상태·우선순위·Alert를 파생한다.
4. `CLEAR`를 포함해 정상 방문도 반드시 서버에 저장한다. 상태 변화가 없다는 이유로 방문을 버리지 않는다.
5. 최종 상태 vocabulary는 `CLEAR`, `OCCLUDED`, `BLOCKED`, `UNASSESSABLE` 네 가지로 통일한다.
6. `event_id`는 BEUM이 최초 생성해 spool에 저장하고, 재전송에서도 그대로 유지한다. 서버는 `event_id`를 전역 unique 멱등 키로 사용한다.
7. `drain_id`, `device_id`, `vehicle_code`는 모두 명시적으로 전송한다. GPS 좌표만으로 서버가 조용히 다른 빗물받이에 재매칭하지 않는다.
8. 차폐율은 `occlusion_pct` 하나만 canonical 필드로 사용한다. BEUM의 기존 `coverage_percent`는 canonical API에 사용하지 않는다.
9. 증거 이미지는 Assessment metadata와 별도의 multipart binary로 전송하고, 서버는 파일 참조와 해시만 DB에 저장한다.
10. `RESULT_MISSING`은 물리 상태가 아닌 시스템 이벤트다. `detections`에 넣지 않고 `system_events`에만 기록한다.

## 2. 책임 경계

```text
[차량 Pod / BEUM]
카메라 -> 모델 추론 -> ROI -> 시간축 필터 -> 방문 집계
GPS -> route 후보 내 drain 매칭
Assessment 생성 -> JPEG 선택 -> local spool -> retry upload
장치 센서와 heartbeat 전송
             |
             v
[DrainSight Backend]
계약 검증 -> 멱등성 확인 -> detection 이력 저장
drains 현재 snapshot 갱신 -> priority 재계산
weather/flood/elevation/maintenance 결합
Alert와 system event 파생 -> WebSocket broadcast
             |
             v
[DrainSight Frontend]
현재 상태, 이력, 증거 이미지, 차량 상태, 우선순위와 작업 대상 표시
```

### 2.1 BEUM이 책임지는 것

- 프레임별 추론과 시간축 노이즈 제거
- 한 방문의 시작·종료와 대표 GPS 선정
- `drain_id` 매칭 및 매칭 근거 전송
- 방문이 정상인지, 부분 차폐인지, 막힘인지, 판정 불가인지의 Edge 측정 결과 생성
- `event_id` 생성, metadata와 evidence의 local spool 저장
- 통신 실패 시 데이터 보존과 재전송
- `device_id`, `vehicle_code`, 모델 버전, GPS age, 센서 진단값 전달

### 2.2 DrainSight가 책임지는 것

- `drain_id`를 기준으로 한 자산의 현재 상태와 관측 이력 관리
- 차량·장치 등록 및 인증
- AI 판정과 사람의 유지보수 처리 분리
- 날씨 모드, 침수 이력, 고도, 미점검 경과를 결합한 priority 계산
- 관제용 Alert와 WebSocket 이벤트 파생
- `RESULT_MISSING` 등 시스템 오류의 별도 기록
- 증거 이미지 저장·조회와 보존 정책

### 2.3 계약에 포함하지 않는 것

- 원본 영상 스트림 또는 모든 프레임의 전송
- BEUM의 RL 학습 파일 또는 학습 데이터 전송
- Edge가 계산한 priority score의 신뢰
- Edge가 생성한 `critical` Alert를 물리 상태의 source of truth로 취급하는 것
- `receiver_server.py`의 SQLite를 DrainSight master DB로 복제하는 것

## 3. 현재 코드와 목표 계약의 차이

| 영역 | 현재 구현 | 목표 계약 | 필요한 조치 |
|---|---|---|---|
| BEUM 이벤트 생성 | `runtime.py`가 `gully_blockage` 중첩 payload를 만들고, `StorageQueue`가 뒤늦게 UUID를 추가 | 방문 종료 직전에 `drain_assessment`와 `event_id`를 함께 생성 | Assessment serializer 추가 |
| BEUM EventGate | `_last_status`, `_last_coverage`, `_last_emit_at`가 프로세스 전체 1세트 | Assessment는 모든 방문 전송, Alert dedupe 상태는 `(device_id, drain_id 또는 visit_id)`로 분리 | 상태 map 또는 방문 집계 경계 도입 |
| 정상 방문 | 기존 BEUM Gate는 첫 `clear`와 반복 정상 상태를 큐에 넣지 않음 | `CLEAR` Assessment도 저장 | Alert gate와 Assessment 전송 분리 |
| BEUM 상태 | `clear`, `warning`, `critical`, `no_gully` | 대문자 네 상태 | 숫자 차폐율로 canonical 상태 재계산 |
| 차폐율 | `coverage_percent`, `gully ∩ obstacle` 방식 | `occlusion_pct`, 계산 근거를 `measurement_basis`로 명시 | serializer에서 필드 변환 |
| DrainSight 수신 | `/api/detections`가 flat payload를 받고 event/image를 모름 | 같은 endpoint가 versioned envelope와 JSON/multipart를 받음 | schema와 handler 확장 |
| event identity | DrainSight `detections`에 `event_id` 없음 | `event_id` unique 필수 | DB migration과 중복 처리 |
| event time | DrainSight `create_detection()`이 서버 현재 시각을 `captured_at`으로 사용 | Edge의 `captured_at` 보존, 서버 수신 시각은 `received_at`으로 별도 기록 | 시간 파싱 및 컬럼 추가 |
| GPS | 계층마다 `latitude/longitude`, `lat/lon`, `lat/lng` 혼용 | canonical은 `location.lat/lng` | 한 번만 normalize |
| 차량 | 미등록 `vehicle_code`도 `vehicle_id=null`로 저장 가능 | 차량과 장치를 사전 등록하고 미등록은 거부 | registry 및 인증 |
| 이미지 | BEUM `/upload`만 multipart 지원, DrainSight에는 detection image API 없음 | `metadata` + `image` multipart와 DrainSight evidence API | evidence 저장소 추가 |
| retry | DrainSight edge는 메모리 retry, BEUM runtime은 spool/retry가 있으나 no-URL `NullUploader`가 성공으로 처리 | 2xx만 spool 삭제, 실패·재시작 후에도 pending 보존 | uploader 동작 수정 |
| telemetry | DrainSight edge는 `vehicle_code`, `lat`, `lng`만 전송 | `device_id`, `sequence`, `captured_at`, location 포함 | heartbeat schema 통일 |
| 무응답 상관관계 | DrainSight timer key가 drain 중심 | `(device_id, vehicle_id, drain_id)`와 visit window | 다중 차량 간섭 방지 |
| 수신기 | BEUM receiver가 별도 SQLite·SSE·webhook을 제공 | DrainSight Backend만 운영 수신기 | receiver는 fixture/e2e 전용 |

## 4. Canonical Assessment 계약

### 4.1 Endpoint

MVP에서는 기존 DrainSight 경로를 유지한다.

```text
POST /api/detections
```

`/api/v1/gully-events`, `/upload`, `/api/drainsight/gully-events`는 최종 운영 계약으로 사용하지 않는다.
두 레포를 같은 배포 단위로 전환하므로 운영 환경에서 두 개의 서로 다른 payload를 장기간 병행하지 않는다.

### 4.2 HTTP headers

| Header | 필수 | 규칙 |
|---|---:|---|
| `Authorization` | MUST | `Bearer <device-token>`. 토큰은 장치별로 발급한다. |
| `Idempotency-Key` | MUST | metadata의 `event_id`와 문자열로 정확히 같아야 한다. |
| `Content-Type` | MUST | 이미지가 없으면 `application/json`, 있으면 `multipart/form-data` |
| `User-Agent` | SHOULD | `BEUM/<runtime-version> device/<device_id>` 형식을 권장한다. |

### 4.3 Metadata JSON

아래 객체가 canonical metadata다. 이미지가 있는 경우 이 객체를 multipart의 `metadata` field에
`application/json`으로 넣는다.

```json
{
  "schema_version": "1.0",
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "drain_assessment",
  "source": "pi",
  "device_id": "BEUM-001",
  "vehicle_code": "CHEONAN-CAR-12",
  "visit_id": "8a6c4c83-6ea3-4a3e-8f1d-3f34f1bc2e11",
  "drain_id": 15231,
  "captured_at": "2026-09-05T01:10:22Z",
  "location": {
    "lat": 36.8151,
    "lng": 127.1139,
    "gps_age_s": 0.21,
    "speed_mps": 4.2,
    "source": "serial"
  },
  "match": {
    "method": "route_nearest",
    "route_id": 7,
    "distance_m": 2.4
  },
  "assessment": {
    "status": "BLOCKED",
    "occlusion_pct": 67.4,
    "confidence": 0.92,
    "reason_code": null
  },
  "aggregation": {
    "sample_count": 5,
    "measurable_sample_count": 4,
    "unassessable_sample_count": 1,
    "dropped_outlier_count": 0
  },
  "model": {
    "name": "beum-yolo-seg",
    "version": "2026.09.1",
    "method": "segmentation_mask",
    "measurement_basis": "drain_full_area_ratio"
  },
  "evidence": {
    "available": true,
    "filename": "550e8400-e29b-41d4-a716-446655440000.jpg",
    "content_type": "image/jpeg",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "sensors": {
    "battery_pct": 82.0,
    "rain_level": 0,
    "water_level": null,
    "cpu_temp_c": 54.3,
    "network_ok": true
  },
  "policy": {
    "mode": "medium",
    "roi_profile": "normal",
    "reason": "default"
  }
}
```

`sha256`는 예시 값이다. 실제 요청에서는 전송하는 JPEG의 SHA-256 hex digest를 사용한다.

### 4.4 Field rules

| 경로 | 타입 | 필수 | 규칙 |
|---|---|---:|---|
| `schema_version` | string | MUST | 현재 `"1.0"` |
| `event_id` | UUID string | MUST | Edge에서 한 번 생성. 재시작·retry에도 불변. |
| `event_type` | string | MUST | `drain_assessment` 고정 |
| `source` | enum | MUST | `pi` 또는 `simulator` |
| `device_id` | string | MUST | 장치 registry에 존재해야 한다. |
| `vehicle_code` | string | MUST | `vehicles.vehicle_code`에 존재해야 한다. |
| `visit_id` | UUID string | MUST | 한 drain 방문 집계 단위. 같은 visit에 여러 event를 만들지 않는다. |
| `drain_id` | integer | MUST | DrainSight master의 내부 ID. 외부 코드로 대체하지 않는다. |
| `captured_at` | ISO-8601 UTC string | MUST | 방문 대표 시각. 서버가 `received_at`과 혼동하지 않는다. |
| `location.lat` | number | MUST | `-90 <= lat <= 90` |
| `location.lng` | number | MUST | `-180 <= lng <= 180` |
| `location.gps_age_s` | number/null | MUST | 초 단위, 0 이상. matched assessment는 가능한 한 값 제공. |
| `location.speed_mps` | number/null | SHOULD | 0 이상. |
| `location.source` | string | SHOULD | `serial`, `replay`, `udp`, `simulator` 등 진단용. |
| `match.method` | enum | MUST | `route_nearest`, `global_nearest`, `manual` 중 하나 |
| `match.route_id` | integer/null | MUST | route 매칭이면 값, 전역 매칭이면 null |
| `match.distance_m` | number/null | MUST | 실제 선택된 master drain까지 거리. 알 수 없으면 null. |
| `assessment.status` | enum | MUST | `CLEAR`, `OCCLUDED`, `BLOCKED`, `UNASSESSABLE` |
| `assessment.occlusion_pct` | number/null | MUST | measurable이면 0~100, `UNASSESSABLE`이면 null |
| `assessment.confidence` | number/null | MUST | measurable이면 0~1, `UNASSESSABLE`이면 null 허용 |
| `assessment.reason_code` | enum/null | MUST | `UNASSESSABLE`일 때 `DRAIN_NOT_DETECTED`, 그 외에는 null |
| `aggregation.sample_count` | integer | MUST | 1 이상 |
| `aggregation.measurable_sample_count` | integer | MUST | 0 이상, `sample_count` 이하 |
| `aggregation.unassessable_sample_count` | integer | MUST | `sample_count - measurable_sample_count`와 같아야 한다. |
| `aggregation.dropped_outlier_count` | integer | MUST | 0 이상. `measurable_sample_count`에 포함된 표본 중 제거된 수다. |
| `model.name` | string | MUST | 추론 모델 또는 fallback 이름 |
| `model.version` | string | MUST | 모델 artifact/config 버전. 모르면 `unknown`을 쓰지 말고 simulator에서만 명시 허용. |
| `model.method` | enum | MUST | `segmentation_mask`, `bbox_estimate`, `none` |
| `model.measurement_basis` | enum | MUST | `drain_full_area_ratio`, `gully_obstacle_intersection`, `none` |
| `evidence.available` | boolean | MUST | multipart image 존재 여부와 일치해야 한다. |
| `evidence.filename` | string/null | conditional | `available=true`이면 basename만 허용하며 path separator를 포함하지 않는다. |
| `evidence.content_type` | string/null | conditional | `available=true`이면 `image/jpeg` 고정 |
| `evidence.sha256` | string/null | conditional | `available=true`이면 64자리 lowercase hex digest |
| `sensors` | object/null | SHOULD | 상태 진단용. physical assessment 계산의 source가 아니다. |
| `policy` | object/null | SHOULD | Edge 동작 추적용. 서버 priority 정책을 덮어쓰지 않는다. |

서버는 `status`와 `occlusion_pct`의 모순을 묵인하지 않는다. 아래 분류 규칙으로 재계산한 값과
다르면 `422 STATUS_OCCLUSION_MISMATCH`를 반환한다.

```text
occlusion_pct is null                         -> UNASSESSABLE
0 <= occlusion_pct < 15                       -> CLEAR
15 <= occlusion_pct < 60                     -> OCCLUDED
60 <= occlusion_pct <= 100                   -> BLOCKED
```

날씨 모드별 `40%`, `50%`, `70%`는 물리 상태 분류 경계가 아니다. 이는 이미 저장된 Assessment를
오늘 작업 대상으로 넣을지 결정하는 Backend gate다.

### 4.5 Assessment와 Alert의 관계

BEUM은 `alert`를 Assessment와 별도 HTTP resource로 보내지 않는다. Edge에서 판단한 `warning`이나
`critical`은 관측 부가 정보일 뿐이며, 관제용 Alert는 아래 순서로 DrainSight가 만든다.

```text
Assessment 수신
  -> immutable detections INSERT
  -> drains snapshot 갱신
  -> priority_score 재계산
  -> 현재 모드와 상태 전이를 보고 Alert projection 생성 또는 갱신
  -> dashboard WebSocket broadcast
```

최소 정책은 다음과 같다.

- `CLEAR`: Assessment는 저장하지만 blockage Alert를 만들지 않는다.
- `OCCLUDED`: 물리 상태는 저장하고, 현재 weather gate와 priority에 따라 작업 대상 또는 알림으로 파생한다.
- `BLOCKED`: 높은 우선순위 blockage Alert 후보가 된다. 동일한 `event_id` retry로 Alert를 중복 생성하지 않는다.
- `UNASSESSABLE`: blockage Alert로 취급하지 않는다. `DRAIN_NOT_DETECTED`와 마지막 실측 시각을 이용해 재점검 대상으로 다룬다.
- `RESULT_MISSING`: Assessment가 아니므로 blockage Alert로 취급하지 않는다.

Alert acknowledgement와 OPEN/ACKNOWLEDGED/RESOLVED lifecycle이 필요해지는 시점에는 별도 `alerts`
테이블을 추가한다. 사람의 실제 청소 완료는 그와 다른 개념이며 기존 `maintenance_resolved_at`에
기록한다.

## 5. HTTP body 전송 규칙

### 5.1 Evidence 없음

```http
POST /api/detections
Authorization: Bearer <device-token>
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
```

본문은 4.3 metadata와 같고 `evidence.available`은 `false`여야 한다. 이미지 binary를 base64로
넣지 않는다.

### 5.2 Evidence 있음

```http
POST /api/detections
Authorization: Bearer <device-token>
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: multipart/form-data
```

multipart field는 정확히 두 개다.

| field | content type | 설명 |
|---|---|---|
| `metadata` | `application/json` | 4.3의 canonical metadata. `evidence.available=true` |
| `image` | `image/jpeg` | 대표 evidence JPEG. metadata의 filename/hash와 일치해야 함 |

서버는 `has_image`를 클라이언트가 보낸 boolean으로 신뢰하지 않고 실제 파일 저장 성공 여부로
결정한다. metadata가 `available=true`인데 image가 없거나, image가 있는데 metadata가 `false`이면
`400 EVIDENCE_CONTRACT_MISMATCH`를 반환한다.

### 5.3 응답

신규 Assessment가 저장되면 `201`을 반환한다.

```json
{
  "status": "accepted",
  "duplicate": false,
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "detection_id": 381,
  "drain_id": 15231,
  "received_at": "2026-09-05T01:10:23.018Z",
  "evidence_stored": true,
  "alert": {
    "created": true,
    "severity": "HIGH"
  }
}
```

이미 같은 `event_id`와 동일한 metadata가 저장돼 있으면 `200`을 반환한다.

```json
{
  "status": "accepted",
  "duplicate": true,
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "detection_id": 381,
  "drain_id": 15231,
  "evidence_stored": true
}
```

duplicate 응답도 성공 응답이다. BEUM은 이 응답을 받은 뒤 local spool의 같은 event를 삭제한다.
duplicate 처리에서는 새 detection row, 새 Alert, 새 WebSocket notification을 만들지 않는다.

### 5.4 오류 응답

오류 body는 다음 형태로 통일한다.

```json
{
  "error": {
    "code": "DRAIN_NOT_FOUND",
    "message": "drain_id 15231 not found",
    "event_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

| HTTP | code | 재시도 |
|---:|---|---|
| 400 | `INVALID_JSON`, `EVIDENCE_CONTRACT_MISMATCH` | 하지 않음. local rejected 보관 |
| 401/403 | `UNAUTHORIZED_DEVICE`, `DISABLED_DEVICE` | token/registry 수정 전까지 하지 않음 |
| 404 | `DRAIN_NOT_FOUND` | 매칭 목록 갱신 후 수동 확인 |
| 409 | `EVENT_ID_CONFLICT` | payload를 바꾸지 말고 운영자 확인 |
| 413 | `EVIDENCE_TOO_LARGE` | 이미지 정책을 조정한 뒤 재생성 |
| 422 | `SCHEMA_VALIDATION_ERROR`, `STATUS_OCCLUSION_MISMATCH` | 코드/모델 버전 수정 전까지 하지 않음 |
| 429 | `RATE_LIMITED` | 지수 backoff 후 재시도 |
| 5xx | `SERVER_ERROR` | 지수 backoff 후 재시도 |
| network/timeout | - | 지수 backoff 후 재시도 |

## 6. 상태·차폐율·모델 의미

### 6.1 상태 매핑

| BEUM 현재 값 | canonical 처리 | 조건 |
|---|---|---|
| `clear` | `CLEAR` 또는 숫자 기준으로 재분류 | 숫자 `coverage_percent`가 있으면 raw 상태를 신뢰하지 않는다. |
| `warning` | 숫자 기준으로 `CLEAR`/`OCCLUDED`/`BLOCKED` 재분류 | 기존 20% 경계는 canonical 경계가 아니다. |
| `critical` | 숫자 기준으로 `OCCLUDED` 또는 `BLOCKED` 재분류 | 기존 50% 경계는 canonical 경계가 아니다. |
| `no_gully` | `UNASSESSABLE` | `occlusion_pct=null`, `reason_code=DRAIN_NOT_DETECTED` |
| `UNASSESSABLE` | `UNASSESSABLE` | 차폐율을 0 또는 100으로 바꾸지 않는다. |

BEUM의 기존 `BlockageAnalyzer`가 사용하는 `gully mask ∩ obstacle mask` 방식은 당장 폐기하지
않는다. 대신 `model.measurement_basis="gully_obstacle_intersection"`으로 남겨서 데이터의
계산 근거를 추적한다. 공통 모델로 전환한 뒤에는 `drain_full`과 `drain_area`를 이용한 아래 방식을
권장한다.

```text
occlusion_pct = (1 - visible_drain_area_px / full_drain_area_px) * 100
```

모델 계산 방식은 달라도 canonical API는 `occlusion_pct` 하나를 사용하고, 방식 차이는
`measurement_basis`와 `model` metadata로 보존한다.

### 6.2 UNASSESSABLE 규칙

- `drain_full` 또는 기준 drain 영역을 얻지 못한 방문은 `UNASSESSABLE`이다.
- `drain_area`만 검출됐다고 `CLEAR`로 추정하지 않는다.
- `UNASSESSABLE` Assessment도 `detections`에 저장한다.
- `drains.last_status`는 `UNASSESSABLE`로 갱신할 수 있지만, `last_occlusion_pct`는 null로 둔다.
- `drains.last_updated`는 실제로 측정 가능한 `CLEAR`, `OCCLUDED`, `BLOCKED`에 대해서만 갱신한다.
- 실패한 방문 때문에 마지막 정상 실측 시각을 현재 시각으로 리셋하지 않는다.
- `UNASSESSABLE`은 `RESULT_MISSING`과 다르다. 전자는 추론 결과가 도착했지만 판정 불가이고, 후자는 결과 자체가 도착하지 않은 시스템 문제다.

### 6.3 방문 집계

BEUM의 Edge pipeline은 다음 순서로 한 건을 만든다.

```text
여러 frame
  -> ROI filter
  -> temporal track confirmation
  -> 측정 가능한 frame 추출
  -> IQR outlier 제거
  -> confidence 가중 평균
  -> 상태 다수결(BLOCKED > OCCLUDED > CLEAR tie-break)
  -> 대표 GPS 선택
  -> Assessment 1건 생성
```

`sample_count`는 원본 방문 frame 수이고, `measurable_sample_count`와
`unassessable_sample_count`는 outlier 제거 전 표본 기준이다. `dropped_outlier_count`는 측정
가능 표본 중 IQR 제거 수다. 서버는 이 집계를 다시 수행하지 않고, 받은 결과를 관측 이력으로
보존한다.

## 7. Drain 식별과 GPS 계약

1. BEUM은 시작 시 `GET /api/drains`에서 master drain과 `route_ids`를 조회한다.
2. 차량의 `vehicle_code` 또는 `vehicle_route_id`를 이용해 후보 노선을 제한한다.
3. 후보 중 최근접 drain을 고르고 `drain_id`, `route_id`, `distance_m`, `method`를 Assessment에 넣는다.
4. 설정된 매칭 반경 밖이면 Assessment를 임의의 drain에 붙이지 않는다.
5. `drain_id`가 없는 관측은 `/api/detections`로 보내지 않는다. Edge local log에는 `MATCH_FAILED`를 남기고, 별도 미매칭 관측 수집 endpoint는 후속 범위로 둔다.
6. Backend는 `drain_id`가 master에 존재하는지 검증한다. 존재하지 않는 경우 최근접 drain으로 조용히 수정하지 않고 거부한다.
7. Backend는 `device_id`가 연결된 `vehicle_id`와 `vehicle_code`로 조회한 `vehicle_id`가 같은지 검증한다. 장치와 차량의 조합이 registry와 다르면 거부한다.
8. Backend는 운영 환경에서 `match.distance_m`과 master 좌표의 차이를 검증하거나 경고로 기록할 수 있다. 검증 결과는 원본 `drain_id`를 덮어쓰지 않는다.

canonical GPS object에는 `latitude`, `longitude`, `lon`, `lng`를 섞어 쓰지 않는다.

```json
{
  "lat": 36.8151,
  "lng": 127.1139,
  "gps_age_s": 0.21,
  "speed_mps": 4.2,
  "source": "serial"
}
```

## 8. Telemetry / Heartbeat 계약

Assessment와 별개로 차량은 주기적인 위치 heartbeat를 보낸다.

```text
POST /api/telemetry
```

```json
{
  "schema_version": "1.0",
  "device_id": "BEUM-001",
  "vehicle_code": "CHEONAN-CAR-12",
  "sequence": 1042,
  "captured_at": "2026-09-05T01:10:18Z",
  "location": {
    "lat": 36.8150,
    "lng": 127.1138,
    "gps_age_s": 0.08,
    "speed_mps": 4.1,
    "source": "serial"
  },
  "device_state": {
    "battery_pct": 82.0,
    "rain_level": 0,
    "water_level": null,
    "cpu_temp_c": 54.3,
    "spool_pending_count": 3
  }
}
```

Telemetry 규칙은 다음과 같다.

- `sequence`는 `device_id`별 단조 증가 값이다.
- 이미 처리한 sequence는 `200`과 `processed=false`로 응답하고 상태를 다시 변경하지 않는다.
- 낮은 sequence나 out-of-order packet도 물리 상태를 변경하지 않는다.
- 서버는 근접 drain 후보를 찾아 무응답 timer를 시작할 수 있지만, telemetry만으로 detection을 만들지 않는다.
- `RESULT_MISSING` timer key는 최소 `(device_id, vehicle_id, drain_id)`다. drain만 key로 쓰지 않는다.
- Assessment가 같은 장치·차량에 대해 timer window 안에 도착하면 해당 timer를 취소한다.
- 다른 차량의 Assessment가 timer를 취소하지 않는다.

성공 응답 예시는 다음과 같다.

```json
{
  "status": "accepted",
  "processed": true,
  "device_id": "BEUM-001",
  "vehicle_code": "CHEONAN-CAR-12",
  "sequence": 1042,
  "nearby_drain_ids": [15231],
  "server_time": "2026-09-05T01:10:18.104Z"
}
```

## 9. Spool·Evidence·Retry 계약

### 9.1 Spool lifecycle

```text
방문 집계 완료
  -> event_id 생성
  -> metadata + evidence를 pending에 기록
  -> 서버 upload
  -> 2xx accepted 또는 duplicate
  -> pending metadata/evidence 삭제
```

- `event_id`는 queue에 들어갈 때마다 새로 만들지 않는다.
- metadata와 image는 모두 준비된 뒤 pending manifest가 보이는 방식으로 저장한다. JSON을 먼저 노출하고 image를 나중에 쓰는 부분 원자성은 피한다.
- 임시 파일은 `.tmp` 등 별도 이름으로 작성한 뒤 atomic rename한다.
- spool 용량이 한계를 넘으면 오래된 event부터 정리할 수 있지만, 삭제 수와 event_id를 local log에 남긴다.
- 서버가 없거나 URL이 비어 있는 경우 uploader는 성공을 반환하지 않는다. 이벤트는 pending에 남아야 한다.

### 9.2 Retry rules

- HTTP `2xx`만 성공이다. `201` 신규와 `200` duplicate는 모두 성공이다.
- network timeout, connection error, `429`, `5xx`는 pending을 유지하고 exponential backoff로 재시도한다.
- `400`, `401`, `403`, `404`, `409`, `413`, `422`는 일반 재시도하지 않고 `rejected` 또는 별도 오류 디렉터리에 보관한다.
- 재시작 뒤에도 pending event를 검색해 재전송해야 한다. retry 횟수를 메모리에서 잃더라도 event를 버리면 안 된다.
- 한 event의 retry 실패가 카메라·추론 loop를 종료시키면 안 된다.
- multipart boundary는 retry마다 바뀌어도 되지만 `event_id`와 metadata는 바뀌면 안 된다.

### 9.3 Evidence storage

- 서버는 날짜별 디렉터리 또는 object storage key로 저장하되 key에 client filename 경로를 그대로 사용하지 않는다.
- 권장 key: `evidence/{UTC-date}/{event_id}.jpg`.
- DB에는 `event_id`, `storage_key`, `content_type`, `byte_size`, `sha256`, `created_at`을 저장한다.
- 서버는 수신한 bytes로 hash를 다시 계산해 metadata hash와 비교한다.
- 원본 JPEG의 보존 기간과 접근 권한은 운영 설정으로 관리한다.
- CLEAR evidence는 선택 사항이고, `OCCLUDED`·`BLOCKED`·`UNASSESSABLE`은 evidence 전송을 권장한다. evidence가 없다는 이유로 Assessment 자체를 무효화하지 않는다.

## 10. DrainSight DB 목표 모델

기존 `vehicles`, `drains`, `drain_routes`, `detections`, `system_events` 구조를 유지하면서 통합 식별자와
증거·장치 metadata를 보강한다. 물리 상태와 이력의 책임 분리는 유지한다.

### 10.1 `vehicles`

| 컬럼 | 타입 | 규칙 |
|---|---|---|
| `id` | integer PK | 내부 식별자 |
| `vehicle_code` | varchar(50) | NOT NULL, UNIQUE |
| `vehicle_type` | varchar(20) | garbage_truck, bus, patrol 등 |
| `route_id` | integer/null | 현재 주 담당 route |

### 10.2 `devices`

장치와 차량은 같은 개념으로 취급하지 않는다. Pod 교체나 한 차량의 여러 장치가 생길 수 있으므로
`device_id`를 별도 master로 둔다.

| 컬럼 | 타입 | 규칙 |
|---|---|---|
| `device_id` | varchar(64) PK | BEUM 장치 serial 또는 provisioned ID |
| `vehicle_id` | integer FK | 기본 장착 차량 |
| `token_hash` | varchar/text | raw token 저장 금지 |
| `enabled` | boolean | 비활성 장치 거부 |
| `last_seen_at` | timestamp/null | Assessment 또는 telemetry 수신 시각 |
| `last_telemetry_at` | timestamp/null | 마지막 heartbeat 수신 시각 |
| `spool_pending_count` | integer/null | 마지막 장치 상태 보고값, 진실값이 아닌 진단값 |
| `created_at` | timestamp | registry 생성 시각 |

### 10.3 `drains`

기존 컬럼을 유지한다.

| 컬럼 | 의미 |
|---|---|
| `id` | master `drain_id` |
| `external_code`, `name`, `lat`, `lng` | 자산 master 정보 |
| `route_ids` | `drain_routes` 관계로 제공 |
| `priority_score`, `priority_reasons` | Backend가 현재 weather mode로 계산 |
| `last_status` | 가장 최근 Assessment의 status, `UNASSESSABLE` 포함 |
| `last_occlusion_pct` | 가장 최근 Assessment의 숫자 차폐율. 최신 Assessment가 `UNASSESSABLE`이면 null |
| `last_updated` | 가장 최근 measurable Assessment의 `captured_at` |
| `maintenance_note`, `maintenance_resolved_at` | 사람이 처리한 사실. AI 결과를 덮어쓰지 않음 |

`last_status`가 최신 방문 결과를 나타내더라도 `last_updated`는 measurable 시각만 나타낸다.
두 시각을 같은 값으로 무조건 업데이트하지 않는다.

### 10.4 `detections`

`detections`는 append-only Assessment log다. 동일 `event_id`는 한 행만 존재해야 한다.

| 컬럼 | 타입 | 규칙 |
|---|---|---|
| `id` | integer PK | 서버 내부 detection ID |
| `event_id` | varchar(64) | NOT NULL, UNIQUE |
| `visit_id` | varchar(64) | NOT NULL, index |
| `device_id` | varchar(64) FK | NOT NULL |
| `drain_id` | integer FK | NOT NULL |
| `vehicle_id` | integer FK | NOT NULL |
| `status` | varchar(20) | canonical enum |
| `reason_code` | varchar(40) | `UNASSESSABLE`일 때만 값 |
| `occlusion_pct` | real/null | 0~100 또는 null |
| `confidence` | real/null | 0~1 또는 null |
| `lat`, `lng` | real | capture location |
| `gps_age_s` | real/null | 위치 신선도 |
| `gps_source` | varchar(20) | serial/replay/udp 등 |
| `match_method` | varchar(30) | route_nearest/global_nearest/manual |
| `match_distance_m` | real/null | 선택 drain까지 거리 |
| `match_route_id` | integer/null | 매칭에 사용한 route |
| `model_name` | varchar(100) | 모델 이름 |
| `model_version` | varchar(100) | artifact/config 버전 |
| `inference_method` | varchar(30) | segmentation_mask/bbox_estimate/none |
| `measurement_basis` | varchar(40) | 면적 계산 방식 |
| `sample_count` | integer | 방문 원본 표본 수 |
| `measurable_sample_count` | integer | 측정 가능 표본 수 |
| `unassessable_sample_count` | integer | 미판정 표본 수 |
| `dropped_outlier_count` | integer | 제거한 이상치 수 |
| `captured_at` | timestamp | Edge가 보낸 event 시각 |
| `received_at` | timestamp | Backend 수신 시각 |
| `raw_payload` | text/json | 감사·재처리용 원본 metadata |

필수 index는 다음과 같다.

```text
UNIQUE(event_id)
INDEX(drain_id, captured_at DESC)
INDEX(vehicle_id, captured_at DESC)
INDEX(device_id, captured_at DESC)
INDEX(visit_id)
```

### 10.5 `evidence`

한 Assessment에 대표 이미지 하나를 붙이는 MVP에서 시작하되, 별도 테이블로 두어 향후 여러 장으로
확장한다.

| 컬럼 | 타입 | 규칙 |
|---|---|---|
| `id` | integer PK | 내부 ID |
| `event_id` | varchar(64) FK | MVP에서는 UNIQUE |
| `storage_key` | text | 파일 또는 object storage 위치 |
| `content_type` | varchar(100) | 현재 `image/jpeg` |
| `byte_size` | integer | 서버가 계산 |
| `sha256` | varchar(64) | 서버가 계산·검증 |
| `created_at` | timestamp | 저장 시각 |

### 10.6 `system_events`

운영 오류는 Assessment와 분리한다. 기존 컬럼에 다음 identity fields를 보강한다.

| 컬럼 | 의미 |
|---|---|
| `event_type` | `RESULT_MISSING`, `MATCH_FAILED`, `GPS_STALE` 등 |
| `event_id` | 관련 Assessment가 있으면 연결, 없으면 null |
| `device_id` | 어느 Pod에서 발생했는지 |
| `vehicle_id` | 어느 차량인지 |
| `drain_id` | 관련 drain이 있으면 연결 |
| `dedupe_key` | 같은 timer event 중복 방지용 unique key |
| `detail` | 사람이 읽을 수 있는 설명 |
| `occurred_at` | 실제 발생 시각 |

`RESULT_MISSING`의 `dedupe_key`에는 최소 device, vehicle, drain, timer 시작 구간이 반영돼야 한다.

### 10.7 `alerts` 확장 시 모델

MVP에서는 Assessment 처리 결과와 WebSocket projection으로 시작할 수 있다. Alert acknowledge와
감사 이력이 필요해지면 다음을 추가한다.

```text
alerts(
    id, alert_id UNIQUE, source_event_id, drain_id, vehicle_id,
    kind, severity, status, created_at, acknowledged_at,
    resolved_at, resolution_note
)
```

`alerts`는 `detections`를 대체하지 않는다. Assessment가 삭제되거나 Alert로만 축약돼서는 안 된다.

## 11. Backend 처리 트랜잭션

canonical Assessment 한 건은 다음 순서로 하나의 DB transaction 안에서 처리한다.

1. 인증된 token에서 `device_id`를 확인한다.
2. `schema_version`, required fields, status/occlusion consistency를 검증한다.
3. `device_id`, `vehicle_code`, `drain_id`가 master에 존재하는지 확인한다.
4. `event_id`가 이미 있으면 저장된 canonical hash와 현재 payload를 비교한다.
5. 동일 payload이면 duplicate 성공을 반환하고 이후 단계를 실행하지 않는다.
6. 다른 payload이면 `409 EVENT_ID_CONFLICT`를 반환한다.
7. 신규 event의 evidence bytes를 임시 위치에 저장하고 hash를 검증한다.
8. `detections`에 Assessment를 append한다.
9. `drains`의 snapshot을 규칙에 따라 갱신한다.
10. current weather mode로 priority를 재계산한다.
11. 필요하면 Alert projection을 생성한다.
12. commit 후 evidence를 최종 위치로 확정한다.
13. commit된 결과만 WebSocket과 외부 notification에 broadcast한다.

증거 파일 저장과 DB commit 사이에 프로세스가 죽어도 orphan 파일을 찾고 정리할 수 있도록
`event_id` 기반 reconciliation job을 둔다.

## 12. 현재 API와의 통합 작업 순서

### Phase 0: 계약 고정

- 이 문서의 JSON fixture를 BEUM과 DrainSight 양쪽 테스트에서 사용한다.
- 상태, timestamp, GPS key, image field를 양쪽에서 같은 이름으로 맞춘다.
- 현재 legacy `/upload`와 adapter `/api/drainsight/gully-events`는 fixture 대상에서 제외한다.

### Phase 1: BEUM Edge

- config에 `device_id`, `vehicle_code`, `model_name`, `model_version`을 추가한다.
- visit 생성 시 `visit_id`와 `event_id`를 만든다.
- `BlockageEventGate`를 Assessment 생성 gate에서 분리한다.
- 모든 방문에서 `CLEAR`와 `UNASSESSABLE`까지 canonical Assessment를 만든다.
- 기존 `coverage_percent`와 lowercase status를 serializer에서 canonical 형태로 변환한다.
- `location`, `match`, `aggregation`, `model` metadata를 채운다.
- `StorageQueue`가 metadata와 evidence manifest를 함께 atomic하게 보존하도록 바꾼다.
- `NullUploader`가 성공으로 처리되지 않게 한다.
- `UploadWorker`가 2xx/duplicate에서만 pending을 삭제하게 한다.
- telemetry에 `device_id`, ISO `captured_at`, `sequence`, `gps_age_s`를 추가한다.
- 매칭 실패는 임의 drain에 전송하지 않고 local system log에 남긴다.

### Phase 2: DrainSight Backend

- `DetectionCreate`를 canonical envelope schema로 교체하거나 명시적 parser를 둔다.
- `event_id`, `captured_at`, `received_at`, device/model/GPS/evidence 필드를 migration한다.
- `devices` registry와 장치별 Bearer authentication을 추가한다.
- `/api/detections`에 JSON/multipart 수신을 구현한다.
- `event_id` unique conflict/duplicate 처리와 transaction을 구현한다.
- evidence 저장 및 `GET /api/detections/{event_id}/evidence`를 추가한다.
- 서버가 payload `captured_at`을 보존하도록 바꾼다.
- 미등록 `vehicle_code`를 silent null로 저장하지 않는다.
- `RESULT_MISSING` timer와 query를 `(device_id, vehicle_id, drain_id)` 기준으로 고친다.
- `UNASSESSABLE` action gate를 기획 의도와 코드가 같은 의미를 갖도록 정리한다.

### Phase 3: Dashboard

- history response에 `event_id`, `device_id`, model, GPS age, evidence URL을 노출한다.
- detail panel에 Assessment와 system event를 계속 분리한다.
- evidence가 있으면 실제 해당 event 이미지를 보여준다. 정적 sample 이미지를 대체한다.
- WebSocket message type을 `drain_assessment`, `drain_alert`, `system_event`로 구분한다.
- Alert 표시와 `maintenance_resolved_at` 표시를 서로 다른 상태로 렌더링한다.
- `captured_at`과 `last_updated`/`maintenance_resolved_at`의 semantics를 UI에 반영한다.

### Phase 4: 운영 hardening

- SQLite에서 PostgreSQL/PostGIS로 전환할 migration을 Alembic 등으로 관리한다.
- CORS wildcard를 실제 dashboard origin으로 제한한다.
- device/operator/admin 권한을 분리한다.
- WebSocket broadcast state를 단일 프로세스 메모리 밖으로 옮긴다.
- device heartbeat, last seen, spool backlog를 관제 화면에 추가한다.
- evidence 보존·삭제와 개인정보 접근 audit을 추가한다.

## 13. 수용 기준

### 13.1 Contract

- [ ] canonical Assessment fixture가 `CLEAR`, `OCCLUDED`, `BLOCKED`, `UNASSESSABLE` 각각 검증된다.
- [ ] `UNASSESSABLE`은 `occlusion_pct=null`, `DRAIN_NOT_DETECTED`를 강제한다.
- [ ] 상태와 차폐율 경계가 15/60에서 일치한다.
- [ ] 모든 timestamp가 UTC ISO-8601로 왕복된다.
- [ ] GPS field가 `location.lat/lng`로만 들어온다.
- [ ] `device_id`, `vehicle_code`, `drain_id`가 누락되면 거부된다.

### 13.2 Delivery

- [ ] 같은 `event_id`를 10회 재전송해도 detection row는 1개다.
- [ ] 같은 `event_id`에 다른 payload를 보내면 `409`다.
- [ ] duplicate retry가 Alert와 WebSocket notification을 중복 생성하지 않는다.
- [ ] 서버 timeout 동안 metadata와 JPEG가 pending에 남는다.
- [ ] 프로세스 재시작 후 pending event가 재전송된다.
- [ ] 2xx를 받은 뒤에만 metadata와 JPEG가 삭제된다.
- [ ] multipart evidence가 서버에서 hash 검증되고 조회된다.

### 13.3 Domain behavior

- [ ] CLEAR 방문도 `detections`와 `last_updated`에 반영된다.
- [ ] UNASSESSABLE 방문은 이력에 남지만 measurable `last_updated`를 리셋하지 않는다.
- [ ] 사람이 resolve해도 AI `last_status`와 `last_occlusion_pct`가 CLEAR로 위조되지 않는다.
- [ ] 서로 다른 차량이 같은 drain을 지나도 `RESULT_MISSING` timer가 서로 취소되지 않는다.
- [ ] A drain의 BLOCKED 뒤 B drain의 CLEAR가 A의 상태 전이로 해석되지 않는다.
- [ ] 정상 Assessment와 blockage Alert가 별도 개념으로 화면에 나타난다.

### 13.4 Operational

- [ ] 미등록 device와 vehicle이 인증 또는 master validation에서 차단된다.
- [ ] CORS와 변경 API 인증이 운영 설정으로 제한된다.
- [ ] DB migration이 신규 checkout에서 재현된다.
- [ ] receiver server는 최종 운영 경로로 참조되지 않는다.

## 14. 테스트 시나리오 표

| 시나리오 | 기대 결과 |
|---|---|
| CLEAR 0% 방문 | detection 1건, `last_status=CLEAR`, `last_updated` 갱신, blockage Alert 없음 |
| OCCLUDED 30% 방문 | detection 1건, `last_status=OCCLUDED`, priority 재계산 |
| BLOCKED 78% + JPEG | detection/evidence 저장, evidence URL 반환, Alert projection 가능 |
| drain_full 미검출 | `UNASSESSABLE`, null occlusion, reason code 저장 |
| matched drain 없음 | detection 생성 안 함, local `MATCH_FAILED`, 임의 drain 갱신 없음 |
| 동일 event_id 동일 payload | 2xx duplicate, row/Alert/WS 추가 없음 |
| 동일 event_id 다른 payload | 409, 기존 row 보존 |
| 이미지 전송 중 network 단절 | pending 유지, retry 후 성공 시에만 삭제 |
| telemetry A 근접 후 B detection 도착 | A의 `RESULT_MISSING` timer는 B 때문에 취소되지 않음 |
| 한 visit에서 일부 frame 미검출 | measurable frame이 있으면 집계, 전부 미검출이면 UNASSESSABLE |
| 사람이 BLOCKED drain resolve | maintenance timestamp만 갱신, AI 판정 이력 유지 |

## 15. 참조 구현 및 문서

### DrainSight

- `backend/schemas.py`: 현재 `DetectionCreate`, `TelemetryIn`, 상태 enum
- `backend/main.py`: 현재 detection/telemetry/priority/maintenance 처리
- `backend/models.py`: 현재 `vehicles`, `drains`, `detections`, `system_events` ORM
- `edge/run.py`: 방문 집계와 현재 flat detection payload 생성
- `edge/infer.py`: `drain_area`/`drain_full` 차폐율과 15/60 상태 경계
- `edge/sender.py`: 현재 HTTP retry 구현
- `edge/gps_match.py`: route 후보 기반 최근접 매칭
- `Drain_Vision_Pod_기획안_v2.md`: 제품 의도와 기존 MVP API/DB 구조
- `CLAUDE.md`, `AGENTS.md`: repository architecture와 문서 규칙

### BEUM

- `gully_system/runtime.py`: 현재 runtime payload, event gate, evidence enqueue
- `gully_system/blockage.py`: 현재 `BlockageAnalyzer`와 전역 상태 EventGate
- `gully_system/data_manager.py`: local spool과 atomic file write
- `gully_system/uploader.py`: HTTP multipart와 retry worker
- `gully_system/gps.py`: GPS fix와 `age_s`
- `gully_system/temporal_filter.py`: IoU 기반 track confirmation
- `receiver_server.py`: 개발용 `/upload`, image 저장, legacy receiver API
- `drainsight_adapter.py`: 개발용 SSE/WebSocket/GeoJSON adapter
- `schemas.py`: 현재 BEUM legacy event/detection/telemetry schema

이 문서가 확정되면 다음 구현의 기준은 기존 receiver payload가 아니라 이 문서의
`drain_assessment` contract와 `event_id` 멱등성이다.
