"""ASCII Studio core: turns any image (a numpy BGR frame) into ASCII art.

The recipe, step by step:
  1. shrink the frame so one pixel = one character cell
  2. measure brightness, apply contrast / gamma
  3. choose a character whose "ink" matches that brightness
  4. on strong edges, use a stroke that follows the edge:  - / | \\ _
  5. colour each character (full colour, matrix green, or mono)
  6. stamp every character at once from a pre-drawn glyph atlas, then add glow
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/System/Library/Fonts/Menlo.ttc"
# Candidate characters for the brightness ramp. They get sorted by how much
# ink they actually leave on screen, so the order here doesn't matter.
RAMP_CANDIDATES = " .`',:;~-+=*!ir1lcvxzjtfoeasun0{}[]<>?%$#&8B@QWM"
EDGE_CHARS = "|/-\\_"          # index 0..4, see _edge_index()
STYLES = ("colour", "matrix", "mono")


@dataclass
class Settings:
    cell_w: int = 8             # one character cell, in output pixels
    cell_h: int = 14
    style: str = "colour"       # colour | matrix | mono
    contrast: float = 1.25
    gamma: float = 0.9
    saturation: float = 1.35
    edges: bool = True
    edge_threshold: float = 0.45  # lower = more edge strokes
    glow: float = 0.45            # 0 = off
    background: tuple = field(default=(0, 0, 0))  # BGR

    def with_cell(self, w: int) -> "Settings":
        w = int(np.clip(w, 4, 40))
        return Settings(**{**self.__dict__, "cell_w": w, "cell_h": round(w * 1.75)})


class Atlas:
    """Every character pre-drawn once as a small grayscale mask."""

    def __init__(self, cell_w: int, cell_h: int):
        self.cell_w, self.cell_h = cell_w, cell_h
        size = max(6, int(min(cell_h * 0.92, cell_w / 0.602)))
        font = ImageFont.truetype(FONT_PATH, size)

        def draw(ch: str) -> np.ndarray:
            img = Image.new("L", (cell_w, cell_h), 0)
            ImageDraw.Draw(img).text((cell_w / 2, cell_h / 2), ch, fill=255, font=font, anchor="mm")
            return np.asarray(img, dtype=np.float32) / 255

        cands = [(c, draw(c)) for c in dict.fromkeys(RAMP_CANDIDATES)]
        cands.sort(key=lambda cm: cm[1].mean())
        self.ramp = "".join(c for c, _ in cands)
        ink = np.array([m.mean() for _, m in cands])
        ink = (ink - ink[0]) / max(ink[-1] - ink[0], 1e-6)  # 0 = blank, 1 = densest
        self.chars = self.ramp + EDGE_CHARS
        self.masks = np.stack([m for _, m in cands] + [draw(c) for c in EDGE_CHARS])
        # brightness (0..255) -> ramp index with the closest ink coverage
        levels = np.linspace(0, 1, 256)
        self.lut = np.abs(levels[:, None] - ink[None, :]).argmin(1).astype(np.int32)
        self.edge_base = len(self.ramp)


def fit_cover(frame: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Scale and centre-crop so the frame fills exactly (w, h), like a wallpaper."""
    w, h = size
    fh, fw = frame.shape[:2]
    k = max(w / fw, h / fh)
    resized = cv2.resize(frame, (max(w, round(fw * k)), max(h, round(fh * k))), interpolation=cv2.INTER_AREA)
    y, x = (resized.shape[0] - h) // 2, (resized.shape[1] - w) // 2
    return resized[y:y + h, x:x + w]


def _edge_index(gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    # Gradient points from dark to bright; the edge runs at right angles to it.
    # Screen y points down, so a gradient at +45deg means an edge shaped like "/".
    a = np.degrees(np.arctan2(gy, gx)) % 180
    idx = np.zeros(a.shape, np.int32)              # '|'  gradient ~horizontal
    idx[(a >= 22.5) & (a < 67.5)] = 1              # '/'
    idx[(a >= 67.5) & (a < 112.5)] = 2             # '-'
    idx[(a >= 112.5) & (a < 157.5)] = 3            # '\'
    idx[(idx == 2) & (gy < 0)] = 4                 # '_'  bright above, dark below
    return idx


class AsciiRenderer:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self._atlas: Atlas | None = None

    @property
    def atlas(self) -> Atlas:
        s = self.settings
        if self._atlas is None or (self._atlas.cell_w, self._atlas.cell_h) != (s.cell_w, s.cell_h):
            self._atlas = Atlas(s.cell_w, s.cell_h)
        return self._atlas

    # ---- steps 1-4: work out which character goes in every cell -------------
    def analyse(self, frame: np.ndarray):
        s, at = self.settings, self.atlas
        h, w = frame.shape[:2]
        cols, rows = max(1, w // s.cell_w), max(1, h // s.cell_h)
        small = cv2.resize(frame, (cols, rows), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        lum = small @ np.float32([0.114, 0.587, 0.299])          # BGR luminance
        lum = np.clip((lum - 0.5) * s.contrast + 0.5, 0, 1) ** s.gamma
        idx = at.lut[(lum * 255).astype(np.uint8)]
        if s.edges:
            gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
            gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)
            strong = (np.hypot(gx, gy) > s.edge_threshold * 2) & (lum > 0.12)
            idx = np.where(strong, at.edge_base + _edge_index(gx, gy), idx)
        return small, lum, idx

    def _colours(self, small: np.ndarray, lum: np.ndarray) -> np.ndarray:
        s = self.settings
        l3 = lum[..., None]
        if s.style == "matrix":
            base = np.float32([0.35, 1.0, 0.25])                  # BGR green
            return (0.25 + 0.75 * l3) * base + (l3 ** 4) * np.float32([0.55, 0.0, 0.6])
        if s.style == "mono":
            return np.repeat(0.35 + 0.65 * l3, 3, axis=2)
        grey = small.mean(2, keepdims=True)
        col = np.clip(grey + (small - grey) * s.saturation, 0, 1)
        peak = np.maximum(col.max(2, keepdims=True), 1e-3)
        return col / peak * (0.3 + 0.7 * l3)                      # vivid hue, brightness from lum

    # ---- steps 5-6: draw ------------------------------------------------------
    def render(self, frame: np.ndarray, size: tuple[int, int] | None = None) -> np.ndarray:
        """frame: BGR uint8. size: optional (w, h) output, filled edge to edge.
        Returns a BGR uint8 image the same size as the (fitted) input."""
        if size is not None:
            frame = fit_cover(frame, size)
        s, at = self.settings, self.atlas
        h, w = frame.shape[:2]
        small, lum, idx = self.analyse(frame)
        rows, cols = idx.shape
        mask = at.masks[idx].transpose(0, 2, 1, 3).reshape(rows * s.cell_h, cols * s.cell_w)
        col = cv2.resize(self._colours(small, lum), (cols * s.cell_w, rows * s.cell_h),
                         interpolation=cv2.INTER_NEAREST)
        art = mask[..., None] * col
        if s.glow > 0:
            k = 4
            g = cv2.resize(art, (max(1, art.shape[1] // k), max(1, art.shape[0] // k)), interpolation=cv2.INTER_AREA)
            g = cv2.GaussianBlur(g, (0, 0), 3)
            art = art + cv2.resize(g, (art.shape[1], art.shape[0]), interpolation=cv2.INTER_LINEAR) * s.glow
        out = np.empty((h, w, 3), np.uint8)
        out[:] = s.background
        y, x = (h - art.shape[0]) // 2, (w - art.shape[1]) // 2
        bg = np.float32(s.background) / 255
        out[y:y + art.shape[0], x:x + art.shape[1]] = (np.clip(art + bg, 0, 1) * 255).astype(np.uint8)
        return out

    def to_text(self, frame: np.ndarray) -> str:
        chars = np.array(list(self.atlas.chars))
        _, _, idx = self.analyse(frame)
        return "\n".join("".join(row).rstrip() for row in chars[idx])
