"""
DrainSight v5 - 로컬 PC(GPU)용 파인튜닝 스크립트
=====================================================
Google Colab의 DrainSight_v5_train.ipynb 에 있던 "학습" 부분을 그대로
로컬(VS Code 등)에서 실행할 수 있게 옮긴 파일입니다. Colab GPU를 다 썼을 때
이 스크립트로 대신 로컬 GPU에서 파인튜닝할 수 있습니다.

사용 전 준비 (최초 1회)
------------------------
1) 파이썬 가상환경을 만들고 같은 폴더의 requirements.txt를 설치하세요.

     python -m venv venv
     venv\Scripts\activate      (Windows)   /  source venv/bin/activate (Mac/Linux)
     pip install -r requirements.txt

2) PyTorch가 내 GPU(CUDA)를 못 잡으면(cuda 없다고 나오면), 기본 torch 대신
   https://pytorch.org/get-started/locally/ 에서 내 GPU/CUDA 버전에 맞는
   설치 명령을 찾아 torch/torchvision을 다시 설치하세요.
   (예: NVIDIA GPU + CUDA 12.1 이면
        pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121 )

3) 아래 실행하면 됩니다.

     python train_local.py

Roboflow에서 새 버전(v6, v7 ...)으로 다시 학습하고 싶으면 아래 VERSION 숫자만
바꾸면 됩니다 (Colab 노트북과 동일한 방식).
"""

from pathlib import Path
import shutil

import torch
import yaml


def main():
    print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available()
          else "CPU로 실행됩니다 (GPU가 인식되지 않았습니다 - CUDA/드라이버 설치를 확인하세요)")

    # ── 1) Roboflow에서 데이터셋 다운로드 (Colab 노트북과 동일) ───────────
    RF_API_KEY = ""   # 워크스페이스 키 (버전 바뀌어도 그대로)
    WORKSPACE = "-fcrfh"
    PROJECT = "my-first-project-b45jq"
    VERSION = 5                            # <-- 다음번엔 이 숫자만 바꾸면 됨

    base_dir = Path(__file__).resolve().parent
    dest = base_dir / ("drainsight_v%d" % VERSION)
    if dest.exists():
        shutil.rmtree(dest)

    from roboflow import Roboflow
    rf = Roboflow(api_key=RF_API_KEY)
    project = rf.workspace(WORKSPACE).project(PROJECT)
    dataset = project.version(VERSION).download("yolov11", location=str(dest))

    root = Path(dataset.location)
    data_yaml = root / "data.yaml"
    with open(data_yaml, encoding="utf-8") as f:
        data_cfg = yaml.safe_load(f)

    # Roboflow YAML 상대경로 -> 실제 존재하는 절대경로로 보정
    for split in ("train", "val", "test"):
        folder = "valid" if split == "val" else split
        hits = list(root.rglob(folder + "/images"))
        if hits:
            data_cfg[split] = str(hits[0].resolve())
    with open(data_yaml, "w", encoding="utf-8") as f:
        yaml.safe_dump(data_cfg, f, allow_unicode=True, sort_keys=False)

    print("Dataset:", data_yaml)
    print("Classes:", data_cfg.get("names"))
    print("Splits:", {k: data_cfg.get(k) for k in ("train", "val", "test")})
    for split in ("train", "valid", "test"):
        d = root / split / "images"
        print("  %-6s: %d images" % (split, len(list(d.glob("*"))) if d.exists() else 0))

    # ── 2) 학습 (YOLO11n-seg, 100 epochs, Colab 노트북과 동일 설정) ──────
    from ultralytics import YOLO

    model = YOLO("yolo11n-seg.pt")
    train_results = model.train(
        data=str(data_yaml),
        epochs=100,
        imgsz=640,
        batch=16,      # GPU 메모리(VRAM)가 부족하면 8, 4 등으로 줄이세요
        patience=30,
        project="runs",
        name="drain_v%d" % VERSION,
    )

    best_pt = Path(train_results.save_dir) / "weights" / "best.pt"
    print()
    print("=" * 60)
    print("학습 완료! 최종 가중치 파일:")
    print(" ", best_pt)
    print()
    print("이 best.pt를 Colab 검증 노트북(DrainSight_v5_validate.ipynb)에서 쓰려면:")
    print("  1) 이 파일을 내 Google Drive의 MyDrive/DrainSight/drain_v5_best.pt 로 직접 올리거나")
    print("  2) 검증 노트북의 '모델 불러오기' 셀을 실행할 때 뜨는 업로드 창에 이 파일을 올리면")
    print("     자동으로 드라이브에 저장되어 계속 재사용됩니다.")
    print("=" * 60)


if __name__ == "__main__":
    # Windows에서 DataLoader가 멀티프로세싱을 쓰기 때문에 반드시 이 가드가 필요합니다.
    main()
