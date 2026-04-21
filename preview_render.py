"""
preview_render.py – Offline preview of what the G2 glasses will display.

Simulates the 576 × 288 G2 display with the v2 layout:
  - 3 lines per screen at 22 px font (larger, more readable)
  - 3 image containers side-by-side for the main text strip
  - 1 info container below

Requires:
    pip install pillow requests
    apt-get install fonts-hosny-amiri
"""

import math, os
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

# ─── Config ───────────────────────────────────────────────────────────────────

DISPLAY_W   = 576
DISPLAY_H   = 288
HEADER_H    = 24
STRIP_Y     = HEADER_H + 2
TILE_W      = 192
TILE_H      = 96
LINES_PER_S = 3      # v2: 3 lines per screen (was 5)
TEXT_FS     = 22     # v2: larger font (was 18)
HEADER_FS   = 18     # v2: larger surah/basmala font (was 15)

MUSHAF_BASE = (
    "https://raw.githubusercontent.com/zonetecde/mushaf-layout"
    "/refs/heads/main/mushaf/page-{:03d}.json"
)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/fonts-hosny-amiri/Amiri-Regular.ttf",
    "/usr/share/fonts/truetype/amiri/Amiri-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoNaskhArabic-Regular.otf",
]

OUT_DIR = Path(__file__).parent / "preview"
OUT_DIR.mkdir(exist_ok=True)

# ─── Font loading ─────────────────────────────────────────────────────────────

def load_font(size: int):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    print("WARNING: No Arabic font found – using default PIL font")
    return ImageFont.load_default()


text_font   = load_font(TEXT_FS)
header_font = load_font(HEADER_FS)
small_font  = load_font(12)

# ─── Data ─────────────────────────────


def fetch_page(page_num: int) -> dict:
    url = MUSHAF_BASE.format(page_num)
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json()

# ─── Rendering ────────────────────────────────────────────────────────────────

def render_screen(lines: list, screen_idx: int, total_screens: int, page_num: int) -> Image.Image:
    """Render a full 576 × 288 display frame for one screen (v2 layout)."""
    img = Image.new("L", (DISPLAY_W, DISPLAY_H), color=0)
    draw = ImageDraw.Draw(img)

    # ── Header ────────────────────────────────────────────────────────────────
    surah_name = next((l.get("text", "") for l in lines if l.get("type") == "surah-header"), "")
    header_text = f"{surah_name}  p.{page_num}/604  [{screen_idx+1}/{total_screens}]"
    draw.text((DISPLAY_W // 2, HEADER_H // 2), header_text,
              font=small_font, fill=200, anchor="mm")
    draw.line([(0, HEADER_H), (DISPLAY_W, HEADER_H)], fill=60, width=1)

    # ── Main strip: 3 lines in TILE_H (96 px) ────────────────────────────────
    count = len([l for l in lines if l.get("text", "").strip() or l.get("type") != "text"])
    line_h = TILE_H // max(len(lines), 1)

    for i, line in enumerate(lines):
        y = STRIP_Y + i * line_h + line_h // 2
        ltype = line.get("type", "text")
        text  = line.get("text", "")

        if ltype == "surah-header":
            draw.line([(40, STRIP_Y + i * line_h + 2), (DISPLAY_W - 40, STRIP_Y + i * line_h + 2)],
                      fill=70, width=1)
            draw.text((DISPLAY_W // 2, y), text, font=header_font, fill=220, anchor="mm")
        elif ltype == "basmala":
            draw.text((DISPLAY_W // 2, y),
                      "بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ",
                      font=header_font, fill=255, anchor="mm")
        else:
            if text.strip():
                draw.text((DISPLAY_W // 2, y), text, font=text_font, fill=255, anchor="mm")

    # ── Tile split guides (shows the 3 image container boundaries) ────────────
    for x in [TILE_W, TILE_W * 2]:
        draw.line([(x, STRIP_Y), (x, STRIP_Y + TILE_H)], fill=35, width=1)

    # ── Info tile area (col_d) ────────────────────────────────────────────────
    info_y = STRIP_Y + TILE_H + 4
    draw.text((6, info_y + 6), f"p.{page_num}  {screen_idx+1}/{total_screens}",
              font=small_font, fill=100)
    bar_y = info_y + 28
    bar_max_w = TILE_W - 12
    bar_fill_w = round(bar_max_w * (screen_idx + 1) / total_screens)
    draw.rectangle([6, bar_y, 6 + bar_max_w, bar_y + 8], fill=50)
    draw.rectangle([6, bar_y, 6 + bar_fill_w, bar_y + 8], fill=170)

    # ── Green tint to simulate the G2 display ─────────────────────────────────
    green = Image.new("RGB", img.size, (0, 0, 0))
    r, g, b = green.split()
    g = img
    return Image.merge("RGB", (r, g, b))


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    test_pages = [1, 2, 50, 100, 300]

    for page_num in test_pages:
        print(f"Fetching page {page_num}…", end=" ", flush=True)
        try:
            data = fetch_page(page_num)
        except Exception as e:
            print(f"FAILED: {e}")
            continue

        all_lines = data["lines"]
        total_screens = math.ceil(len(all_lines) / LINES_PER_S)
        print(f"{len(all_lines)} lines → {total_screens} screen(s)")

        for s in range(total_screens):
            start = s * LINES_PER_S
            chunk = all_lines[start : start + LINES_PER_S]
            while len(chunk) < LINES_PER_S:
                chunk.append({"line": -1, "type": "text", "text": ""})

            frame = render_screen(chunk, s, total_screens, page_num)
            out_path = OUT_DIR / f"page{page_num:03d}_screen{s+1}.png"
            frame.save(out_path)
            print(f"  → {out_path.name}")

    print(f"\nAll previews saved to: {OUT_DIR}")


if __name__ == "__main__":
    main()
