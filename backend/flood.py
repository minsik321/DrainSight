"""위경도 -> 행안부 생활안전지도 침수흔적도 조회.

기획안 2.2절의 침수 이력(환경부 지정 침수 중점관리구역) 값은 db/drains_seed.json에
수동으로 채워 넣는 정적 필드라 런타임 의존이 아니다 — 이 모듈도 elevation.py와 같은 성격의
"1회성 수동 조회, 실패 시 억지 더미값 없이 None" 도구다.

행안부 생활안전지도(safemap.go.kr) 오픈API "침수흔적도"(IF_0092)를 실제 키로 테스트해본 결과:
REST 엔드포인트(IF_0092, JSON/XML)는 승인된 키로도 계속 resultCode 12
(NO_OPENAPI_SERVICE_ERROR)를 반환했고, WMS 엔드포인트(IF_0092_WMS)는 정상적으로 PNG를
반환했다 — 이 데이터셋은 REST(속성 리스트)가 아니라 WMS(지도 이미지) 레이어로만 제공되는
것으로 보인다(레이어명 A2SM_FLUDMARKS). GetCapabilities/GetFeatureInfo 같은 표준 OGC WMS
질의도 400을 반환해 지원하지 않는 것으로 보여, "속성값을 직접 조회"하는 방법이 없다.

그래서 여기서는 좌표 주변을 작은 bbox로 잘라 GetMap 이미지를 받아 온 뒤, 해당 좌표가 속한
픽셀(들)이 투명이 아니면(=침수흔적 폴리곤이 칠해져 있으면) 침수 이력이 있는 것으로 판정하는
방식을 쓴다. 실제로 천안시 전역 bbox로 받아보면 파란 계열 픽셀이 존재함을 확인했다(레이어에
실측 데이터가 있음). 그림 판독 방식이라 폴리곤 경계 부근에서 오차가 있을 수 있음 — 정확한
속성 조회 API가 나중에 확인되면 이 모듈만 교체하면 된다.
추가 확인(2026-09): 정상 발급된(계정 조회로 확인됨) SAFEMAP_API_KEY로 다시 테스트해도 WMS
  엔드포인트가 resultCode 30 "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"를 반환한다 — 키 문제가
  아니라, SafeMap 오픈API 데이터 페이지(safemap.go.kr/opna/data/dataView.do?objtId=212)
  자체에 "현재 데이터는 준비 중으로, 추후 제공될 예정임을 안내드립니다"라고 명시돼 있어 이
  데이터셋이 플랫폼에서 통째로 내려간 상태로 보인다 — 위 단락에서 성공했다고 적은 시점 이후
  SafeMap이 서비스를 개편/중단한 것으로 추정. 코드는 정상 동작(실패 시 None 반환)이므로 손iciel
  게 없고, 서비스가 재개되는만 가끔 재확인하면 된다.
"""
import io
import math
import os

import requests

SAFEMAP_WMS_URL = "http://safemap.go.kr/openapi2/IF_0092_WMS"

# 좌표 주변 이 반경(m)을 이미지로 받아서 판정한다. 너무 좁으면 폴리곤 경계 오차에 취약하고,
# 너무 넓으면 "근처에 흔적이 있다"가 "여기가 흔적이다"로 과대판정될 수 있음.
DEFAULT_RADIUS_M = 60
DEFAULT_IMAGE_PX = 240  # RADIUS_M*2 범위를 이 픽셀 수로 렌더링 (해상도가 높을수록 판정이 촘촘함)
CENTER_SAMPLE_PX = 6  # 이미지 중심 부근 이 크기(px) 정사각형 안에 비투명 픽셀이 하나라도 있으면 True


def _bbox_around(lat: float, lng: float, radius_m: float) -> str:
    lat_delta = radius_m / 111320.0
    lng_delta = radius_m / (111320.0 * math.cos(math.radians(lat)))
    return f"{lng - lng_delta},{lat - lat_delta},{lng + lng_delta},{lat + lat_delta}"


def fetch_flood_zone_image(
    lat: float, lng: float, radius_m: float = DEFAULT_RADIUS_M, image_px: int = DEFAULT_IMAGE_PX
) -> bytes | None:
    """디버그/검증용: 좌표 주변 침수흔적도 WMS PNG 원본 바이트. 키 미설정/실패 시 None."""
    api_key = os.environ.get("SAFEMAP_API_KEY")
    if not api_key:
        return None
    try:
        resp = requests.get(
            SAFEMAP_WMS_URL,
            params={
                "serviceKey": api_key,
                "srs": "EPSG:4326",
                "bbox": _bbox_around(lat, lng, radius_m),
                "format": "image/png",
                "width": image_px,
                "height": image_px,
                "transparent": "TRUE",
            },
            timeout=10,
        )
        resp.raise_for_status()
        if "image" not in resp.headers.get("content-type", ""):
            return None  # 에러 응답(JSON/HTML)이 image/png 대신 온 경우
        return resp.content
    except Exception:
        return None


def fetch_is_flood_zone(
    lat: float,
    lng: float,
    radius_m: float = DEFAULT_RADIUS_M,
    image_px: int = DEFAULT_IMAGE_PX,
    center_sample_px: int = CENTER_SAMPLE_PX,
) -> bool | None:
    """좌표가 침수흔적도 폴리곤 안에 있는지 여부. 조회/판독 실패 시 None(모름) —
    False로 단정하지 않는다(elevation.py와 동일한 원칙)."""
    png_bytes = fetch_flood_zone_image(lat, lng, radius_m=radius_m, image_px=image_px)
    if png_bytes is None:
        return None
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    except Exception:
        return None

    cx, cy = img.width // 2, img.height // 2
    half = max(1, center_sample_px // 2)
    px = img.load()
    for y in range(max(0, cy - half), min(img.height, cy + half)):
        for x in range(max(0, cx - half), min(img.width, cx + half)):
            if px[x, y][3] > 0:
                return True
    return False
