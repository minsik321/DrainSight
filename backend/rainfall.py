"""기상청 지상(종관, ASOS) 일자료 조회서비스 — 천안 관측소의 실측 과거 일강수량.

forecast.py가 쓰는 단기예보(내일 강수확률)와 달리 이건 "이미 지나간" 날짜의 실측값이라
분석 페이지의 기간별 추이 차트에 실제 강수 이력을 겹쳐 보여줄 수 있다. KMA_API_KEY는
forecast.py와 같은 공공데이터포털 인증키를 그대로 재사용하지만, 공공데이터포털은 API
상품마다 개별로 "활용신청" 승인을 받아야 호출이 성공한다 — 단기예보(VilageFcstInfoService)만
신청해둔 키로 이 모듈(AsosDalyInfoService)을 호출하면 그것만 실패한다. data.go.kr에서
"기상청_지상(종관, ASOS) 일자료 조회서비스"도 추가로 활용신청을 해야 실제 값이 나온다 —
신청 전까지는 아래 더미 폴백이 대신 채운다.

천안 ASOS 지점번호는 232로 여러 공개 자료에 나오지만, 기상청 지상기상관측 지점정보
조회서비스로 공식 대조는 못 했다 — flood.py 상단의 "필드명 미확인" 캐비어트와 같은 성격의
한계이니, 실제 발표 전에 data.kma.go.kr 지점정보에서 한 번 더 확인해두는 게 좋다.
"""
import os
import random
from datetime import datetime, timedelta

import requests

KMA_API_KEY = os.environ.get("KMA_API_KEY", "")
ASOS_DAILY_URL = "http://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList"
CHEONAN_ASOS_STN_ID = "232"


def _dummy_daily_rainfall(days: int) -> list[dict]:
    """API 키 없음/미승인/호출 실패 시 폴백. forecast.py의 더미 강수확률과 같은 패턴으로
    날짜를 시드 삼아 결정론적 값을 만들어 데모 중 새로고침해도 값이 안 바뀌게 한다. 비
    오는 날을 20% 확률로만 섞어 그래프가 매일 강수량으로 도배되지 않게 한다."""
    result = []
    today = datetime.utcnow().date()
    for i in range(days, 0, -1):
        day = today - timedelta(days=i)
        rng = random.Random(day.strftime("%Y%m%d"))
        rainfall = round(rng.uniform(15, 60), 1) if rng.random() < 0.2 else 0.0
        result.append({"date": day.isoformat(), "rainfall_mm": rainfall, "source": "dummy"})
    return result


def fetch_daily_rainfall(days: int = 30, stn_id: str = CHEONAN_ASOS_STN_ID) -> list[dict]:
    """최근 `days`일간 천안 관측소의 실측 일강수량(mm). ASOS 일자료는 당일치가 마감 전이라
    조회에 안 잡힐 수 있어 어제까지만 요청한다. 키 없음/네트워크 오류/응답 형식 이상 등
    어떤 이유로든 실패하면 forecast.py와 같은 원칙으로 더미 값 전체로 폴백한다 — 날짜별로
    성공/실패를 섞어 보여주는 것보다 source 필드 하나로 "이 구간 전체가 진짜인지 아닌지"를
    명확히 구분하는 편이 데모에서 덜 헷갈린다."""
    if not KMA_API_KEY:
        return _dummy_daily_rainfall(days)

    end = datetime.utcnow().date() - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    try:
        resp = requests.get(
            ASOS_DAILY_URL,
            params={
                "serviceKey": KMA_API_KEY,
                "numOfRows": days + 5,
                "pageNo": 1,
                "dataType": "JSON",
                "dataCd": "ASOS",
                "dateCd": "DAY",
                "startDt": start.strftime("%Y%m%d"),
                "endDt": end.strftime("%Y%m%d"),
                "stnIds": stn_id,
            },
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        header = data["response"]["header"]
        if header.get("resultCode") not in ("00", 0, "0"):
            return _dummy_daily_rainfall(days)

        items = data["response"]["body"]["items"]["item"]
        if isinstance(items, dict):
            items = [items]

        by_date: dict[str, float] = {}
        for item in items:
            tm = item.get("tm")
            if not tm:
                continue
            raw = item.get("sumRn")
            try:
                by_date[tm] = float(raw) if raw not in (None, "", "-") else 0.0
            except (TypeError, ValueError):
                by_date[tm] = 0.0

        result = []
        cursor = start
        while cursor <= end:
            key = cursor.isoformat()
            result.append({"date": key, "rainfall_mm": by_date.get(key, 0.0), "source": "real"})
            cursor += timedelta(days=1)
        return result
    except Exception:
        return _dummy_daily_rainfall(days)
