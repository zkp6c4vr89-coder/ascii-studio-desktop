# ASCII Studio: Desktop (macOS)

Python tools that turn photos, videos and your webcam into colourful ASCII art.

| Script | What it does |
|---|---|
| `ascii_cam.py` | Live ASCII webcam, also sent to Zoom / Meet / Teams via OBS Virtual Camera |
| `ascii_convert.py` | Convert photos → PNG/TXT and videos → MP4 (sound kept); make wallpapers |
| `ascii_wallpaper.py` | Animated ASCII desktop wallpaper behind your icons, menu-bar controls |
| `ascii_core.py` | The engine (NumPy + OpenCV, ~16 ms per HD frame) |

## Setup
```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```
After that, the scripts find `.venv` on their own, so plain `python3 ascii_cam.py` works.
Video sound and camera-by-name need `ffmpeg` (`brew install ffmpeg`).

## ASCII webcam
```
python3 ascii_cam.py              # built-in camera, 1280x720
python3 ascii_cam.py --hd         # 1920x1080
python3 ascii_cam.py --list       # list cameras
python3 ascii_cam.py --camera EOS # pick a camera by (part of) its name
```
Or double-click **ASCII Cam.command**.
Keys: `1` colour `2` matrix `3` mono · `[` `]` size · `E` edges · `G` glow · `M` mirror ·
`V` virtual cam · `S` snapshot · `Esc` quit.

**For Zoom (one time):** give your terminal/VS Code Camera access (System Settings → Privacy &
Security → Camera); open OBS → *Start Virtual Camera* → allow the extension → stop and quit OBS.
Then choose **OBS Virtual Camera** in Zoom.

## Convert files
```
python3 ascii_convert.py photo.jpg                   # photo_ascii.png
python3 ascii_convert.py photo.jpg --txt --cell 6    # more detail + plain text
python3 ascii_convert.py clip.mp4 --style matrix     # clip_ascii.mp4 with sound
python3 ascii_convert.py photo.jpg --wallpaper --set # screen-sized, set as desktop picture
```

## Animated wallpaper
```
python3 ascii_wallpaper.py              # character rain
python3 ascii_wallpaper.py clip.mp4     # your video, looping
python3 ascii_wallpaper.py photo.jpg    # photo with a gentle shimmer
```
Quit or change source from the ▚ menu-bar icon. Drops to 15 fps on battery.
It shows `web/wallpaper.html` (copied from **ascii-studio-web**; refresh with
`python3 sync_web.py ../ascii-studio-web`).
