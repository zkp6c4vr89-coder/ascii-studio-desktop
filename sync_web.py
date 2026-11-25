"""Refresh web/ (the studio, renderer and wallpaper scenes) from the ascii-studio-web repo,
when it's checked out next to this one.

  python3 sync_web.py [path/to/ascii-studio-web]
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = ("index.html", "app.js", "style.css", "renderer.js", "scenes.js",
         "wallpaper-store.js", "wallpaper.html", "manifest.webmanifest", "customise.js", "customise.css",
         "seasonal.js", "festive.js")

candidates = [Path(sys.argv[1])] if len(sys.argv) > 1 else [HERE.parent / "ascii-studio-web", HERE.parent / "web"]
src = next((c for c in candidates if (c / "renderer.js").exists()), None)
if not src:
    sys.exit("Couldn't find the web repo. Pass its path: python3 sync_web.py ../ascii-studio-web")
dest = HERE / "web"
dest.mkdir(exist_ok=True)
for f in FILES:
    shutil.copy(src / f, dest / f)
shutil.copytree(src / "brand", dest / "brand", dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("*.py", "__pycache__"))
print(f"copied {len(FILES)} files + brand/ from {src}")
