"""Convert a photo or video into ASCII art.

  python ascii_convert.py photo.jpg                     -> photo_ascii.png
  python ascii_convert.py photo.jpg --txt               -> also photo_ascii.txt
  python ascii_convert.py clip.mp4 --style matrix       -> clip_ascii.mp4 (keeps sound)
  python ascii_convert.py photo.jpg --wallpaper --set   -> screen-sized PNG, set as desktop picture
"""

from __future__ import annotations

import _venv  # noqa: F401  (restarts with the project Python if needed)

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2

from ascii_core import STYLES, AsciiRenderer, Settings

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".heic"}
MAX_PHOTO_W = 3840


def screen_size() -> tuple[int, int]:
    out = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True).stdout
    m = re.search(r"Resolution:\s*(\d+)\s*x\s*(\d+)", out)
    return (int(m[1]), int(m[2])) if m else (2560, 1600)


def set_wallpaper(path: Path) -> None:
    script = f'tell application "System Events" to tell every desktop to set picture to "{path.resolve()}"'
    subprocess.run(["osascript", "-e", script], check=True)


def read_image(path: Path):
    img = cv2.imread(str(path))
    if img is None and path.suffix.lower() == ".heic":
        tmp = Path(tempfile.mkdtemp()) / "in.png"  # macOS can convert HEIC for us
        subprocess.run(["sips", "-s", "format", "png", str(path), "--out", str(tmp)], capture_output=True)
        img = cv2.imread(str(tmp))
    if img is None:
        sys.exit(f"Couldn't read {path}")
    return img


def convert_photo(args, renderer: AsciiRenderer, src: Path, out: Path) -> None:
    img = read_image(src)
    size = None
    if args.wallpaper:
        size = args.size or screen_size()
    elif img.shape[1] > MAX_PHOTO_W:
        k = MAX_PHOTO_W / img.shape[1]
        img = cv2.resize(img, (MAX_PHOTO_W, round(img.shape[0] * k)), interpolation=cv2.INTER_AREA)
    if args.cols:
        width = size[0] if size else img.shape[1]
        renderer.settings = renderer.settings.with_cell(width // args.cols)
    art = renderer.render(img, size)
    cv2.imwrite(str(out), art)
    print(f"saved {out}  ({art.shape[1]}x{art.shape[0]})")
    if args.txt:
        txt = out.with_suffix(".txt")
        txt.write_text(renderer.to_text(img if size is None else cv2.resize(img, size)))
        print(f"saved {txt}")
    if args.set:
        set_wallpaper(out)
        print("desktop picture updated")


def convert_video(args, renderer: AsciiRenderer, src: Path, out: Path) -> None:
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        sys.exit(f"Couldn't open {src}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    size = args.size or ((w // 2 * 2, h // 2 * 2) if w <= 1920 else (1920, round(1920 * h / w) // 2 * 2))
    if args.cols:
        renderer.settings = renderer.settings.with_cell(size[0] // args.cols)

    ffmpeg = shutil.which("ffmpeg")
    silent = Path(tempfile.mkdtemp()) / "video.mp4"
    writer = cv2.VideoWriter(str(silent if ffmpeg else out), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    n, t0 = 0, time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(renderer.render(frame, size))
        n += 1
        if n % 15 == 0:
            pct = f"{100 * n / total:3.0f}%" if total else f"{n} frames"
            print(f"\r  {pct}  ({n / (time.time() - t0):.0f} fps)", end="", flush=True)
    writer.release()
    cap.release()
    print(f"\r  {n} frames done{' ' * 20}")

    if ffmpeg:  # re-encode to H.264 (plays everywhere) and copy the original sound back in
        cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(silent), "-i", str(src),
               "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
               "-c:a", "aac", "-shortest", str(out)]
        if subprocess.run(cmd).returncode != 0:
            shutil.copy(silent, out)
            print("  (ffmpeg failed, saved without sound)")
    else:
        print("  (ffmpeg not found, saved without sound)")
    print(f"saved {out}")


def parse_size(text: str) -> tuple[int, int]:
    w, h = text.lower().split("x")
    return int(w), int(h)


def main() -> None:
    p = argparse.ArgumentParser(description="Turn a photo or video into ASCII art.")
    p.add_argument("input", type=Path)
    p.add_argument("-o", "--output", type=Path)
    p.add_argument("--style", choices=STYLES, default="colour")
    p.add_argument("--cell", type=int, default=8, help="character width in pixels (smaller = more detail)")
    p.add_argument("--cols", type=int, help="number of characters across (overrides --cell)")
    p.add_argument("--contrast", type=float, default=1.25)
    p.add_argument("--glow", type=float, default=0.45)
    p.add_argument("--no-edges", action="store_true")
    p.add_argument("--txt", action="store_true", help="also save the plain-text characters")
    p.add_argument("--wallpaper", action="store_true", help="render at your screen's resolution")
    p.add_argument("--size", type=parse_size, help="output size, e.g. 3840x2160")
    p.add_argument("--set", action="store_true", help="set the result as your desktop picture")
    args = p.parse_args()

    src = args.input
    if not src.exists():
        sys.exit(f"No such file: {src}")
    settings = Settings(style=args.style, contrast=args.contrast, glow=args.glow,
                        edges=not args.no_edges).with_cell(args.cell)
    renderer = AsciiRenderer(settings)
    is_photo = src.suffix.lower() in IMAGE_EXTS
    stamp = f"_{int(time.time())}" if args.set else ""  # macOS caches wallpapers by file name
    out = args.output or src.with_name(f"{src.stem}_ascii{stamp}{'.png' if is_photo else '.mp4'}")
    (convert_photo if is_photo else convert_video)(args, renderer, src, out)


if __name__ == "__main__":
    main()
