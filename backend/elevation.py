"""위경도 -> 실제 지대 고도(m) 조회.

기획안 2.2절은 국토지리정보원 DEM을 고도 출처로 명시하지만, 그 서비스의 포인트 조회
API 스펙을 신뢰할 수 있게 확인하지 못해(VWorld 표고 API 문서가 공개 검색으로 명확히
잡히지 않음) 대신 별도 인증키 없이 쓸 수 있는 공개 SRTM 기반 Open-Elevation을 사용한다
(기획안의 "공개 자료 기반" 원칙과 부합). 국토지리정보원 정식 API 키를 나중에 확보하면
이 모듈만 교체하면 됨 — 호출부(main.py)는 fetch_elevation(lat, lng) 시그니처만 안다.
"""
import requests

OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"


def fetch_elevation(lat: float, lng: float) -> float | None:
    """실패 시 None. 강수확률(forecast.py)과 달리 이 조회는 데모 루프가 매번 의존하는
    값이 아니라 drains_seed.json을 채울 때 한 번 쓰는 용도라, 억지 더미값 대신 실패를
    명확히 드러내는 쪽을 택함."""
    try:
        resp = requests.get(OPEN_ELEVATION_URL, params={"locations": f"{lat},{lng}"}, timeout=8)
        resp.raise_for_status()
        results = resp.json().get("results", [])
        return results[0]["elevation"] if results else None
    except Exception:
        return None


def fetch_elevations(points: list[tuple[float, float]]) -> list[float | None]:
    """여러 좌표를 한 번의 요청으로 배치 조회 (drains_seed.json 전체를 채울 때 유용)."""
    if not points:
        return []
    try:
        locations = "|".join(f"{lat},{lng}" for lat, lng in points)
        resp = requests.get(OPEN_ELEVATION_URL, params={"locations": locations}, timeout=15)
        resp.raise_for_status()
        results = resp.json().get("results", [])
        return [r.get("elevation") for r in results]
    except Exception:
        return [None] * len(points)
