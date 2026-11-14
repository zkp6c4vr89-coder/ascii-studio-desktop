"""Live ASCII webcam, with output to Zoom / Meet / Teams through OBS Virtual Camera.

  python ascii_cam.py              # preview window + virtual camera
  python ascii_cam.py --camera 1   # use a different webcam
  python ascii_cam.py --hd         # 1920x1080 instead of 1280x720

Keys:  1 colour  2 matrix  3 mono   [ ] character size   E edges   G glow
       M mirror  V virtual camera on/off   S snapshot   Esc quit

One-time setup for Zoom: open OBS, click "Start Virtual Camera" once and allow the
system extension, then quit OBS. In Zoom choose Video -> "OBS Virtual Camera".
"""

from __future__ import annotations

import _venv  # noqa: F401  (restarts with the project Python if needed)

import argparse
import shutil
import subprocess
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pygame

from ascii_core import STYLES, AsciiRenderer, Settings

GLOW_STEPS = (0.0, 0.25, 0.45, 0.8)
SKIP_WORDS = ("virtual", "eos", "desk view", "capture screen")  # not real webcams


def list_cameras() -> list[str]:
    try:
        import AVFoundation as A
        return [str(d.localizedName()) for d in A.AVCaptureDevice.devicesWithMediaType_(A.AVMediaTypeVideo)]
    except Exception:  # noqa: BLE001
        return []


def pick_camera(wanted: str | None, names: list[str]) -> str | None:
    if wanted:
        return next((n for n in names if wanted.lower() in n.lower()), None)
    for n in names:  # prefer the built-in camera, then any real one
        if "macbook" in n.lower() or "facetime" in n.lower():
            return n
    return next((n for n in names if not any(w in n.lower() for w in SKIP_WORDS)), None)


class FFmpegCamera:
    """Opens a camera by name through ffmpeg and always hands back the newest frame,
    so a slow frame never builds up delay."""

    def __init__(self, name: str, w: int, h: int, fps: int):
        self.w, self.h, self.size = w, h, w * h * 3
        self.proc = subprocess.Popen(
            [shutil.which("ffmpeg"), "-loglevel", "fatal", "-f", "avfoundation", "-framerate", str(fps),
             "-video_size", f"{w}x{h}", "-pixel_format", "nv12", "-i", f"{name}:none",
             "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
            stdout=subprocess.PIPE, bufsize=self.size) # type: ignore
        self.frame, self.new, self.alive = None, threading.Event(), True
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while self.alive:
            buf = self.proc.stdout.read(self.size)
            if len(buf) < self.size:
                self.alive = False
                self.new.set()
                return
            self.frame = np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3)
            self.new.set()

    def read(self):
        self.new.wait(timeout=3)
        self.new.clear()
        return self.frame is not None and self.alive, self.frame

    def release(self):
        self.alive = False
        self.proc.terminate()


def open_camera(wanted: str | None, w: int, h: int, fps: int):
    if wanted and wanted.isdigit():
        return cv2.VideoCapture(int(wanted)), f"camera #{wanted}"
    names = list_cameras()
    name = pick_camera(wanted, names)
    if name and shutil.which("ffmpeg"):
        return FFmpegCamera(name, w, h, fps), name
    cap = cv2.VideoCapture(0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
    return cap, "camera #0"


def open_virtual_camera(w: int, h: int, fps: int):
    try:
        import pyvirtualcam
        cam = pyvirtualcam.Camera(w, h, fps, fmt=pyvirtualcam.PixelFormat.BGR)
        print(f"virtual camera: {cam.device}  -> pick it as your camera in Zoom")
        return cam
    except Exception as e:  # noqa: BLE001 - any failure just means "no virtual cam"
        print("virtual camera unavailable:", e)
        print("  fix: open OBS, click 'Start Virtual Camera' once, allow it, quit OBS, run this again")
        return None


def main() -> None:
    p = argparse.ArgumentParser(description="Live ASCII webcam")
    p.add_argument("--camera", help="part of the camera's name (e.g. 'MacBook') or an index; default: built-in")
    p.add_argument("--list", action="store_true", help="list cameras and exit")
    p.add_argument("--hd", action="store_true", help="1920x1080 output")
    p.add_argument("--no-virtual", action="store_true", help="preview only")
    args = p.parse_args()
    if args.list:
        print("\n".join(list_cameras()) or "no cameras found")
        return

    W, H, FPS = (1920, 1080, 30) if args.hd else (1280, 720, 30)
    cap, cam_name = open_camera(args.camera, W, H, FPS)
    print("using", cam_name)
    ok, frame = cap.read()
    if not ok:
        raise SystemExit("Couldn't read the webcam. Give your terminal / VS Code Camera access in "
                         "System Settings > Privacy & Security > Camera, then try again.")

    renderer = AsciiRenderer(Settings().with_cell(9 if args.hd else 7))
    vcam = None if args.no_virtual else open_virtual_camera(W, H, FPS)
    mirror, glow_i = True, 2

    pygame.init()
    info = pygame.display.Info()
    k = min(1.0, 0.8 * info.current_w / W, 0.8 * info.current_h / H)
    window = pygame.display.set_mode((int(W * k), int(H * k)))
    pygame.display.set_caption("ASCII Cam")
    font = pygame.font.SysFont("menlo", 14)
    clock = pygame.time.Clock()
    shots = Path(__file__).resolve().parent / "snapshots"

    running = True
    while running:
        for e in pygame.event.get():
            if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                running = False
            elif e.type == pygame.KEYDOWN:
                s = renderer.settings
                if e.unicode in "123" and e.unicode:
                    s.style = STYLES[int(e.unicode) - 1]
                elif e.unicode == "[":
                    renderer.settings = s.with_cell(s.cell_w - 1)
                elif e.unicode == "]":
                    renderer.settings = s.with_cell(s.cell_w + 1)
                elif e.key == pygame.K_e:
                    s.edges = not s.edges
                elif e.key == pygame.K_g:
                    glow_i = (glow_i + 1) % len(GLOW_STEPS)
                    s.glow = GLOW_STEPS[glow_i]
                elif e.key == pygame.K_m:
                    mirror = not mirror
                elif e.key == pygame.K_v:
                    if vcam:
                        vcam.close()
                        vcam = None
                        print("virtual camera off")
                    else:
                        vcam = open_virtual_camera(W, H, FPS)
                elif e.key == pygame.K_s:
                    shots.mkdir(exist_ok=True)
                    path = shots / f"ascii_cam_{int(time.time())}.png"
                    cv2.imwrite(str(path), art)
                    print("saved", path)

        ok, frame = cap.read()
        if not ok:
            continue
        if mirror:
            frame = cv2.flip(frame, 1)
        art = renderer.render(frame, (W, H))
        if vcam:
            vcam.send(art)

        rgb = np.ascontiguousarray(art[:, :, ::-1].swapaxes(0, 1))
        surf = pygame.transform.smoothscale(pygame.surfarray.make_surface(rgb), window.get_size())
        window.blit(surf, (0, 0))
        s = renderer.settings
        hud = (f"{clock.get_fps():4.1f} fps  {s.style}  cell {s.cell_w}px  edges {'on' if s.edges else 'off'}  "
               f"glow {s.glow}  {'-> Zoom' if vcam else 'preview only'}   [1/2/3 [ ] E G M V S Esc]")
        window.blit(font.render(hud, True, (150, 150, 160), (0, 0, 0)), (8, 6))
        pygame.display.flip()
        clock.tick(FPS)

    cap.release()
    if vcam:
        vcam.close()
    pygame.quit()


if __name__ == "__main__":
    main()
