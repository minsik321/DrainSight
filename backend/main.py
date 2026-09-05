# 실행: pip install -r backend/requirements.txt
#       uvicorn main:app --reload --app-dir backend
# API 키 등은 backend/.env에서 읽음 (.env.example 참고)
import asyncio
import json
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import elevation
import flood
import forecast
import routing
from geo import haversine_m
from models import Base, Detection, Drain, SystemEvent, Vehicle
from schemas import (
    DetectionCreate,
    DetectionOut,
    DrainOut,
    ResolveRequest,
    RoutePlanRequest,
    SystemEventOut,
    TelemetryIn,
    VehicleCreate,
    VehicleOut,
    WeatherAlertOut,
    WeatherModeRequest,
)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "drainvision.db"
INIT_SQL_PATH = BASE_DIR.parent / "db" / "init.sql"
SEED_JSON_PATH = BASE_DIR.parent / "db" / "drains_seed.json"

if not DB_PATH.exists():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(INIT_SQL_PATH.read_text(encoding="utf-8"))

    # 좌표는 init.sql이 아니라 drains_seed.json이 유일한 출처 — drain을 추가하려면
    # 그 파일에 항목만 추가하면 됨(코드 변경 불필요).
    seed = json.loads(SEED_JSON_PATH.read_text(encoding="utf-8"))
    vehicle_ids = {}
    for v in seed.get("vehicles", []):
        cur = conn.execute(
            "INSERT INTO vehicles (vehicle_code, vehicle_type, route_id) VALUES (?, ?, ?)",
            (v["vehicle_code"], v.get("vehicle_type"), v.get("route_id")),
        )
        vehicle_ids[v["vehicle_code"]] = cur.lastrowid
    drain_ids = {}
    for d in seed.get("drains", []):
        cur = conn.execute(
            "INSERT INTO drains (external_code, name, lat, lng, elevation, is_flood_zone) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                d["external_code"],
                d["name"],
                d["lat"],
                d["lng"],
                d.get("elevation"),
                int(bool(d.get("is_flood_zone", False))),
            ),
        )
        drain_id = cur.lastrowid
        drain_ids[d["external_code"]] = drain_id
        for route_id in d.get("route_ids", []):
            conn.execute(
                "INSERT INTO drain_routes (drain_id, route_id) VALUES (?, ?)",
                (drain_id, route_id),
            )
    # 발표용 이력도 같은 시드에서 만든다. captured_days_ago는 DB를 새로 만드는 시점을
    # 기준으로 계산하므로, 고정 날짜 때문에 모든 기록이 수개월 전으로 보이지 않는다.
    # UNASSESSABLE은 추론은 실행됐지만 대상 인식에 실패해 차폐율 판정이 불가능한 결과다.
    seed_now = datetime.utcnow()
    # drain_id -> 이 drain에 대해 시드에서 만들어진 모든 판정의 (시각, 상태, 차폐율).
    # 스냅샷(last_status/last_occlusion_pct)은 종류를 안 가리는 최신 판정으로 채우지만,
    # last_updated(미점검 경과일 기준 시각)는 실제로 측정된(=UNASSESSABLE이 아닌) 판정
    # 중 최신 것으로만 채운다 — create_detection()과 동일한 원칙(v2.14).
    seeded_by_drain: dict[int, list[tuple]] = {}
    for item in seed.get("detections", []):
        drain_id = drain_ids[item["external_code"]]
        vehicle_id = vehicle_ids.get(item.get("vehicle_code"))
        captured_at = seed_now - timedelta(days=float(item.get("captured_days_ago", 0)))
        status = item["status"]
        occlusion_pct = item.get("occlusion_pct")
        conn.execute(
            "INSERT INTO detections "
            "(drain_id, vehicle_id, status, reason_code, occlusion_pct, confidence, source, captured_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                drain_id,
                vehicle_id,
                status,
                item.get("reason_code"),
                occlusion_pct,
                item.get("confidence"),
                item.get("source", "simulator"),
                captured_at,
            ),
        )
        seeded_by_drain.setdefault(drain_id, []).append((captured_at, status, occlusion_pct))

    for drain_id, rows in seeded_by_drain.items():
        rows.sort(key=lambda r: r[0])
        _, latest_status, latest_occlusion = rows[-1]
        real_rows = [r for r in rows if r[1] != "UNASSESSABLE"]
        last_updated = real_rows[-1][0] if real_rows else None
        conn.execute(
            "UPDATE drains SET last_status = ?, last_occlusion_pct = ?, last_updated = ? WHERE id = ?",
            (latest_status, latest_occlusion, last_updated, drain_id),
        )
    for item in seed.get("system_events", []):
        conn.execute(
            "INSERT INTO system_events "
            "(drain_id, vehicle_id, event_type, detail, source, occurred_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                drain_ids.get(item.get("external_code")),
                vehicle_ids.get(item.get("vehicle_code")),
                item["event_type"],
                item.get("detail"),
                item.get("source", "backend"),
                seed_now - timedelta(days=float(item.get("occurred_days_ago", 0))),
            ),
        )
    conn.commit()
    conn.close()

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)
Base.metadata.create_all(bind=engine)

# 기존 데모 DB도 삭제하지 않고 새 상태 모델로 올린다. create_all은 기존 테이블에 컬럼을
# 추가하지 않으므로 reason_code만 명시적으로 보강하고, 과거 UNCHECKED 판정 행은 물리 상태가
# 아닌 RESULT_MISSING 시스템 이벤트로 이동한다.
with sqlite3.connect(DB_PATH) as migration_conn:
    detection_columns = {
        row[1] for row in migration_conn.execute("PRAGMA table_info(detections)").fetchall()
    }
    if "reason_code" not in detection_columns:
        migration_conn.execute("ALTER TABLE detections ADD COLUMN reason_code VARCHAR(40)")
    migration_conn.execute(
        "UPDATE detections SET status = 'UNASSESSABLE', reason_code = 'DRAIN_NOT_DETECTED' "
        "WHERE status = 'UNDETECTED'"
    )
    migration_conn.execute(
        "INSERT INTO system_events (drain_id, vehicle_id, event_type, detail, source, occurred_at) "
        "SELECT d.drain_id, d.vehicle_id, 'RESULT_MISSING', "
        "'과거 UNCHECKED 이력에서 이전됨', 'backend', d.captured_at "
        "FROM detections d WHERE d.status = 'UNCHECKED' AND NOT EXISTS ("
        "SELECT 1 FROM system_events e WHERE e.drain_id = d.drain_id "
        "AND e.vehicle_id IS d.vehicle_id AND e.event_type = 'RESULT_MISSING' "
        "AND e.occurred_at = d.captured_at)"
    )
    migration_conn.execute("DELETE FROM detections WHERE status = 'UNCHECKED'")

app = FastAPI(title="Drain Vision Pod API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, payload):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()

CLOSE_PASS_RADIUS_M = 5.0
SILENCE_GRACE_SECONDS = float(os.environ.get("SILENCE_GRACE_SECONDS", "10"))

# drain_id -> 진행 중인 무응답 판정 타이머. 근접 텔레메트리가 새로 오면 취소 후 재시작된다.
pending_checks: dict[int, asyncio.Task] = {}

# 개별 drain이 아니라 천안시 전역 단위 상태 — 인메모리로만 유지(재시작 시 초기화, 데모 스코프에서는 충분).
# mode/occlusion_threshold는 서버 기동 직후(최초 refresh 이전)엔 NORMAL 기준값으로 시작한다.
weather_alert_state: dict = {
    "active": False,
    "message": None,
    "rain_prob": None,
    "pcp_mm": None,
    "pcp_3h_mm": None,
    "mode": forecast.NORMAL,
    "occlusion_threshold": forecast.OCCLUSION_ACTION_THRESHOLD[forecast.NORMAL],
    "staleness_threshold_days": forecast.STALENESS_THRESHOLD_DAYS[forecast.NORMAL],
    "weight_profile": {
        "elevation": forecast.WEIGHT_PROFILES[forecast.NORMAL][0],
        "flood_history": forecast.WEIGHT_PROFILES[forecast.NORMAL][1],
        "staleness": forecast.WEIGHT_PROFILES[forecast.NORMAL][2],
        "occlusion": forecast.WEIGHT_PROFILES[forecast.NORMAL][3],
    },
    "issued_at": None,
    # True면 발표자가 데모용으로 강제 고정한 모드 — refresh_weather_alert(실제 예보 갱신)가
    # 건드리지 않고, /api/weather/mode에 mode="AUTO"를 보내야만 풀린다(v2.9).
    "manual_override": False,
}


def is_resolved(drain: Drain) -> bool:
    """사람이 조치/점검 완료로 표시한 뒤로, AI가 그것보다 더 최신의 실제 판정을 보고한
    적이 없으면 True — 즉 "지금 이 순간 사람의 처리가 아직 유효하다"는 뜻(9.4절, C9)."""
    if drain.maintenance_resolved_at is None:
        return False
    return drain.last_updated is None or drain.maintenance_resolved_at >= drain.last_updated


def last_checked_at(drain: Drain):
    """staleness 계산의 기준 시각 — AI의 마지막 실측(last_updated)과 사람의 마지막 조치/점검
    (maintenance_resolved_at) 중 더 최신인 쪽. 사람이 방금 처리했다면 그 순간부터 미점검
    경과일이 다시 0에서 쌓이기 시작해야 하기 때문(둘 다 없으면 None = 한 번도 확인 안 됨)."""
    candidates = [t for t in (drain.last_updated, drain.maintenance_resolved_at) if t is not None]
    return max(candidates) if candidates else None


def needs_action(drain: Drain, now: datetime | None = None) -> bool:
    """현재 날씨 모드 기준으로 현장 점검 목록에 포함할지 한 곳에서 판정한다.

    "확인된 지 얼마나 됐는가"(staleness)가 UNASSESSABLE까지 포함한 단일 시간 기준이다 —
    last_updated는 실제로 측정된(=UNASSESSABLE이 아닌) 판정에만 갱신되므로(create_detection
    참고), 판정 불가가 반복되는 동안에도 "마지막으로 진짜 상태를 안 시점"부터 정직하게
    경과일이 쌓인다. 한 번도 실측된 적 없으면(checked is None) 항상 최대로 시급하다고 본다 —
    그래서 여기엔 last_status가 None/UNASSESSABLE인지 따로 검사하는 조건이 없다."""
    now = now or datetime.utcnow()
    checked = last_checked_at(drain)
    stale = checked is None or (
        (now - checked).total_seconds() / 86400.0
        >= weather_alert_state["staleness_threshold_days"]
    )
    if is_resolved(drain):
        return stale
    return (drain.last_occlusion_pct or 0) >= weather_alert_state["occlusion_threshold"] or stale


def drain_out(drain: Drain) -> DrainOut:
    result = DrainOut.model_validate(drain)
    result.requires_action = needs_action(drain)
    return result


def recalc_priority_for_drain(db: Session, drain: Drain) -> None:
    elevations = [e for (e,) in db.query(Drain.elevation).all() if e is not None]
    min_elev = min(elevations) if elevations else None
    max_elev = max(elevations) if elevations else None

    breakdown = forecast.compute_priority_breakdown(
        elevation=drain.elevation,
        min_elev=min_elev,
        max_elev=max_elev,
        is_flood_zone=drain.is_flood_zone,
        last_occlusion_pct=drain.last_occlusion_pct,
        last_updated=last_checked_at(drain),
        now=datetime.utcnow(),
        weather_mode=weather_alert_state["mode"],
    )
    drain.priority_score = breakdown["score"]
    drain.priority_reasons = json.dumps(breakdown["reasons"], ensure_ascii=False)
    drain.elevation_risk = breakdown["elevation_risk"]
    drain.flood_history_flag = breakdown["flood_history_flag"]
    drain.staleness_risk = breakdown["staleness_risk"]
    drain.occlusion_norm = breakdown["occlusion_norm"]


def _apply_weather_mode(
    mode: str,
    pop: float | None = None,
    pcp_mm: float | None = None,
    pcp_3h_mm: float | None = None,
    manual: bool = False,
) -> None:
    """weather_alert_state의 모드-파생 필드(게이트 임계값·가중치·배너)를 채운다. 실제 예보
    갱신(refresh_weather_alert)과 발표자용 수동 전환(set_weather_mode)이 이 로직을 공유한다.
    pop/pcp_mm/pcp_3h_mm을 안 주면(수동 전환) 마지막으로 관측된 값을 그대로 유지한다."""
    active = mode == forecast.HEAVY_RAIN
    threshold = forecast.OCCLUSION_ACTION_THRESHOLD[mode]
    staleness_days = forecast.STALENESS_THRESHOLD_DAYS[mode]
    w1, w2, w3, w4 = forecast.WEIGHT_PROFILES[mode]

    weather_alert_state["active"] = active
    weather_alert_state["mode"] = mode
    weather_alert_state["occlusion_threshold"] = threshold
    weather_alert_state["staleness_threshold_days"] = staleness_days
    weather_alert_state["weight_profile"] = {
        "elevation": w1, "flood_history": w2, "staleness": w3, "occlusion": w4,
    }
    weather_alert_state["issued_at"] = datetime.utcnow().isoformat()
    if pop is not None:
        weather_alert_state["rain_prob"] = pop
    if pcp_mm is not None:
        weather_alert_state["pcp_mm"] = pcp_mm
    if pcp_3h_mm is not None:
        weather_alert_state["pcp_3h_mm"] = pcp_3h_mm

    if not active:
        weather_alert_state["message"] = None
    elif manual:
        weather_alert_state["message"] = (
            f"[데모 수동 전환] 폭우 모드 — 전체 구간 사전 준설 점검 권장 "
            f"(점검 기준 차폐율 {threshold:.0f}%·미점검 {staleness_days:.0f}일로 하향)"
        )
    else:
        weather_alert_state["message"] = (
            f"내일 천안시 전역에 강수확률 {weather_alert_state['rain_prob']:.0f}% 호우 예보 — "
            f"전체 구간 사전 준설 점검 권장 (점검 기준 차폐율 {threshold:.0f}%·미점검 {staleness_days:.0f}일로 하향)"
        )


async def refresh_weather_alert() -> None:
    """천안시 대표 좌표 1곳의 내일자 강수확률·강수량을 조회해 날씨 모드(NORMAL/RAIN/HEAVY_RAIN)를
    갱신하고 브로드캐스트한다(2.2-2절, v2.5).

    이 모드가 이후 모든 drain의 우선순위 가중치 프로필(recalc_priority_for_drain)과 동선 추천의
    기본 점검 임계값(plan_route)에 동시에 반영된다 — drain별로 예보를 반영하는 게 아니라
    시스템 전역에서 "지금은 어떤 모드인가"만 결정하는 구조는 2.2절 개정 취지와 동일하다.
    큰 배너(active=true)는 그중 가장 심각한 HEAVY_RAIN일 때만 띄운다.

    발표자가 /api/weather/mode로 모드를 수동 고정한 동안에는(v2.9) 실제 예보를 조회해도
    덮어쓰지 않고 조용히 리턴한다 — 데모 중 우선순위 재계산 버튼을 눌러도 강제한 모드가
    풀리지 않게 하기 위함. mode="AUTO"를 보내야만 고정이 풀리고 이 함수가 다시 동작한다.
    """
    if weather_alert_state["manual_override"]:
        return
    weather = forecast.fetch_tomorrow_weather()
    _apply_weather_mode(
        weather["mode"], pop=weather["pop"], pcp_mm=weather["pcp_mm"], pcp_3h_mm=weather["pcp_3h_mm"]
    )
    await manager.broadcast({"type": "weather_alert", **weather_alert_state})


@app.post("/api/detections", response_model=DrainOut)
async def create_detection(payload: DetectionCreate):
    db = SessionLocal()
    try:
        drain = db.query(Drain).filter(Drain.id == payload.drain_id).first()
        if drain is None:
            raise HTTPException(status_code=404, detail=f"drain_id {payload.drain_id} not found")

        vehicle = db.query(Vehicle).filter(Vehicle.vehicle_code == payload.vehicle_code).first()
        vehicle_id = vehicle.id if vehicle else None

        now = datetime.utcnow()
        detection = Detection(
            drain_id=drain.id,
            vehicle_id=vehicle_id,
            status=payload.status,
            reason_code=payload.reason_code,
            occlusion_pct=payload.occlusion_pct,
            confidence=payload.confidence,
            source=payload.source,
            captured_at=now,
        )
        db.add(detection)

        drain.last_status = payload.status
        drain.last_occlusion_pct = payload.occlusion_pct
        # UNASSESSABLE은 "측정 실패"이지 실측이 아니므로 미점검 경과일 시계(last_updated)를
        # 갱신하지 않는다 — 안 그러면 판정 불가가 반복될 때마다 "방금 확인함"으로 보여서
        # needs_action의 staleness 게이트가 절대 시급해지지 않는다(2.2-2절, v2.14).
        if payload.status != "UNASSESSABLE":
            drain.last_updated = now

        recalc_priority_for_drain(db, drain)

        db.commit()
        db.refresh(drain)

        result = drain_out(drain)
        await manager.broadcast(result.model_dump(mode="json"))
        return result
    finally:
        db.close()


@app.post("/api/drains/{drain_id}/resolve", response_model=DrainOut)
async def resolve_drain(drain_id: int, payload: ResolveRequest):
    """사람이 직접 조치(청소)했거나 점검했음을 기록한다(C9). AI 판정(last_status 등)은
    실측이 아니므로 위조하지 않고 그대로 두되, maintenance_resolved_at을 남겨 이 시점부터
    "사람이 처리했다"는 상태로 취급한다 — route/plan 게이트는 이걸 보고 이 drain을 당장의
    점검 목록에서 빼주지만(is_resolved), 미점검 경과일 게이트는 이 시각부터 다시 쌓이기
    시작해 결국 차량 재확인 대상으로 자연스럽게 돌아온다(last_checked_at)."""
    db = SessionLocal()
    try:
        drain = db.query(Drain).filter(Drain.id == drain_id).first()
        if drain is None:
            raise HTTPException(status_code=404, detail=f"drain_id {drain_id} not found")

        default_note = (
            "조치 완료 — 차량 순찰로 추후 재확인 예정"
            if drain.last_status in ("BLOCKED", "OCCLUDED")
            else "사람이 직접 점검 완료 — 차량 순찰로 추후 재확인 예정"
        )
        drain.maintenance_note = payload.note or default_note
        drain.maintenance_resolved_at = datetime.utcnow()

        recalc_priority_for_drain(db, drain)

        db.commit()
        db.refresh(drain)

        result = drain_out(drain)
        await manager.broadcast(result.model_dump(mode="json"))
        return result
    finally:
        db.close()


@app.get("/api/drains", response_model=list[DrainOut])
def list_drains():
    db = SessionLocal()
    try:
        drains = db.query(Drain).all()
        return [drain_out(d) for d in drains]
    finally:
        db.close()


@app.get("/api/drains/{drain_id}/history", response_model=list[DetectionOut])
def drain_history(drain_id: int, limit: int = 200, offset: int = 0):
    db = SessionLocal()
    try:
        rows = (
            db.query(Detection, Vehicle.vehicle_code, Vehicle.vehicle_type)
            .outerjoin(Vehicle, Detection.vehicle_id == Vehicle.id)
            .filter(Detection.drain_id == drain_id)
            .order_by(Detection.captured_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        results = []
        for detection, vehicle_code, vehicle_type in rows:
            out = DetectionOut.model_validate(detection)
            out.vehicle_code = vehicle_code
            out.vehicle_type = vehicle_type
            results.append(out)
        return results
    finally:
        db.close()


@app.get("/api/system-events", response_model=list[SystemEventOut])
def system_events(drain_id: int | None = None, limit: int = 200, offset: int = 0):
    """물리적 판정과 분리된 장치·통신 이벤트. RESULT_MISSING은 drain 상태를 변경하지 않는다."""
    db = SessionLocal()
    try:
        query = db.query(SystemEvent)
        if drain_id is not None:
            query = query.filter(SystemEvent.drain_id == drain_id)
        events = query.order_by(SystemEvent.occurred_at.desc()).offset(offset).limit(limit).all()
        return [SystemEventOut.model_validate(event) for event in events]
    finally:
        db.close()


@app.post("/api/priority/refresh", response_model=list[DrainOut])
async def refresh_priority():
    db = SessionLocal()
    try:
        # 날씨 모드를 먼저 갱신해야 아래 drain별 재계산이 최신 모드의 가중치를 쓴다
        # (반대 순서로 하면 이번 refresh가 한 박자 묵은 모드로 계산되는 버그가 생김).
        await refresh_weather_alert()

        drains = db.query(Drain).all()

        for drain in drains:
            recalc_priority_for_drain(db, drain)

        db.commit()
        for drain in drains:
            db.refresh(drain)

        results = [drain_out(d) for d in drains]
        await manager.broadcast([r.model_dump(mode="json") for r in results])

        return results
    finally:
        db.close()


@app.on_event("startup")
async def startup_recalc_priority():
    """새 DB가 막 시드된 콜드 스타트(또는 재시작 직후)에는 priority_score가 컬럼
    기본값 0으로 남아있어 대시보드가 전부 0점으로 보인다 — 시드 raw SQL은 좌표/판정만
    채우고 점수는 계산하지 않기 때문. 사람이 "우선순위 재계산"을 눌러야만 채워지던 것을,
    서버가 뜰 때 한 번 항상 재계산해 없앤다. 로직은 POST /api/priority/refresh와 동일."""
    await refresh_priority()


@app.get("/api/weather/alert", response_model=WeatherAlertOut)
def get_weather_alert():
    return weather_alert_state


@app.post("/api/weather/mode", response_model=WeatherAlertOut)
async def set_weather_mode(payload: WeatherModeRequest):
    """데모용 수동 모드 전환(v2.9). 실제 강수 데이터가 그날 우연히 세 모드를 다 보여주지
    않아도, 발표 중 버튼 하나로 NORMAL/RAIN/HEAVY_RAIN을 즉시 바꿔 게이트·가중치·배너가
    실제로 달라지는 걸 보여줄 수 있다. mode="AUTO"는 수동 고정을 풀고 실제 기상청 예보로
    즉시 재동기화한다. 모드가 바뀌면 가중치 프로필도 바뀌므로 전체 drain의 우선순위 점수를
    /api/priority/refresh와 동일하게 그 자리에서 재계산해 브로드캐스트한다."""
    db = SessionLocal()
    try:
        if payload.mode == "AUTO":
            weather_alert_state["manual_override"] = False
            weather = forecast.fetch_tomorrow_weather()
            _apply_weather_mode(
                weather["mode"], pop=weather["pop"], pcp_mm=weather["pcp_mm"], pcp_3h_mm=weather["pcp_3h_mm"]
            )
        else:
            weather_alert_state["manual_override"] = True
            _apply_weather_mode(payload.mode, manual=True)

        drains = db.query(Drain).all()
        for drain in drains:
            recalc_priority_for_drain(db, drain)
        db.commit()
        for drain in drains:
            db.refresh(drain)

        results = [drain_out(d) for d in drains]
        await manager.broadcast([r.model_dump(mode="json") for r in results])
        await manager.broadcast({"type": "weather_alert", **weather_alert_state})

        return weather_alert_state
    finally:
        db.close()


@app.post("/api/telemetry")
async def telemetry(payload: TelemetryIn):
    db = SessionLocal()
    try:
        drains = db.query(Drain).all()
        nearby_ids = []
        for d in drains:
            if d.lat is None or d.lng is None:
                continue
            if haversine_m(payload.lat, payload.lng, d.lat, d.lng) <= CLOSE_PASS_RADIUS_M:
                nearby_ids.append(d.id)
                schedule_silence_check(d.id, payload.vehicle_code)
        return {"ok": True, "nearby_drains": nearby_ids}
    finally:
        db.close()


def schedule_silence_check(drain_id: int, vehicle_code: str) -> None:
    existing = pending_checks.get(drain_id)
    if existing and not existing.done():
        existing.cancel()  # 새 근접 신호가 왔으니 이전 타이머는 취소하고 새로 시작 (연속으로 가까이 있는 동안은 확정 안 됨)
    pending_checks[drain_id] = asyncio.create_task(silence_check(drain_id, vehicle_code))


async def silence_check(drain_id: int, vehicle_code: str) -> None:
    check_started_at = datetime.utcnow()
    try:
        await asyncio.sleep(SILENCE_GRACE_SECONDS)
    except asyncio.CancelledError:
        return
    db = SessionLocal()
    try:
        real_detection = (
            db.query(Detection)
            .filter(Detection.drain_id == drain_id, Detection.captured_at >= check_started_at)
            .first()
        )
        if real_detection is not None:
            return  # 대기 중 판정이 도착했으므로 시스템 이벤트를 만들지 않는다.
        drain = db.query(Drain).filter(Drain.id == drain_id).first()
        if drain is None:
            return
        vehicle = db.query(Vehicle).filter(Vehicle.vehicle_code == vehicle_code).first()
        now = datetime.utcnow()
        # 엣지는 정상 방문이면 항상 추론 결과를 보내므로, 결과 미수신은 빗물받이의 물리 상태가
        # 아니라 장치·통신·프로세스 문제다. 판정 이력과 스냅샷은 건드리지 않고 운영 이벤트로 분리한다.
        event = SystemEvent(
            drain_id=drain.id, vehicle_id=vehicle.id if vehicle else None,
            event_type="RESULT_MISSING",
            detail="근접 텔레메트리 이후 판정 결과가 유예시간 내 도착하지 않음",
            source="backend", occurred_at=now,
        )
        db.add(event)
        db.commit()
    finally:
        db.close()
        pending_checks.pop(drain_id, None)


@app.post("/api/route/plan")
def plan_route(payload: RoutePlanRequest):
    db = SessionLocal()
    try:
        drains = db.query(Drain).all()
        occlusion_threshold = weather_alert_state["occlusion_threshold"]
        staleness_days = weather_alert_state["staleness_threshold_days"]

        if payload.min_priority_score is not None:
            # 가중 우선순위 점수(0~1) 기준 — 차폐율 원값과는 단위가 다르므로 별도 파라미터로 분리(v2.6).
            candidates = [d for d in drains if (d.priority_score or 0) >= payload.min_priority_score]
        elif payload.min_occlusion_pct is not None:
            candidates = [d for d in drains if (d.last_occlusion_pct or 0) >= payload.min_occlusion_pct]
        else:
            # 기본 선택 기준: 한 번도 점검 안 됐거나(last_status is None), 현재 날씨 모드의 점검
            # 임계값(2.2-2절) 이상 차폐됐거나, 마지막 확인(AI 또는 사람) 후 날씨 모드별 기준
            # 일수 이상 지난 곳. 단, 사람이 조치/점검 완료로 표시했고 그 뒤로 AI가 새로 나쁜
            # 값을 보고한 적이 없으면(is_resolved) — 차폐율/미점검 조건은 잠시 꺼두고 미점검
            # 경과일 조건만 살려둔다. "조치 완료했고 이후엔 차량 순찰로 재확인 예정"이라는
            # 문구 그대로, 사람이 처리한 직후엔 목록에서 빠졌다가 시간이 충분히 지나면
            # 차량 재확인 대상으로 다시 자연스럽게 떠오른다(C9).
            candidates = [d for d in drains if needs_action(d)]

        candidate_dicts = [
            {"id": d.id, "name": d.name, "lat": d.lat, "lng": d.lng, "priority_score": d.priority_score}
            for d in candidates if d.lat is not None and d.lng is not None
        ]
        start = (payload.start_lat, payload.start_lng) if payload.start_lat is not None and payload.start_lng is not None else None
        teams, distance_source = routing.plan_routes(candidate_dicts, max(1, payload.team_count), start)
        distance_note = (
            "각 구간 거리는 OSRM 실도로망 기준입니다."
            if distance_source == "osrm"
            else "OSRM 공개 서버 응답이 없어 직선거리(haversine)로 대체했습니다 — 실제 도로 거리보다 짧게 나올 수 있습니다."
        )
        return {
            "teams": teams,
            "weather_mode": weather_alert_state["mode"],
            "occlusion_threshold": occlusion_threshold,
            "staleness_threshold_days": staleness_days,
            "candidate_count": len(candidate_dicts),
            "distance_source": distance_source,
            "algorithm_note": (
                "점검 대상 빗물받이를 좌표 기준으로 K개 팀에 클러스터링한 뒤, "
                "각 팀 안에서는 어떤 지점을 먼저 갈지를 우선순위가 아닌 순수 이동거리 기준으로만 "
                "정합니다(최근접 이웃 + 2-opt·or-opt 개선). 어떤 지점이 점검 대상인지·얼마나 "
                "시급한지는 이미 게이트와 우선순위 점수가 결정했고, 같은 팀은 배정된 지점을 "
                "어차피 전부 방문해야 하므로 방문 순서는 총 이동거리를 최소화하는 근사해입니다. "
                "외판원 문제(TSP)는 NP-hard라 완전탐색 대신 근사 알고리즘을 사용했습니다. "
                f"{distance_note} "
                f"총 소요시간은 구간별 이동시간에 지점당 점검 시간 {routing.INSPECTION_SECONDS_PER_STOP // 60}분을 "
                "더한 값이며, 실측이 아닌 데모 단계의 가정치입니다."
            ),
        }
    finally:
        db.close()


@app.get("/api/elevation")
def get_elevation(lat: float, lng: float):
    value = elevation.fetch_elevation(lat, lng)
    if value is None:
        raise HTTPException(status_code=502, detail="고도 조회 실패 (Open-Elevation API 응답 없음)")
    return {"lat": lat, "lng": lng, "elevation": value}


@app.get("/api/flood-zone")
def get_flood_zone(lat: float, lng: float):
    value = flood.fetch_is_flood_zone(lat, lng)
    if value is None:
        raise HTTPException(
            status_code=502,
            detail="침수흔적 조회 실패 또는 판정 불가 (SAFEMAP_API_KEY 미설정/API 응답 없음/응답 구조 파싱 실패)",
        )
    return {"lat": lat, "lng": lng, "is_flood_zone": value}


@app.get("/api/flood-zone/raw")
def get_flood_zone_raw(lat: float, lng: float, radius_m: float = flood.DEFAULT_RADIUS_M):
    """생활안전지도 침수흔적도 WMS 원본 PNG 확인용 디버그 엔드포인트.

    이 데이터셋은 REST(JSON)가 아니라 WMS(지도 이미지)로만 제공되는 것으로 확인되어
    (flood.py 모듈 docstring 참고) get_flood_zone()이 실제로 어떤 이미지를 보고 판정하는지
    이걸로 직접 눈으로 확인할 수 있다."""
    png_bytes = flood.fetch_flood_zone_image(lat, lng, radius_m=radius_m)
    if png_bytes is None:
        raise HTTPException(status_code=502, detail="침수흔적도 WMS 응답 없음 (SAFEMAP_API_KEY 확인)")
    return Response(content=png_bytes, media_type="image/png")
    return payload


@app.post("/api/vehicles", response_model=VehicleOut)
def create_vehicle(payload: VehicleCreate):
    db = SessionLocal()
    try:
        vehicle = Vehicle(
            vehicle_code=payload.vehicle_code,
            vehicle_type=payload.vehicle_type,
            route_id=payload.route_id,
        )
        db.add(vehicle)
        db.commit()
        db.refresh(vehicle)
        return VehicleOut.model_validate(vehicle)
    finally:
        db.close()


@app.get("/api/vehicles", response_model=list[VehicleOut])
def list_vehicles():
    db = SessionLocal()
    try:
        return [VehicleOut.model_validate(v) for v in db.query(Vehicle).all()]
    finally:
        db.close()


@app.get("/api/vehicles/{vehicle_id}/drains")
def vehicle_drains(vehicle_id: int):
    db = SessionLocal()
    try:
        vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
        if vehicle is None:
            raise HTTPException(status_code=404, detail=f"vehicle_id {vehicle_id} not found")

        detections = (
            db.query(Detection)
            .filter(Detection.vehicle_id == vehicle_id)
            .order_by(Detection.captured_at.desc())
            .all()
        )
        # 이 차량이 이 drain을 처음(=가장 최근) 본 detection만 대표값으로 남긴다
        # (내림차순 정렬 상태라 drain_id별로 먼저 만나는 게 최신 것)
        latest_by_drain: dict[int, Detection] = {}
        counts: dict[int, int] = {}
        for d in detections:
            counts[d.drain_id] = counts.get(d.drain_id, 0) + 1
            if d.drain_id not in latest_by_drain:
                latest_by_drain[d.drain_id] = d

        drain_ids = list(latest_by_drain.keys())
        drains_by_id = {d.id: d for d in db.query(Drain).filter(Drain.id.in_(drain_ids)).all()} if drain_ids else {}

        results = []
        for drain_id, last in latest_by_drain.items():
            drain = drains_by_id.get(drain_id)
            results.append({
                "drain_id": drain_id,
                "name": drain.name if drain else None,
                "external_code": drain.external_code if drain else None,
                "lat": drain.lat if drain else None,
                "lng": drain.lng if drain else None,
                "priority_score": drain.priority_score if drain else None,
                "last_status_by_vehicle": last.status,
                "reason_code_by_vehicle": last.reason_code,
                "last_occlusion_pct_by_vehicle": last.occlusion_pct,
                "last_seen_by_vehicle": last.captured_at,
                "detection_count": counts[drain_id],
            })
        results.sort(key=lambda r: r["last_seen_by_vehicle"], reverse=True)
        return results
    finally:
        db.close()


@app.websocket("/ws/dashboard")
async def ws_dashboard(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
