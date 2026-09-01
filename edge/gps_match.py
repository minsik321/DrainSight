"""GPS 좌표 획득 + 노선 기반 최근접 drain 매칭 (기획안 2.1절).

전역 최근접 매칭 대신, 차량의 담당 노선(route_id)에 등록된 drain 후보군으로
검색 범위를 먼저 좁힌 뒤 haversine 최근접 매칭을 수행해 오매칭 확률을 낮춘다.
"""
import math

import requests


def fetch_drains(backend_url):
    resp = requests.get(f"{backend_url.rstrip('/')}/api/drains", timeout=5)
    resp.raise_for_status()
    return resp.json()


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# 저가 GPS 모듈(NEO-6M류)의 실측 오차는 수 미터 수준이지만, 도심에서는 건물 반사로
# 10m 안팎까지 벌어지기도 한다(기획안 2.1절). 30m는 그 오차 + 도로 폭 여유를 감안한
# 매칭 허용 반경 — 이보다 먼 지점은 "이 근처엔 등록된 drain이 없다"로 보고 매칭을
# 포기한다(엉뚱하게 먼 drain에 억지로 갖다붙이는 것을 막기 위함). --match-radius-m으로 조정 가능.
DEFAULT_MAX_MATCH_DISTANCE_M = 30.0


class DrainMatcher:
    def __init__(self, drains, vehicle_route_id, max_distance_m=DEFAULT_MAX_MATCH_DISTANCE_M):
        # 빗물받이 하나가 여러 노선에 걸칠 수 있어(예: 쓰레기차 노선과 버스 노선이 같은
        # 구간을 지나는 경우) route_id 단일값이 아니라 route_ids 배열로 소속 여부를 확인.
        candidates = [d for d in drains if vehicle_route_id in (d.get("route_ids") or [])]
        # 노선이 아직 등록되지 않은 신규 차량·구간: 전역 매칭으로 fallback (기획안 2.1절)
        self.candidates = candidates if candidates else list(drains)
        self.max_distance_m = max_distance_m
        if not self.candidates:
            raise ValueError("매칭 가능한 drain이 없습니다 (GET /api/drains 응답이 비어 있음)")

    def match(self, lat, lng):
        """반경 내 최근접 drain을 반환. 후보군 전체가 허용 반경 밖이면 None(매칭 실패)."""
        best = min(self.candidates, key=lambda d: haversine_m(lat, lng, d["lat"], d["lng"]))
        if haversine_m(lat, lng, best["lat"], best["lng"]) > self.max_distance_m:
            return None
        return best


class SimulateGPS:
    """고정 지그 데모: 주어진 waypoint 목록을 순서대로 순회 (기획안 3.1/7장).

    waypoint는 호출부(run.py)가 실제 backend GET /api/drains 응답에서 뽑아 넘긴다 —
    좌표를 여기 하드코딩하면 db/drains_seed.json과 따로 놀 위험이 있어 일부러 비워둠.

    dwell: 각 좌표에 머무는 틱 수. 1이면 매 틱 다음 좌표로 바로 넘어가고(기존 동작),
    n이면 같은 좌표를 n틱 연속으로 반환한 뒤 다음 좌표로 넘어간다 — run.py의 방문 단위
    집계(이상값 제거+평균)를 눈으로 검증하려면 dwell을 1보다 크게 줘야 한다.
    """

    def __init__(self, waypoints, dwell=1):
        if not waypoints:
            raise ValueError("SimulateGPS에 순회할 좌표가 없습니다")
        self.waypoints = waypoints
        self.dwell = max(1, dwell)
        self._i = 0

    def read(self):
        lat, lng = self.waypoints[(self._i // self.dwell) % len(self.waypoints)]
        self._i += 1
        return lat, lng

    def close(self):
        pass


class SerialGPS:
    """NEO-6M 등 실 GPS 모듈에서 NMEA 문장을 읽어 lat/lng 파싱 (Pi 실배치용)."""

    def __init__(self, port, baudrate=9600, timeout=1.0):
        import serial  # pyserial

        self._serial = serial.Serial(port, baudrate=baudrate, timeout=timeout)

    def read(self):
        import pynmea2

        while True:
            raw = self._serial.readline()
            line = raw.decode("ascii", errors="ignore").strip()
            if not line.startswith("$"):
                continue
            try:
                msg = pynmea2.parse(line)
            except pynmea2.ParseError:
                continue
            lat = getattr(msg, "latitude", None)
            lng = getattr(msg, "longitude", None)
            if lat and lng:
                return lat, lng

    def close(self):
        self._serial.close()


def build_gps_source(spec, waypoints=None, dwell=1):
    """spec: 'simulate' | 'serial:<port>'"""
    if spec == "simulate":
        return SimulateGPS(waypoints, dwell=dwell)
    if spec.startswith("serial:"):
        return SerialGPS(spec.split(":", 1)[1])
    raise ValueError(f"알 수 없는 GPS source: {spec}")
