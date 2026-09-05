"""추론(drain_area/drain_full 마스크 픽셀 수 산출) + 차폐율 계산 (기획안 3.1절, v3 개정).

차폐율(%) = (1 - drain_area_px / drain_full_px) x 100
drain_area = 현재 보이는(막히지 않은) 영역, drain_full = 빗물받이 전체 물리적 윤곽.
과거 버전은 drain별 외부 baseline_pixels.json과 현재 마스크를 비교했으나, 서로 다른 물리적
빗물받이/촬영 거리 간 baseline이 어긋나면 차폐율이 왜곡되는 문제가 있었다. v4/v5에서 라벨을
drain_area + drain_full 2-클래스로 나눠 사진 한 장 내에서 자체적으로 차폐율을 계산하도록
바꿔 이 baseline 의존성을 완전히 제거했다 (baseline_pixels.json은 더 이상 쓰지 않는다).

판정 규칙: drain_full이 차폐율 계산의 분모(기준)이므로 반드시 검출돼야 판정이 가능하다.
    - drain_area, drain_full 둘 다 검출: 정상적으로 차폐율 계산
    - drain_full만 검출 (drain_area 미검출): 보이는 부분이 전혀 없다는 뜻 -> 완전 막힘(100%)
    - drain_area만 검출 (drain_full 미검출): 기준(drain_full)이 없어 판정 불가 -> UNASSESSABLE
      (drain_area가 잡혔다고 "가려진 게 없다"고 가정하지 않는다 — 그건 근거 없는 낙관이다)
    - 둘 다 미검출: 판정 근거 자체가 없음 -> UNASSESSABLE

단독 실행 (캡처+추론만 검증, GPS/전송 없이):
    python infer.py --source simulate --frames 5
    python infer.py --source video:sample.mp4 --model weights/drain_v5_best.pt
"""
import argparse
import random
from pathlib import Path

# 검출된 마스크의 CLEAR/OCCLUDED/BLOCKED 경계값. BLOCKED(막힘)이 OCCLUDED(부분 차폐)보다
# 심각도가 높다는 전제(대시보드 색상 빨강/주황, 지도 범례 순서와 일치)에 맞춰, 차폐율이
# 더 큰 쪽을 BLOCKED로 분류한다.
CLEAR_MAX_PCT = 15.0
OCCLUDED_MAX_PCT = 60.0


def compute_occlusion(area_px, full_px):
    """area_px/full_px는 각각 drain_area/drain_full 마스크의 픽셀 수 (없으면 0).

    drain_full은 차폐율 계산의 분모(기준)라서 반드시 있어야 판정 가능하다.
    drain_area만 검출되고 drain_full이 없는 경우를 "가려진 게 없다"고 가정하지
    않는다 — 기준이 없으면 그냥 판정 불가(UNASSESSABLE)다.
    """
    if full_px <= 0:
        return None  # 기준(drain_full) 미검출 -> 판정 불가
    if area_px <= 0:
        return 100.0  # 전체 윤곽은 잡혔는데 보이는 부분이 전혀 없음 -> 완전 막힘
    # 모델이 두 클래스를 비일관되게 예측해 area > full이 나온 경우 바닥을 씌워
    # 음수가 나오지 않게 한다.
    full_eff = max(area_px, full_px)
    pct = (1 - area_px / full_eff) * 100
    return max(0.0, min(100.0, pct))


def classify(occlusion_pct):
    if occlusion_pct is None:
        return "UNASSESSABLE"
    if occlusion_pct < CLEAR_MAX_PCT:
        return "CLEAR"
    if occlusion_pct < OCCLUDED_MAX_PCT:
        return "OCCLUDED"
    return "BLOCKED"


class Detector:
    def __init__(self, model_path=None):
        self.model = None
        self.area_id = None
        self.full_id = None
        if model_path:
            if not Path(model_path).exists():
                print(f"[infer] 모델 파일을 찾을 수 없음: {model_path} -> 더미 fallback으로 동작")
            else:
                try:
                    from ultralytics import YOLO

                    self.model = YOLO(model_path)
                    name_to_id = {v: k for k, v in self.model.names.items()}
                    self.area_id = name_to_id.get("drain_area")
                    self.full_id = name_to_id.get("drain_full")
                    if self.area_id is None or self.full_id is None:
                        print(
                            f"[infer] 모델 클래스에 drain_area/drain_full이 없음: {self.model.names} "
                            "-> 더미 fallback으로 동작"
                        )
                        self.model = None
                except ImportError:
                    print("[infer] ultralytics 미설치 -> 더미 fallback으로 동작")

    def infer_occlusion_pixels(self, frame, frame_idx, visit_pos=0):
        """returns (area_px, full_px, confidence).

        visit_pos: 현재 drain 방문(연속 매칭 구간) 내에서 이 프레임이 몇 번째인지
        (run.py가 buffer 길이로 넘김). 더미 fallback의 시드에 섞어 같은 방문 안에서도
        자연스러운 프레임별 변동이 나오게 한다. 실제 모델 추론에는 영향 없음.
        """
        if self.model is not None:
            return self._infer_real(frame)
        return self._infer_dummy(frame_idx, visit_pos)

    def _best_mask_px(self, r, cls_ids, confs, target_id):
        """target_id 클래스 중 confidence가 가장 높은 인스턴스의 마스크 픽셀 수."""
        import numpy as np

        sel = np.where(cls_ids == target_id, confs, -1)
        if sel.max() < 0:
            return 0, None
        i = int(sel.argmax())
        mask = r.masks.data[i].cpu().numpy() > 0.5
        return int(mask.sum()), float(confs[i])

    def _infer_real(self, frame):
        # conf=0.8: 실전 검증에서 진짜 빗물받이는 항상 confidence 0.9+, 오탐/중복 검출은
        # 0.5~0.68 사이에 몰려 있어 이 임계값으로 대부분 걸러짐 (기획안 3.1절 관련 논의).
        results = self.model.predict(frame, conf=0.8, verbose=False)
        r = results[0]
        if r.masks is None or r.boxes is None or len(r.masks.data) == 0:
            return 0, 0, None

        import numpy as np

        cls_ids = r.boxes.cls.cpu().numpy().astype(int)
        confs = r.boxes.conf.cpu().numpy()
        area_px, area_conf = self._best_mask_px(r, cls_ids, confs, self.area_id)
        full_px, full_conf = self._best_mask_px(r, cls_ids, confs, self.full_id)
        candidates = [c for c in (area_conf, full_conf) if c is not None]
        confidence = max(candidates) if candidates else None
        return area_px, full_px, confidence

    def _infer_dummy(self, frame_idx, visit_pos=0):
        # 실제 파인튜닝 가중치가 준비되면 이 fallback을 실제 ultralytics YOLO 추론으로 교체.
        # 방문 시작 시점의 frame_idx(= frame_idx - visit_pos)로 이 방문의 "기준값"(전체
        # 윤곽 픽셀 수)을 정해 같은 방문 안의 프레임들은 한 값 주변에 모이게 하고, 그 위에
        # frame_idx+visit_pos를 섞은 시드로 차폐 정도(occlusion_frac)를 흔들어 CLEAR/
        # OCCLUDED/BLOCKED가 고루 나오게 한다. (frame_idx, visit_pos)가 같으면 항상 같은
        # 값을 내는 결정론은 유지된다.
        visit_start_idx = frame_idx - visit_pos
        full_px = random.Random(visit_start_idx).choice([8000, 9000, 10500, 12000, 13500])

        rng = random.Random(frame_idx * 1000 + visit_pos)
        if rng.random() < 0.1:
            # 10%: 완전 미검출 (센서 노이즈/역광 등)
            return 0, 0, None
        if rng.random() < 0.1:
            # 10%: drain_full만 검출 -> 완전 막힘 케이스 재현
            return 0, full_px, round(rng.uniform(0.6, 0.9), 2)

        occlusion_frac = rng.choice([0.0, 0.05, 0.25, 0.45, 0.75, 0.95])
        jitter = rng.uniform(-0.05, 0.05)
        visible_frac = max(0.0, min(1.0, (1 - occlusion_frac) + jitter))
        area_px = max(0, int(full_px * visible_frac))
        confidence = round(rng.uniform(0.6, 0.97), 2)
        return area_px, full_px, confidence


class SimulateCapture:
    """카메라 없이 파이프라인 검증용 — 프레임 대신 빈 배열만 생성, 판정은 더미 추론이 담당."""

    def read(self):
        import numpy as np

        return np.zeros((480, 640, 3), dtype="uint8")

    def close(self):
        pass


class VideoCapture:
    def __init__(self, path):
        import cv2

        self._cv2 = cv2
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise RuntimeError(f"영상을 열 수 없습니다: {path}")

    def read(self):
        ok, frame = self.cap.read()
        if not ok:
            # 데모 영상이 짧을 수 있으므로 끝나면 처음부터 반복
            self.cap.set(self._cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.cap.read()
        return frame

    def close(self):
        self.cap.release()


class WebcamCapture(VideoCapture):
    def __init__(self, index):
        import cv2

        self._cv2 = cv2
        self.cap = cv2.VideoCapture(int(index))
        if not self.cap.isOpened():
            raise RuntimeError(f"웹캠을 열 수 없습니다: index={index}")


class PiCameraCapture:
    """Pi 전용. 이 환경에는 picamera2가 없을 수 있으므로 optional import로 처리."""

    def __init__(self):
        try:
            from picamera2 import Picamera2
        except ImportError as e:
            raise RuntimeError(
                "picamera2 모듈이 없습니다. Pi 배포 시 'pip install picamera2' 필요."
            ) from e
        self.cam = Picamera2()
        self.cam.start()

    def read(self):
        return self.cam.capture_array()

    def close(self):
        self.cam.stop()


def build_capture_source(spec):
    """spec: 'simulate' | 'video:<path>' | 'webcam:<index>' | 'picamera2'"""
    if spec == "simulate":
        return SimulateCapture()
    if spec.startswith("video:"):
        return VideoCapture(spec.split(":", 1)[1])
    if spec.startswith("webcam:"):
        return WebcamCapture(spec.split(":", 1)[1])
    if spec == "picamera2":
        return PiCameraCapture()
    raise ValueError(f"알 수 없는 capture source: {spec}")


def _main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", default="simulate", help="simulate | video:<path> | webcam:<index> | picamera2")
    p.add_argument("--model", default=None, help="YOLO11n-seg 가중치(.pt) 경로 (없으면 더미 fallback)")
    p.add_argument("--frames", type=int, default=5)
    args = p.parse_args()

    capture = build_capture_source(args.source)
    detector = Detector(args.model)
    try:
        for i in range(args.frames):
            frame = capture.read()
            area_px, full_px, conf = detector.infer_occlusion_pixels(frame, i)
            occlusion_pct = compute_occlusion(area_px, full_px)
            status = classify(occlusion_pct)
            occlusion_text = f"{occlusion_pct:.1f}%" if occlusion_pct is not None else "-"
            print(
                f"frame={i} area_px={area_px} full_px={full_px} confidence={conf} "
                f"occlusion={occlusion_text} status={status}"
            )
    finally:
        capture.close()


if __name__ == "__main__":
    _main()
