import math
import os
import random
import re
from datetime import datetime, timedelta

import requests

KMA_API_KEY = os.environ.get("KMA_API_KEY", "")
KMA_URL = "http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"

# 개별 drain 단위가 아니라 천안시 전역 단위로 판단하는 강수 알림 기준(2.2절 개정 참고)
CHEONAN_CITY_HALL_LAT = 36.8151
CHEONAN_CITY_HALL_LNG = 127.1139

# 날씨 모드 3단계 (2.2-2절, v2.5~v2.6) — "게이트(임계값)"와 "순서(가중치)" 역할을 분리해서
# 여러 메커니즘을 동시에 적용한다: 평소엔 점검 대상 자체를 좁게(차폐율 70%↑ 또는 14일↑ 미점검)
# 잡고 차폐율 위주로 순서를 매기지만, 비/폭우 예보가 뜨면 대상을 넓히는(50%↓/40%↓, 7일↓/1일↓)
# 동시에 저지대·침수이력을 가중치에 다시 태워 리스크 큰 지점이 앞순위로 오게 만든다.
# 미점검 경과일(staleness)은 날씨와 무관하게 항상 챙겨야 하는 신호라 가중치·게이트 양쪽에
# 날씨 모드별로 다르게 반영된다(게이트는 STALENESS_THRESHOLD_DAYS, 순서는 w3).
NORMAL = "NORMAL"
RAIN = "RAIN"
HEAVY_RAIN = "HEAVY_RAIN"

# 강수확률(POP) 판정 기준 — PCP(강수량) 파싱에 실패했을 때의 폴백으로도 쓰인다.
RAIN_POP_THRESHOLD = 40.0
HEAVY_RAIN_POP_THRESHOLD = 70.0
# 3시간 누적 강수량이 이 값(mm) 이상이면 확률과 무관하게 폭우로 판정 — POP만으로는 "올 확률은
# 높은데 이슬비"와 "올 확률은 낮은데 물폭탄"을 구분 못 하기 때문. 기상청 호우주의보의 실제 발표
# 기준(3시간 강우량 60mm 이상 또는 12시간 강우량 110mm 이상)에서 3시간 조건을 그대로 채택했다
# (v2.11) — 호우주의보는 기상청이 "호우"(=폭우) 용어를 쓰기 시작하는 지점이라 이 시스템의
# "폭우 예보" 라벨과 의미가 가장 가깝다. 그보다 훨씬 드문 "극한호우"(2023.6.15 신설, 시간당
# 50mm+3시간 90mm 또는 시간당 72mm 단독) 기준을 잠깐 썼었지만(v2.10), 그건 호우주의보보다 한
# 단계 위의 비상 등급이라 실전에서 거의 발동하지 않는 문제가 있어 되돌렸다. 단기예보 API는 1시간
# 단위 PCP만 주므로, 연속된 시간대 3개를 롤링 합산해(`_max_rolling_3h_pcp`) 실제 3시간 누적치를
# 구성한 뒤 이 값과 비교한다 — 더 이상 1시간 값을 억지로 3시간 기준에 대입하는 근사가 아니다.
HEAVY_RAIN_PCP_3H_MM = 60.0

# (elevation_risk, flood_history_flag, staleness_risk, occlusion_norm) 가중치, v2.6.
# staleness_risk(마지막 점검 후 얼마나 지났는지)는 날씨와 무관하게 항상 챙겨야 하는 신호라
# 세 모드 전부 0.15로 고정. 나머지는 기존 구조(평소=차폐율만, 비/폭우=저지대·침수이력까지) 유지.
WEIGHT_PROFILES = {
    NORMAL: (0.00, 0.00, 0.15, 0.85),
    RAIN: (0.15, 0.25, 0.15, 0.45),
    HEAVY_RAIN: (0.15, 0.25, 0.15, 0.45),
}

# 점검 대상 게이트 — 이 값 이상 차폐된 drain만 "조치 필요" 후보에 오른다(POST /api/route/plan
# 기본 후보 선정 기준). 비/폭우 예보일수록 더 가벼운 막힘도 선제적으로 잡아내도록 낮아진다.
OCCLUSION_ACTION_THRESHOLD = {
    NORMAL: 70.0,
    RAIN: 50.0,
    HEAVY_RAIN: 40.0,
}

# 미점검 게이트 — 마지막 점검 후 이 일수 이상 지나면 (차폐율과 무관하게) 그 자체로 점검 대상에
# 오른다. 폭우 예보 시 "오늘 안 지나간 곳은 전부 시급"이라는 의미로 1일까지 바짝 당긴다.
STALENESS_THRESHOLD_DAYS = {
    NORMAL: 14.0,
    RAIN: 7.0,
    HEAVY_RAIN: 1.0,
}

# KMA 격자 변환 LCC 파라미터 (공식 문서 고정값)
_RE = 6371.00877
_GRID = 5.0
_SLAT1 = 30.0
_SLAT2 = 60.0
_OLON = 126.0
_OLAT = 38.0
_XO = 43
_YO = 136


def latlng_to_grid(lat: float, lng: float) -> tuple[int, int]:
    DEGRAD = math.pi / 180.0
    re = _RE / _GRID
    slat1 = _SLAT1 * DEGRAD
    slat2 = _SLAT2 * DEGRAD
    olon = _OLON * DEGRAD
    olat = _OLAT * DEGRAD

    sn = math.tan(math.pi * 0.25 + slat2 * 0.5) / math.tan(math.pi * 0.25 + slat1 * 0.5)
    sn = math.log(math.cos(slat1) / math.cos(slat2)) / math.log(sn)
    sf = math.tan(math.pi * 0.25 + slat1 * 0.5)
    sf = math.pow(sf, sn) * math.cos(slat1) / sn
    ro = math.tan(math.pi * 0.25 + olat * 0.5)
    ro = re * sf / math.pow(ro, sn)

    ra = math.tan(math.pi * 0.25 + lat * DEGRAD * 0.5)
    ra = re * sf / math.pow(ra, sn)
    theta = lng * DEGRAD - olon
    if theta > math.pi:
        theta -= 2.0 * math.pi
    if theta < -math.pi:
        theta += 2.0 * math.pi
    theta *= sn

    nx = int(ra * math.sin(theta) + _XO + 1.5)
    ny = int(ro - ra * math.cos(theta) + _YO + 1.5)
    return nx, ny


def _latest_base_datetime(now: datetime) -> tuple[str, str]:
    # 단기예보 발표시각: 02,05,08,11,14,17,20,23시 (약 10분 뒤 API 반영)
    base_hours = [2, 5, 8, 11, 14, 17, 20, 23]
    candidate = now - timedelta(minutes=10)
    for h in reversed(base_hours):
        if candidate.hour >= h:
            return candidate.strftime("%Y%m%d"), f"{h:02d}00"
    # 자정 이전이면 전날 23시 발표분 사용
    prev_day = candidate - timedelta(days=1)
    return prev_day.strftime("%Y%m%d"), "2300"


def _dummy_tomorrow_rain_prob() -> float:
    # 실제 API 키 없을 때의 데모용 폴백: 날짜를 시드로 결정론적 0~100 값 생성(하루 단위로만 바뀜)
    seed = (datetime.now() + timedelta(days=1)).strftime("%Y%m%d")
    return round(random.Random(seed).uniform(0, 100), 1)


def _parse_pcp_mm(pcp_value: str) -> float | None:
    """기상청 PCP(1시간 강수량) 카테고리 문자열(예: '강수없음', '1.0mm 미만', '30.0~50.0mm',
    '50.0mm 이상')을 근사 mm 값으로 변환. 형식이 안 맞아 못 읽으면 None(파싱 실패)을 반환 —
    "비가 확인상 없다"(0.0)와 "확인이 안 됐다"(None)를 구분해야 폴백 로직이 안전하게 동작한다."""
    if not pcp_value:
        return None
    if "없음" in pcp_value:
        return 0.0
    numbers = re.findall(r"[\d.]+", pcp_value)
    if not numbers:
        return None
    return max(float(n) for n in numbers)


def classify_weather_mode(pop: float, pcp_3h_mm: float | None) -> str:
    """강수확률(POP)과 3시간 누적 강수량(PCP 롤링 합산, v2.11)을 함께 봐서
    NORMAL/RAIN/HEAVY_RAIN으로 분류.

    3시간 누적치를 신뢰할 수 있으면(계산 성공) 그걸 우선 쓴다 — POP만으로는 "올 확률은 높은데
    이슬비"와 "올 확률은 낮은데 물폭탄"을 구분 못 하기 때문. 계산에 실패했을 때만(예: 연속된
    시간대 데이터가 부족한 경우) POP 단독 임계값으로 근사한다.
    """
    if pcp_3h_mm is not None:
        if pcp_3h_mm >= HEAVY_RAIN_PCP_3H_MM:
            return HEAVY_RAIN
        if pcp_3h_mm > 0 or pop >= RAIN_POP_THRESHOLD:
            return RAIN
        return NORMAL

    if pop >= HEAVY_RAIN_POP_THRESHOLD:
        return HEAVY_RAIN
    if pop >= RAIN_POP_THRESHOLD:
        return RAIN
    return NORMAL


def _hourly_pcp_by_time(items: list[dict]) -> dict[str, float]:
    """items 중 PCP 카테고리만 뽑아 {fcstTime("HHMM"): mm} 형태로 변환. 파싱 실패한
    시간대(예: 형식이 안 맞는 문자열)는 제외 — 3시간 롤링 합산이 그 구멍을 건너뛰게 한다."""
    result: dict[str, float] = {}
    for item in items:
        if item.get("category") != "PCP":
            continue
        mm = _parse_pcp_mm(item.get("fcstValue"))
        if mm is not None:
            result[item["fcstTime"]] = mm
    return result


def _max_rolling_3h_pcp(hourly_pcp: dict[str, float]) -> float | None:
    """실제로 연속된(1시간 간격) 3개 시간대의 PCP 합 중 최댓값을 반환 — 호우주의보/경보가 쓰는
    "3시간 누적 강수량" 기준과 같은 단위로 비교하기 위함(v2.11). 하루 중 어느 3시간 구간이든
    폭우 수준에 도달하면 잡아내야 하므로 고정된 창이 아니라 모든 창 중 최댓값을 쓴다. 데이터가
    3개 미만이거나 연속된 3개 시간대를 하나도 못 찾으면(단기예보가 드물게 시간대를 건너뛴 경우)
    None을 반환해 호출부가 POP 단독 판정으로 안전하게 폴백하게 한다."""
    times = sorted(hourly_pcp.keys())  # "HHMM" 문자열 — 사전순 정렬이 시간순과 동일
    best = None
    for i in range(len(times) - 2):
        t0, t1, t2 = times[i], times[i + 1], times[i + 2]
        h0, h1, h2 = int(t0[:2]), int(t1[:2]), int(t2[:2])
        if h1 - h0 != 1 or h2 - h1 != 1:
            continue
        total = hourly_pcp[t0] + hourly_pcp[t1] + hourly_pcp[t2]
        if best is None or total > best:
            best = total
    return best


def fetch_tomorrow_weather(lat: float = CHEONAN_CITY_HALL_LAT, lng: float = CHEONAN_CITY_HALL_LNG) -> dict:
    """천안시 대표 좌표 1곳만 조회한 내일자 강수확률(POP)·강수량(PCP)·날씨 모드.

    강수확률은 drain마다 다르지 않고 천안시 전역이 사실상 동일한 예보 격자권이므로,
    drain별로 반복 조회하지 않고 대표 좌표 1곳만 조회해 시스템 전역 알림 판단에 쓴다(2.2절 개정).

    반환하는 `pcp_mm`은 표시용 참고값(내일 예상되는 시간당 최대 강수량 1개)이고, 실제 날씨 모드
    판정(`classify_weather_mode`)에는 `pcp_3h_mm`(하루 중 어느 3시간이든 최대 누적치, v2.11)을
    쓴다 — 기상청 호우주의보/경보가 3시간 누적 기준이라 그와 같은 단위로 비교해야 하기 때문.
    """
    if not KMA_API_KEY:
        pop = _dummy_tomorrow_rain_prob()
        return {"pop": pop, "pcp_mm": None, "pcp_3h_mm": None, "mode": classify_weather_mode(pop, None)}

    try:
        nx, ny = latlng_to_grid(lat, lng)
        base_date, base_time = _latest_base_datetime(datetime.now())
        resp = requests.get(
            KMA_URL,
            params={
                "serviceKey": KMA_API_KEY,
                "numOfRows": 1000,
                "pageNo": 1,
                "dataType": "JSON",
                "base_date": base_date,
                "base_time": base_time,
                "nx": nx,
                "ny": ny,
            },
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data["response"]["body"]["items"]["item"]
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y%m%d")
        tomorrow_items = [item for item in items if item.get("fcstDate") == tomorrow]

        pop_values = [float(i["fcstValue"]) for i in tomorrow_items if i["category"] == "POP"]
        hourly_pcp = _hourly_pcp_by_time(tomorrow_items)

        pop = max(pop_values) if pop_values else _dummy_tomorrow_rain_prob()
        pcp_mm = max(hourly_pcp.values()) if hourly_pcp else None
        pcp_3h_mm = _max_rolling_3h_pcp(hourly_pcp)
        return {
            "pop": pop,
            "pcp_mm": pcp_mm,
            "pcp_3h_mm": pcp_3h_mm,
            "mode": classify_weather_mode(pop, pcp_3h_mm),
        }
    except Exception:
        # 타임아웃/네트워크 오류/응답 형식 이상 등 어떤 실패든 데모 진행을 막지 않도록 폴백 처리
        pop = _dummy_tomorrow_rain_prob()
        return {"pop": pop, "pcp_mm": None, "pcp_3h_mm": None, "mode": classify_weather_mode(pop, None)}


def elevation_risk(elevation: float | None, min_elev: float | None, max_elev: float | None) -> float:
    if elevation is None or min_elev is None or max_elev is None or max_elev == min_elev:
        return 0.5
    return (max_elev - elevation) / (max_elev - min_elev)


def staleness_risk(last_updated: datetime | None, now: datetime, weather_mode: str) -> float:
    """마지막 점검(last_updated) 후 경과일을, 현재 날씨 모드의 '오래됨' 기준(일)까지 0→1로
    선형 램프. 기준일을 넘으면 그 이상 지나도 1.0으로 캡 — 얼마나 오래됐든 '이 모드 기준으로는
    이미 최대로 시급하다'는 의미 이상은 더 커지지 않게 한다. 한 번도 점검 안 됐으면 항상 1.0."""
    if last_updated is None:
        return 1.0
    threshold_days = STALENESS_THRESHOLD_DAYS[weather_mode]
    elapsed_days = (now - last_updated).total_seconds() / 86400.0
    return min(1.0, max(0.0, elapsed_days / threshold_days))


def compute_priority_breakdown(
    elevation: float | None,
    min_elev: float | None,
    max_elev: float | None,
    is_flood_zone: bool | None,
    last_occlusion_pct: float | None,
    last_updated: datetime | None = None,
    now: datetime | None = None,
    weather_mode: str = NORMAL,
) -> dict:
    now = now or datetime.utcnow()
    w1, w2, w3, w4 = WEIGHT_PROFILES[weather_mode]
    elevation_risk_v = elevation_risk(elevation, min_elev, max_elev)
    flood_history_flag = 1.0 if is_flood_zone else 0.0
    staleness_risk_v = staleness_risk(last_updated, now, weather_mode)
    # reason 문구엔 캡핑된 staleness_risk_v가 아니라 실제 경과일을 그대로 보여준다 — risk는
    # 임계값에서 1.0으로 캡되지만, "얼마나 지났는지"는 캡 없이 정확히 알려주는 게 맞다.
    elapsed_days = (now - last_updated).total_seconds() / 86400.0 if last_updated else None
    occlusion_norm = (last_occlusion_pct or 0.0) / 100.0

    score = w1 * elevation_risk_v + w2 * flood_history_flag + w3 * staleness_risk_v + w4 * occlusion_norm

    if elapsed_days is None:
        staleness_reason = f"한 번도 점검되지 않음 (+{w3 * staleness_risk_v:.2f})"
    else:
        staleness_reason = f"마지막 점검 후 {elapsed_days:.0f}일 경과 (+{w3 * staleness_risk_v:.2f})"

    contributions = [
        (w4 * occlusion_norm, f"최근 차폐율 {occlusion_norm * 100:.0f}% 감지됨 (+{w4 * occlusion_norm:.2f})") if w4 > 0 and occlusion_norm > 0.05 else None,
        (w2 * flood_history_flag, f"과거 침수 중점관리구역으로 지정됨 (+{w2 * flood_history_flag:.2f})") if w2 > 0 and flood_history_flag > 0 else None,
        (w1 * elevation_risk_v, f"주변 대비 저지대 (고도 위험도 {elevation_risk_v:.2f}) (+{w1 * elevation_risk_v:.2f})") if w1 > 0 and elevation_risk_v > 0.3 else None,
        (w3 * staleness_risk_v, staleness_reason) if w3 > 0 and staleness_risk_v > 0.3 else None,
    ]
    contributions = [c for c in contributions if c is not None]
    contributions.sort(key=lambda x: -x[0])
    reasons = [text for _, text in contributions]

    return {
        "score": score,
        "elevation_risk": elevation_risk_v,
        "flood_history_flag": flood_history_flag,
        "staleness_risk": staleness_risk_v,
        "occlusion_norm": occlusion_norm,
        "reasons": reasons,
        "weather_mode": weather_mode,
    }
