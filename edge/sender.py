"""백엔드로 판정 결과 POST.

현장 Wi-Fi 불안정이 이미 리스크로 인지되어 있으므로(기획안 7장), 재시도 후에도
실패하면 예외를 던지지 않고 로그만 남긴 뒤 다음 루프로 넘어간다 — 전송 한 건의
실패가 전체 파이프라인을 죽이면 안 된다.
"""
import time

import requests

RETRY_DELAYS = [0.5, 1.0, 2.0]  # 지수 백오프, 최대 3회 재시도

# 매 루프 telemetry+detections 두 번씩 POST하는데, requests.post()를 매번 새로 부르면
# 매번 새 TCP 연결을 맺어서(연결 재사용 없음) 루프 한 틱이 --interval보다 훨씬 오래
# 걸릴 수 있다(실측: 이 지연 때문에 백엔드의 RESULT_MISSING 이벤트 타이머가
# 방문이 아직 끝나지 않았는데도 앞서 만료돼버리는 걸 확인함). Session으로 연결을 재사용.
_session = requests.Session()


def send_detection(backend_url, payload):
    url = f"{backend_url.rstrip('/')}/api/detections"
    last_err = None
    attempts = len(RETRY_DELAYS) + 1
    for attempt in range(attempts):
        if attempt > 0:
            time.sleep(RETRY_DELAYS[attempt - 1])
        try:
            resp = _session.post(url, json=payload, timeout=5)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            last_err = e
            print(f"[sender] 전송 실패 ({attempt + 1}/{attempts}): {e}")

    print(f"[sender] 최종 실패 — 이 건은 건너뛰고 다음 루프로 진행: {last_err}")
    return None


def send_telemetry(backend_url, vehicle_code, lat, lng):
    """감지 성공 여부와 무관하게 매 루프 보내는 가벼운 위치 신호. 실패해도 그냥 무시
    (핵심 경로가 아니라 있으면 좋은 신호일 뿐 — 재시도·로그 없이 조용히 넘어감)."""
    try:
        _session.post(
            f"{backend_url.rstrip('/')}/api/telemetry",
            json={"vehicle_code": vehicle_code, "lat": lat, "lng": lng},
            timeout=1.5,
        )
    except requests.RequestException:
        pass
