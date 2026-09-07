from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, DateTime, Text
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    vehicle_code = Column(String(50), nullable=False)
    vehicle_type = Column(String(20))
    route_id = Column(Integer)


class DrainRoute(Base):
    __tablename__ = "drain_routes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    drain_id = Column(Integer, ForeignKey("drains.id"))
    route_id = Column(Integer, nullable=False)


class Drain(Base):
    __tablename__ = "drains"

    id = Column(Integer, primary_key=True, autoincrement=True)
    external_code = Column(String(50))
    name = Column(String(100), nullable=False)
    lat = Column(Float)
    lng = Column(Float)
    # 노선은 다대다(drain_routes)로 관리 — 빗물받이 하나가 여러 노선(쓰레기차·버스 등)에
    # 동시에 걸칠 수 있음. eager(joined) 로딩해서 route_ids 프로퍼티가 세션 종료 전에 안전하게 동작.
    routes = relationship("DrainRoute", lazy="joined")
    elevation = Column(Float)
    is_flood_zone = Column(Boolean, default=False)
    priority_score = Column(Float, default=0)
    priority_reasons = Column(Text)
    elevation_risk = Column(Float)
    flood_history_flag = Column(Float)
    staleness_risk = Column(Float)
    occlusion_norm = Column(Float)
last_status = Column(String(20))
    last_occlusion_pct = Column(Float)
    last_source = Column(String(20))  # 최신 판정을 보낸 쪽 — "pi"(실기기) / "simulator"(데모), v2.17
    last_updated = Column(DateTime)
    maintenance_note = Column(Text)
    maintenance_resolved_at = Column(DateTime)

    @property
    def route_ids(self):
        return [r.route_id for r in self.routes]


class Detection(Base):
    __tablename__ = "detections"

    id = Column(Integer, primary_key=True, autoincrement=True)
    drain_id = Column(Integer, ForeignKey("drains.id"))
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"))
    status = Column(String(20), nullable=False)
    reason_code = Column(String(40))
    occlusion_pct = Column(Float)
    confidence = Column(Float)
    source = Column(String(20))
    captured_at = Column(DateTime, nullable=False)


class SystemEvent(Base):
    __tablename__ = "system_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    drain_id = Column(Integer, ForeignKey("drains.id"))
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"))
    event_type = Column(String(40), nullable=False)
    detail = Column(Text)
    source = Column(String(20))
    occurred_at = Column(DateTime, nullable=False)
