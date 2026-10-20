"""Download the public sample photos listed in samples/sources.json and turn each into a
short "camera" clip (a slow pan, 20 s, 1280x720, 25 fps) for demos and testing.

    python scripts/fetch_samples.py [--out samples] [--seconds 20]

Needs internet access (it runs in CI and in the hosted demo image) and ffmpeg.
Writes samples/<slug>.jpg, samples/<slug>.mp4 and samples/ATTRIBUTION.md.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "image/jpeg,image/*;q=0.8,*/*;q=0.5",
}


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data.startswith(b"\xff\xd8"):
        raise ValueError(f"not a JPEG from {url} ({len(data)} bytes)")
    dest.write_bytes(data)


def fetch_photo(p: dict, dest: Path) -> None:
    """Try the Unsplash image CDN first, then the photo's download link."""
    urls = []
    if p.get("cdn_id"):
        urls.append(f"https://images.unsplash.com/{p['cdn_id']}?fm=jpg&q=80&w=2400")
    urls.append(f"https://unsplash.com/photos/{p['unsplash_id']}/download?force=true&w=2400")
    errors = []
    for url in urls:
        try:
            download(url, dest)
            return
        except Exception as e:  # try the next source
            errors.append(f"{url}: {e}")
    raise RuntimeError("; ".join(errors))


def make_clip(img: Path, out: Path, seconds: int) -> None:
    frames = seconds * 25
    # Scale to cover 1280x720 with room to pan, then drift slowly left-right like a PTZ camera.
    vf = (
        "scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900,"
        f"zoompan=z='1.0':x='(iw-1280)/2+sin(on/{frames}*2*PI)*(iw-1280)/2.2':y='(ih-720)/2':"
        f"d={frames}:s=1280x720:fps=25"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(img), "-vf", vf, "-t", str(seconds),
         "-c:v", "libx264", "-preset", "veryfast", "-bf", "0", "-g", "25", "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "samples"))
    ap.add_argument("--seconds", type=int, default=20)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((ROOT / "samples" / "sources.json").read_text(encoding="utf-8"))
    credits = ["# مصادر الصور التجريبية", "", meta["license"], "", meta["note"], "",
               "| المقطع | المكان | المصوّر | المصدر |", "| --- | --- | --- | --- |"]
    ok = 0
    for p in meta["photos"]:
        img = out / f"{p['slug']}.jpg"
        clip = out / f"{p['slug']}.mp4"
        try:
            if not img.exists():
                fetch_photo(p, img)
            make_clip(img, clip, args.seconds)
            ok += 1
            print(f"ok   {clip.name}")
        except Exception as e:  # keep going: one missing photo should not break a deploy
            print(f"::warning::skip {p['slug']}: {e}")
            continue
        credits.append(f"| {clip.name} | {p['place']} | [{p['photographer']}](https://unsplash.com/@{p['handle']}) | [Unsplash]({p['page']}) |")
    (out / "ATTRIBUTION.md").write_text("\n".join(credits) + "\n", encoding="utf-8")
    print(f"{ok}/{len(meta['photos'])} clips ready in {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
