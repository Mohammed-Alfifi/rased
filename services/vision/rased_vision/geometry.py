"""Geometry helpers. Zone polygons are stored in normalized coordinates (0..1)."""
from __future__ import annotations

from typing import Iterable, Sequence

Point = tuple[float, float]


def point_in_polygon(pt: Point, polygon: Sequence[Point]) -> bool:
    """Ray casting test. Works for any simple polygon."""
    x, y = pt
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def bbox_foot(bbox: Sequence[float]) -> Point:
    """Bottom-centre of a box: where a standing person touches the floor."""
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, y2)


def bbox_center(bbox: Sequence[float]) -> Point:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def normalize_bbox(bbox: Sequence[float], width: int, height: int) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = bbox
    return (x1 / width, y1 / height, x2 / width, y2 / height)


def distance(a: Point, b: Point) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def polygon_from_json(points: Iterable[Iterable[float]]) -> list[Point]:
    return [(float(p[0]), float(p[1])) for p in points]
