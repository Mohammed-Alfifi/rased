"""Fine-tune the person / object detector on footage that looks like the facility
(camera angles, lighting, uniforms). Use only data you are authorised to use.

Dataset in YOLO format, described by a yaml file:
    path: /data/facility-yolo
    train: images/train
    val: images/val
    names: {0: person, 1: backpack, 2: handbag, 3: suitcase}

    python training/finetune_yolo.py --data /data/facility-yolo/data.yaml --model yolo11n.pt --epochs 50

The run folder holds mAP50 / mAP50-95, precision, recall and the confusion matrix
(ultralytics writes them); copy weights/best.pt into services/vision/models/.
"""
from __future__ import annotations

import argparse


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default="services/vision/models/yolo11n.pt")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default=None)
    ap.add_argument("--project", default="training/runs/yolo")
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.model)
    model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
                project=args.project, name="finetune", patience=15, cos_lr=True, plots=True)
    metrics = model.val(data=args.data, imgsz=args.imgsz, device=args.device)
    print(f"mAP50={metrics.box.map50:.3f}  mAP50-95={metrics.box.map:.3f}  "
          f"precision={metrics.box.mp:.3f}  recall={metrics.box.mr:.3f}")


if __name__ == "__main__":
    main()
