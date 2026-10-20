"""Evaluation helpers shared by training and the standalone evaluation script."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support, roc_auc_score


def video_scores(window_prob: np.ndarray, video: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A video's score is its highest window score; its label is the window label."""
    ids = np.unique(video)
    scores = np.array([window_prob[video == v].max() for v in ids])
    labels = np.array([y[video == v][0] for v in ids])
    return scores, labels


def summarize(prob: np.ndarray, y: np.ndarray, threshold: float) -> dict:
    pred = (prob >= threshold).astype(int)
    p, r, f, _ = precision_recall_fscore_support(y, pred, average="binary", zero_division=0)
    cm = confusion_matrix(y, pred, labels=[0, 1])
    try:
        auc = float(roc_auc_score(y, prob))
    except ValueError:
        auc = float("nan")
    return {
        "threshold": threshold,
        "precision": round(float(p), 4),
        "recall": round(float(r), 4),
        "f1": round(float(f), 4),
        "auc": round(auc, 4),
        "confusion": {"tn": int(cm[0, 0]), "fp": int(cm[0, 1]), "fn": int(cm[1, 0]), "tp": int(cm[1, 1])},
        "n": int(len(y)),
    }


def best_threshold(prob: np.ndarray, y: np.ndarray, min_recall: float = 0.85) -> float:
    """Highest threshold that still meets the recall target (fewer false alarms), else best F1."""
    grid = np.linspace(0.05, 0.95, 91)
    meeting = [t for t in grid if summarize(prob, y, t)["recall"] >= min_recall]
    if meeting:
        return float(max(meeting))
    return float(max(grid, key=lambda t: summarize(prob, y, t)["f1"]))


def write_report(path: Path, report: dict) -> None:
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    lines = [
        "# Fight classifier evaluation",
        "",
        f"Threshold: {report['threshold']}  (chosen on the validation set for recall >= {report['recall_target']})",
        "",
        "| Level | Precision | Recall | F1 | AUC | TP | FP | FN | TN | N |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for level in ("window", "video"):
        m = report[level]
        c = m["confusion"]
        lines.append(f"| {level} | {m['precision']} | {m['recall']} | {m['f1']} | {m['auc']} | "
                     f"{c['tp']} | {c['fp']} | {c['fn']} | {c['tn']} | {m['n']} |")
    if report.get("synthetic"):
        lines += ["", "**Synthetic smoke-test data. These numbers say nothing about real accuracy.**"]
    path.with_suffix(".md").write_text("\n".join(lines) + "\n")
