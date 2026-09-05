"""Drain Vision Pod 엣지 메인 루프: capture -> infer -> gps match -> send.

지금 당장(카메라/GPS/모델 하드웨어 없이) end-to-end 검증:
    python run.py --simulate --loops 5

실 하드웨어로 이식 시 (기획안 5장: 캡처/GPS 소스만 교체):
    python run.py --source picamera2 --gps serial:/dev/ttyUSB0 --model weights/drain_v5_best.pt

환경변수: BACKEND_URL, VEHICLE_CODE, VEHICLE_ROUTE_ID (인자로도 덮어쓰기 가능)
"""
import argparse
import os
import time

import numpy as np

import gps_match
import infer
import sender


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--simulate",
        action="store_true",
        help="--source simulate --gps simulate 단축 플래그 (하드웨어 없이 파이프라인 전체 검증)",
    )
    p.add_argument("--source", default="simulate", help="simulate | video:<path> | webcam:<index> | picamera2")
    p.add_argument("--gps", default="simulate", help="simulate | serial:<port>")
    p.add_argument(
        "--model", default=None, help="YOLO11n-seg (drain_area+drain_full) 가중치(.pt) 경로 (없으면 더미 fallback)"
    )
    p.add_argument("--backend-url", default=os.environ.get("BACKEND_URL", "http://localhost:8000"))
    p.add_argument("--vehicle-code", default=os.environ.get("VEHICLE_CODE", "DEMO-POD-1"))
    p.add_argument(
        "--vehicle-route-id", type=int, default=int(os.environ.get("VEHICLE_ROUTE_ID", "1"))
    )
    p.add_argument("--loops", type=int, default=0, help="반복 횟수 (0 = 무한 루프)")
    p.add_argument("--interval", type=float, default=1.0, help="루프 간 대기 시간(초)")
    p.add_argument(
        "--match-radius-m",
        type=float,
        default=gps_match.DEFAULT_MAX_MATCH_DISTANCE_M,
        help="GPS 매칭 허용 반경(m) — 이보다 먼 최근접 drain은 매칭 실패로 처리 (기획안 2.1절)",
    )
    p.add_argument(
        "--dwell-ticks",
        type=int,
        default=1,
        help=(
            "시뮬레이터가 각 drain 좌표에 머무는 틱 수 — 방문 집계(이상값 제거+평균) 동작을 "
            "눈으로 확인하려면 4 이상으로 주고 --loops를 넉넉히 줄 것"
        ),
    )
    args = p.parse_args()
    if args.simulate:
        args.source = "simulate"
        args.gps = "simulate"
    return args


def remove_outlier_indices(values):
    """IQR 방식. 표본 4개 미만이면 이상값 판정이 무의미하므로 전부 유지."""
    if len(values) < 4:
        return list(range(len(values)))
    arr = np.array(values)
    q1, q3 = np.percentile(arr, [25, 75])
    iqr = q3 - q1
    lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    kept = [i for i, v in enumerate(values) if lo <= v <= hi]
    return kept if kept else list(range(len(values)))  # 전부 걸러지면(비정상 상황) 원본 유지


def aggregate_visit(drain, readings):
    detected = [r for r in readings if r["occlusion_pct"] is not None]
    unassessable_samples = len(readings) - len(detected)

    # 일부 프레임만 미검출이고 다른 프레임에서 실제 마스크가 잡혔다면 측정 가능한 프레임으로
    # 판정한다. 방문 내 모든 프레임에서 대상을 인식하지 못했을 때만 최종 UNASSESSABLE이 된다.
    if not detected:
        best = min(
            readings,
            key=lambda r: gps_match.haversine_m(r["lat"], r["lng"], drain["lat"], drain["lng"]),
        )
        return {
            "status": "UNASSESSABLE",
            "occlusion_pct": None,
            "confidence": None,
            "lat": best["lat"],
            "lng": best["lng"],
            "sample_count": len(readings),
            "dropped_outliers": 0,
            "unassessable_samples": unassessable_samples,
        }

    occlusions = [r["occlusion_pct"] for r in detected]
    kept_idx = remove_outlier_indices(occlusions)
    kept = [detected[i] for i in kept_idx]

    # 단순평균 대신 confidence 가중평균 — 신뢰도 낮은 프레임(역광·순간 오검출 등)이
    # 최종 차폐율에 미치는 영향력을 줄인다. 표본 전체가 confidence=0이면(비정상 상황)
    # 가중치 합이 0이 되어 나눗셈이 깨지므로 그때만 단순평균으로 폴백.
    confidence_sum = sum(r["confidence"] for r in kept)
    if confidence_sum > 0:
        avg_occlusion = sum(r["occlusion_pct"] * r["confidence"] for r in kept) / confidence_sum
    else:
        avg_occlusion = sum(r["occlusion_pct"] for r in kept) / len(kept)
    avg_confidence = sum(r["confidence"] for r in kept) / len(kept)

    # 다수결 상태, 동률이면 가장 심각한 쪽 우선(안 보임 != 정상 원칙과 일관되게).
    # BLOCKED(막힘)이 OCCLUDED(부분 차폐)보다 심각도가 높다(infer.classify 참고).
    severity = {"BLOCKED": 2, "OCCLUDED": 1, "CLEAR": 0}
    counts = {}
    for r in kept:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    max_count = max(counts.values())
    tied = [s for s, c in counts.items() if c == max_count]
    status = max(tied, key=lambda s: severity[s])

    # drain 등록 좌표에 가장 가까웠던 순간의 GPS 좌표를 대표값으로 사용
    best = min(kept, key=lambda r: gps_match.haversine_m(r["lat"], r["lng"], drain["lat"], drain["lng"]))

    dropped = len(detected) - len(kept)
    return {
        "status": status,
        "occlusion_pct": round(avg_occlusion, 1),
        "confidence": round(avg_confidence, 3),
        "lat": best["lat"],
        "lng": best["lng"],
        "sample_count": len(readings),
        "dropped_outliers": dropped,
        "unassessable_samples": unassessable_samples,
    }


def flush_visit(args, drain, readings, source_tag):
    agg = aggregate_visit(drain, readings)
    payload = {
        "drain_id": drain["id"],
        "vehicle_code": args.vehicle_code,
        "status": agg["status"],
        "occlusion_pct": agg["occlusion_pct"],
        "reason_code": "DRAIN_NOT_DETECTED" if agg["status"] == "UNASSESSABLE" else None,
        "confidence": agg["confidence"],
        "lat": agg["lat"],
        "lng": agg["lng"],
        "source": source_tag,
    }
    occlusion_text = f"{agg['occlusion_pct']}%" if agg["occlusion_pct"] is not None else "-"
    print(
        f"[run] 방문 종료: drain={drain.get('external_code')}(id={drain['id']}) "
        f"표본={agg['sample_count']}건(대상 인식 실패 {agg['unassessable_samples']}건, "
        f"이상치 제외 {agg['dropped_outliers']}건) -> 집계 status={agg['status']} "
        f"occlusion={occlusion_text}"
    )
    sender.send_detection(args.backend_url, payload)


def main():
    args = parse_args()

    print(f"[run] drain 후보 목록 조회: {args.backend_url}/api/drains")
    try:
        drains = gps_match.fetch_drains(args.backend_url)
        matcher = gps_match.DrainMatcher(drains, args.vehicle_route_id, max_distance_m=args.match_radius_m)
        capture = infer.build_capture_source(args.source)
        # 시뮬레이터는 db/drains_seed.json에 새 drain을 추가하면 별도 코드 수정 없이
        # 그 좌표까지 그대로 순회한다 — 매칭 후보군(candidates)을 그대로 재사용.
        waypoints = [(d["lat"], d["lng"]) for d in matcher.candidates]
        gps = gps_match.build_gps_source(args.gps, waypoints=waypoints, dwell=args.dwell_ticks)
        detector = infer.Detector(args.model)
    except Exception as e:
        print(f"[run] 초기화 실패: {e}")
        return

    source_tag = "simulator" if args.source == "simulate" else "pi"

    buffer = []  # 현재 방문 중인 drain에 대해 쌓이는 readings
    buffered_drain = None  # 현재 방문 중인 drain dict (matcher가 반환한 것)

    frame_idx = 0
    try:
        while args.loops == 0 or frame_idx < args.loops:
            frame = capture.read()
            lat, lng = gps.read()

            # 감지 성공 여부와 무관하게 매 루프 무조건, best-effort로 위치를 알린다 —
            # 백엔드가 "근처는 왔는데 최종 감지가 안 왔다"를 판단할 수 있게.
            sender.send_telemetry(args.backend_url, args.vehicle_code, lat, lng)

            drain = matcher.match(lat, lng)
            area_px, full_px, confidence = detector.infer_occlusion_pixels(
                frame, frame_idx, visit_pos=len(buffer)
            )

            matched_id = drain["id"] if drain else None
            buffered_id = buffered_drain["id"] if buffered_drain else None

            if matched_id != buffered_id:
                # 이전 drain에 대한 방문 종료 -> 집계 후 전송
                if buffer and buffered_drain:
                    flush_visit(args, buffered_drain, buffer, source_tag)
                buffer = []
                buffered_drain = drain

            if drain is not None:
                occlusion_pct = infer.compute_occlusion(area_px, full_px)
                status = infer.classify(occlusion_pct)
                buffer.append(
                    {
                        "status": status,
                        "occlusion_pct": occlusion_pct,
                        "confidence": confidence,
                        "lat": lat,
                        "lng": lng,
                    }
                )
                occlusion_text = f"{occlusion_pct:.1f}%" if occlusion_pct is not None else "-"
                print(
                    f"[run] frame={frame_idx} drain={drain.get('external_code')}(id={drain['id']}) "
                    f"프레임 상태={status} 차폐={occlusion_text} "
                    f"(방문 버퍼 {len(buffer)}건 누적, 방문 종료 시 집계 전송)"
                )
            else:
                print(f"[run] frame={frame_idx} 매칭 실패 — 반경 {args.match_radius_m}m 내 등록된 drain 없음")

            frame_idx += 1
            if args.loops == 0 or frame_idx < args.loops:
                time.sleep(args.interval)

        # 루프 종료 시 마지막으로 진행 중이던 방문도 반드시 flush
        if buffer and buffered_drain:
            flush_visit(args, buffered_drain, buffer, source_tag)
    finally:
        capture.close()
        gps.close()


if __name__ == "__main__":
    main()
