"""Makes the desktop scripts work however they're started.

If a script is run with the wrong Python (e.g. plain `python3 ascii_cam.py`, or VS Code's
Run button on the system interpreter), the libraries it needs aren't there. Importing this
module first quietly restarts the script with the project's own Python, from the first
`.venv` found in this folder or the three above it.
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for venv in (HERE / ".venv", HERE.parent / ".venv", HERE.parents[1] / ".venv", HERE.parents[2] / ".venv"):
    py = venv / "bin" / "python"
    if py.exists():
        # only restart real script runs (not `python -c ...` or an interactive session)
        if Path(sys.prefix).resolve() != venv.resolve() and sys.argv and Path(sys.argv[0]).is_file():
            os.execv(str(py), [str(py), *sys.argv])
        break
