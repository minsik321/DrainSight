CREATE TABLE vehicles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_code  VARCHAR(50) NOT NULL,
    vehicle_type  VARCHAR(20),
    route_id      INTEGER
);

CREATE TABLE drains (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    external_code       VARCHAR(50),
    name                VARCHAR(100) NOT NULL,
    lat                 REAL,
    lng                 REAL,
    elevation           REAL,
    is_flood_zone       BOOLEAN DEFAULT 0,
    priority_score      REAL DEFAULT 0,
    priority_reasons    TEXT,
    elevation_risk      REAL,
    flood_history_flag  REAL,
    staleness_risk      REAL,   -- 마지막 점검 후 경과일이 날씨 모드별 기준(2.2-2절)에 얼마나 근접했는지, 0~1
    occlusion_norm      REAL,
    last_status         VARCHAR(20),
    last_occlusion_pct  REAL,
    last_updated        TIMESTAMP,
    maintenance_note        TEXT,       -- 사람이 남긴 조치/점검 완료 메모 (v2.8, C9)
    maintenance_resolved_at TIMESTAMP   -- 그 조치/점검이 처리된 시각 — last_updated보다 최신이면
                                        -- "AI가 아직 재확인 전"인 해결 상태로 간주(9.4절 참조)
);

-- 빗물받이 1개가 여러 노선(쓰레기 수거 구역, 버스 노선 등)에 동시에 걸칠 수 있어
-- drains.route_id 단일 컬럼 대신 다대다 조인 테이블로 관리한다 (기획안 2.1·2.3절).
CREATE TABLE drain_routes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    drain_id INTEGER REFERENCES drains(id),
    route_id INTEGER NOT NULL
);

CREATE TABLE detections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    drain_id        INTEGER REFERENCES drains(id),
    vehicle_id      INTEGER REFERENCES vehicles(id),
    status          VARCHAR(20) NOT NULL,
    reason_code     VARCHAR(40),
    occlusion_pct   REAL,
    confidence      REAL,
    source          VARCHAR(20),
    captured_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 빗물받이의 물리적 판정과 분리된 장치·통신·파이프라인 운영 이벤트.
CREATE TABLE system_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    drain_id    INTEGER REFERENCES drains(id),
    vehicle_id  INTEGER REFERENCES vehicles(id),
    event_type  VARCHAR(40) NOT NULL,
    detail      TEXT,
    source      VARCHAR(20),
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_detections_drain_id ON detections(drain_id);
CREATE INDEX idx_system_events_drain_id ON system_events(drain_id);
CREATE INDEX idx_drain_routes_drain_id ON drain_routes(drain_id);
CREATE INDEX idx_drain_routes_route_id ON drain_routes(route_id);

-- 시드 데이터(vehicles/drains/detections/system_events 초기 행)는 여기 하드코딩하지 않고 db/drains_seed.json에서
-- backend/main.py가 최초 기동 시 읽어 삽입한다. 좌표를 추가/변경하려면 이 파일이 아니라
-- drains_seed.json을 수정할 것 — 이게 유일한 출처(single source of truth)다.
