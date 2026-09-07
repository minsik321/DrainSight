"""detections 로그를 기간별로 집계해 분석 페이지의 "기간별 상태 변화" 추이를 만든다.

detections는 append-only 판정 로그라 원본은 항상 남아있지만, 지금까지 일자별 집계
엔드포인트가 없어 프런트가 analyticsTrendFixture.js의 예시 데이터를 대신 썼다. 이 모듈이
그 자리를 실측 집계로 대체한다 — KMA/SafeMap처럼 외부 공공데이터를 새로 끌어오는 게 아니라,
이미 우리 DB에 쌓여 있던 진짜 값을 처음으로 롤업해서 보여주는 것뿐이라는 점이 다르다.

기간 전체에 실측 표본이 하나도 없으면(데모 당일 아직 차량이 안 지나간 '오늘' 탭 등) 0으로
눕는 평평한 그래프 대신 결정론적 시연용 대체값으로 바꿔치기한다(`_dummy_trend_points`) —
forecast.py/rainfall.py와 같은 "이력·API 준비 전" 폴백 원칙이며, `has_data`/`source` 필드로
실측이 아님을 프런트에 그대로 알린다.
"""
import random
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from models import Detection, Drain

STATUS_KEYS = ("CLEAR", "OCCLUDED", "BLOCKED", "UNASSESSABLE")

# prevOcc(이전 기간 비교선)를 구할 때 현재 구간에서 이만큼을 빼서 "같은 길이의 직전 기간"을 본다.
PERIOD_LENGTHS = {
    "today": timedelta(days=1),
    "7d": timedelta(days=7),
    "30d": timedelta(days=28),
}


def bucket_ranges(period: str, now: datetime) -> list[tuple[datetime, datetime, str]]:
    """기간별 구간 경계 + 표시용 라벨. now 기준 자정/시각으로 끊어서 매번 새로고침해도
    같은 구간 정의가 재현되게 한다(미래 구간이 섞여도 그 구간엔 판정이 없을 뿐 0으로
    정직하게 나온다)."""
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return [
            (start + timedelta(hours=4 * i), start + timedelta(hours=4 * (i + 1)), f"{4 * i:02d}시")
            for i in range(6)
        ]
    if period == "7d":
        start = (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        return [
            (start + timedelta(days=i), start + timedelta(days=i + 1), (start + timedelta(days=i)).strftime("%m/%d"))
            for i in range(7)
        ]
    if period == "30d":
        start = (now - timedelta(days=27)).replace(hour=0, minute=0, second=0, microsecond=0)
        labels = ["4주 전", "3주 전", "2주 전", "1주 전"]
        return [(start + timedelta(days=7 * i), start + timedelta(days=7 * (i + 1)), labels[i]) for i in range(4)]
    raise ValueError(f"unknown period: {period}")


def _bucket_status_stats(db: Session, start: datetime, end: datetime) -> tuple[dict, float | None]:
    rows = (
        db.query(Detection.status, Detection.occlusion_pct)
        .filter(Detection.captured_at >= start, Detection.captured_at < end)
        .all()
    )
    counts = {k: 0 for k in STATUS_KEYS}
    occ_values = []
    for status, occlusion_pct in rows:
        if status in counts:
            counts[status] += 1
        if occlusion_pct is not None:
            occ_values.append(occlusion_pct)
    occ_avg = sum(occ_values) / len(occ_values) if occ_values else None
    return counts, occ_avg


def _inspected_count(db: Session, end: datetime) -> int:
    """end 시점까지 한 번이라도 판정된 적 있는 고유 drain 수 — 기획 의도상 "누적 점검
    커버리지"라 구간이 지날수록 total_drains에 수렴해야 한다."""
    return db.query(Detection.drain_id).filter(Detection.captured_at < end).distinct().count()


def _dummy_status_counts(total_drains: int, rng: random.Random) -> dict:
    """전체 등록 대수 대비 그럴듯한 상태 분포. 비율을 시드 기반으로 살짝 흔들어 매 구간이
    똑같은 막대로 안 보이게 한다."""
    if total_drains <= 0:
        return {k: 0 for k in STATUS_KEYS}
    base = {"CLEAR": 0.55, "OCCLUDED": 0.25, "BLOCKED": 0.08, "UNASSESSABLE": 0.12}
    counts = {}
    remaining = total_drains
    for i, k in enumerate(STATUS_KEYS):
        if i == len(STATUS_KEYS) - 1:
            counts[k] = remaining
        else:
            n = max(0, min(remaining, round(total_drains * max(0.0, base[k] + rng.uniform(-0.05, 0.05)))))
            counts[k] = n
            remaining -= n
    return counts


def _dummy_trend_points(buckets: list[tuple[datetime, datetime, str]], total_drains: int, anchor_occ: float) -> list[dict]:
    """실측 이력이 하나도 없는 기간(주로 데모 당일 차량이 아직 지나가기 전)을 위한
    결정론적 시연용 대체값 — forecast.py/rainfall.py와 같은 "이력·API 준비 전" 폴백
    원칙이다. 값을 아무렇게나 흔드는 대신: (1) 날짜를 시드로 재현 가능하게 만들고,
    (2) 마지막 지점은 현재 실제 스냅샷의 평균 차폐율(anchor_occ)에 수렴시켜 "지금 이
    순간"과 그래프 끝이 어긋나지 않게 한다. 호출부가 이 결과를 has_data=False,
    source="dummy"와 함께 내려주므로 프런트가 실측이 아님을 계속 표시할 수 있다."""
    n = len(buckets)
    rng = random.Random(buckets[0][0].strftime("%Y%m%d") + "-trend-demo")
    start_occ = max(0.0, min(100.0, anchor_occ - rng.uniform(6, 14)))
    inspected_target = max(1, round(total_drains * rng.uniform(0.6, 0.85))) if total_drains else 0

    points = []
    for i, (_start, _end, label) in enumerate(buckets):
        t = i / max(1, n - 1)
        occ = max(0.0, min(100.0, start_occ + (anchor_occ - start_occ) * t + rng.uniform(-2.5, 2.5)))
        counts = _dummy_status_counts(total_drains, rng)
        inspected = round(inspected_target * (0.3 + 0.7 * t))
        coverage = min(100.0, (inspected / total_drains * 100) if total_drains else 0.0)
        points.append({
            "date": label,
            "occ": round(occ, 1),
            "prevOcc": round(max(0.0, occ - rng.uniform(3, 10)), 1),
            "clear": counts["CLEAR"],
            "occluded": counts["OCCLUDED"],
            "blocked": counts["BLOCKED"],
            "unassessable": counts["UNASSESSABLE"],
            "inspected": inspected,
            "coverage": round(coverage, 1),
        })
    return points


def compute_status_trend(db: Session, period: str, now: datetime) -> dict:
    """실제 detections 이력을 기간별로 집계한다. 표본이 없는 구간(occ_avg가 None)은 직전
    구간 값을 이어 그려 그래프가 이유 없이 0으로 뚝 떨어지지 않게 한다.

    기간 전체에 표본이 하나도 없으면(any_real_occ=False, 데모 당일 아직 차량이 안 지나간
    '오늘' 탭에서 특히 흔함) 0으로 눕는 대신 `_dummy_trend_points`의 시연용 대체값으로
    바꿔치기한다 — 값을 지어내는 게 아니라 안내를 숨기는 것 아니냐고 볼 수도 있지만,
    `has_data`와 `source` 필드로 프런트에 그대로 넘겨 화면에서 "실측 아님"을 계속
    밝히므로 조용히 속이는 것과는 다르다(elevation.py/flood.py가 모르면 None을 반환하는
    것과 같은 정직성 원칙 — 다만 여기선 시연 편의상 완전한 공백 대신 대체값을 보여준다)."""
    buckets = bucket_ranges(period, now)
    period_len = PERIOD_LENGTHS[period]
    total_drains = db.query(Drain).count()

    points = []
    last_occ = None
    any_real_occ = False
    for start, end, label in buckets:
        counts, occ_avg = _bucket_status_stats(db, start, end)
        if occ_avg is not None:
            any_real_occ = True
            last_occ = occ_avg
        _, prev_occ_avg = _bucket_status_stats(db, start - period_len, end - period_len)
        inspected = _inspected_count(db, end)
        coverage = min(100.0, (inspected / total_drains * 100) if total_drains else 0.0)
        points.append({
            "date": label,
            "occ": round(occ_avg if occ_avg is not None else (last_occ or 0.0), 1),
            "prevOcc": round(prev_occ_avg, 1) if prev_occ_avg is not None else None,
            "clear": counts["CLEAR"],
            "occluded": counts["OCCLUDED"],
            "blocked": counts["BLOCKED"],
            "unassessable": counts["UNASSESSABLE"],
            "inspected": inspected,
            "coverage": round(coverage, 1),
        })

    if any_real_occ:
        return {"period": period, "points": points, "has_data": True, "source": "real"}

    occlusion_values = [v for (v,) in db.query(Drain.last_occlusion_pct).all() if v is not None]
    anchor_occ = sum(occlusion_values) / len(occlusion_values) if occlusion_values else 25.0
    dummy_points = _dummy_trend_points(buckets, total_drains, anchor_occ)
    return {"period": period, "points": dummy_points, "has_data": False, "source": "dummy"}
