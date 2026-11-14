#!/bin/zsh
# Double-click to start the live ASCII webcam. Close the window or press Esc to stop.
cd "$(dirname "$0")" || exit 1
python3 ascii_cam.py "$@"
