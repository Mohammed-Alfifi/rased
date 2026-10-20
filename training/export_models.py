"""Export the YOLO models for faster inference.

    python training/export_models.py --format onnx            # any machine
    python training/export_models.py --format engine --half   # NVIDIA GPU with TensorRT installed

Then point the vision service at the exported files:
    RASED_POSE_MODEL=services/vision/models/yolo11n-pose.engine
    RASED_OBJECT_MODEL=services/vision/models/yolo11n.engine

The fight classifier (fight.onnx) runs through ONNX Runtime and picks the TensorRT
execution provider automatically when it is available.
"""
from __future__ import annotations

import argparse

DEFAULT_MODELS = ["services/vision/models/yolo11n-pose.pt", "services/vision/models/yolo11n.pt"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--format", choices=["onnx", "engine", "openvino"], default="onnx")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--half", action="store_true", help="FP16 (GPU only)")
    ap.add_argument("--int8", action="store_true", help="INT8 TensorRT (needs --data for calibration)")
    ap.add_argument("--data", default=None, help="dataset yaml used for INT8 calibration")
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    from ultralytics import YOLO

    for path in args.models:
        model = YOLO(path)
        kwargs = dict(format=args.format, imgsz=args.imgsz, half=args.half, device=args.device)
        if args.format == "onnx":
            kwargs.update(dynamic=False, simplify=True)
        if args.int8:
            kwargs.update(int8=True, data=args.data)
        out = model.export(**kwargs)
        print(f"{path} -> {out}")


if __name__ == "__main__":
    main()
