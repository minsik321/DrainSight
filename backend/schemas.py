import json
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

Status = Literal["CLEAR", "BLOCKED", "OCCLUDED", "UNASSESSABLE"]
Source = Literal["pi", "simulator"]


class DetectionCreate(BaseModel):
    drain_id: int
    vehicle_code: str
    status: Status
    # UNASSESSABLE은 추론은 실행됐지만 대상을 인식하지 못해 차폐율 판정이 불가능한 상태다.
    occlusion_pct: Optional[float] = None
    reason_code: Optional[Literal["DRAIN_NOT_DETECTED"]] = None
    confidence: Optional[float] = None
    lat: float
    lng: float
    source: Source

    @model_validator(mode="after")
    def _validate_assessment(self):
        if self.status == "UNASSESSABLE":
            self.occlusion_pct = None
            self.reason_code = self.reason_code or "DRAIN_NOT_DETECTED"
        elif self.reason_code is not None:
            raise ValueError("reason_code는 UNASSESSABLE 상태에서만 사용할 수 있습니다")
        return self


class DrainOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_code: Optional[str] = None
    name: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    route_ids: list[int] = []
    elevation: Optional[float] = None
    is_flood_zone: Optional[bool] = None
    priority_score: Optional[float] = None
    priority_reasons: list[str] = []
    elevation_risk: Optional[float] = None
    flood_history_flag: Optional[float] = None
    staleness_risk: Optional[float] = None
    occlusion_norm: Optional[float] = None
    last_status: Optional[str] = None
    last_occlusion_pct: Optional[float] = None
    last_updated: Optional[datetime] = None
    maintenance_note: Optional[str] = None
    maintenance_resolved_at: Optional[datetime] = None
    requires_action: bool = False

    @field_validator("priority_reasons", mode="before")
    @classmethod
    def _parse_priority_reasons(cls, v):
        return json.loads(v) if isinstance(v, str) else (v or [])


class DetectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    drain_id: Optional[int] = None
    vehicle_id: Optional[int] = None
    vehicle_code: Optional[str] = None
    vehicle_type: Optional[str] = None
    status: str
    reason_code: Optional[str] = None
    occlusion_pct: Optional[float] = None
    confidence: Optional[float] = None
    source: Optional[str] = None
    captured_at: datetime


class SystemEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    drain_id: Optional[int] = None
    vehicle_id: Optional[int] = None
    event_type: str
    detail: Optional[str] = None
    source: Optional[str] = None
    occurred_at: datetime


class TelemetryIn(BaseModel):
    vehicle_code: str
    lat: float
    lng: float


class RoutePlanRequest(BaseModel):
    team_count: int
    start_lat: Optional[float] = None
    start_lng: Optional[float] = None
    # 단위가 다른 두 게이트를 명확히 분리(v2.6) — 차폐율 원값(%) vs 가중 우선순위 점수(0~1).
    # 둘 다 안 주면 현재 날씨 모드의 기본 게이트(임계값+미점검 일수)를 쓴다.
    min_occlusion_pct: Optional[float] = None
    min_priority_score: Optional[float] = None


class ResolveRequest(BaseModel):
    note: Optional[str] = None  # 생략하면 서버가 상황(BLOCKED/OCCLUDED vs 미점검/판정불가)에 맞춰 기본 문구를 채움


class WeatherModeRequest(BaseModel):
    # "AUTO"는 수동 고정을 풀고 실제 기상청 예보로 즉시 재동기화 — 데모용 강제 전환 버튼 전용(v2.9)
    mode: Literal["NORMAL", "RAIN", "HEAVY_RAIN", "AUTO"]


class VehicleCreate(BaseModel):
    vehicle_code: str
    vehicle_type: Optional[str] = None
    route_id: Optional[int] = None


class VehicleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    vehicle_code: str
    vehicle_type: Optional[str] = None
    route_id: Optional[int] = None


class WeatherAlertOut(BaseModel):
    active: bool
    message: Optional[str] = None
    rain_prob: Optional[float] = None
    pcp_mm: Optional[float] = None
    pcp_3h_mm: Optional[float] = None
    mode: str = "NORMAL"
    occlusion_threshold: float = 70.0
    staleness_threshold_days: float = 14.0
    weight_profile: dict = {}
    issued_at: Optional[str] = None
    manual_override: bool = False  # True면 데모용으로 강제 고정된 모드 — 실제 예보 갱신이 덮어쓰지 않음
