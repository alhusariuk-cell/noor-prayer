# Noor Prayer نور الصلاة

An [Even Realities G2](https://www.evenrealities.com/) smart glasses plugin that displays Islamic prayer times, a countdown to the next prayer, and a Hijri calendar directly on the glasses display.

## How It Works

All content is rendered as greyscale images on the phone using an HTML5 Canvas, then transmitted to the G2 as four quadrant image tiles. The glasses display a 400×200 px area split into a 2×2 grid of 200×100 px containers.

```
Phone (companion app)                G2 Glasses
───────────────────────────────────  ──────────────────────────────
Enter city name in companion app  →
Fetch prayer times from Aladhan   →
Fetch Hijri date from Aladhan     →
Render screen onto 400×200 canvas →
Slice into 4 quadrant tiles       →
Send tiles via BLE (SDK)          →  Display prayer screen
```

## Screens

The plugin cycles through three screens. **Double-tap** the G2 to advance to the next screen.

### Screen 1 — Prayer Times
- City name + current local time (top)
- Hijri and Gregorian date
- All 6 prayer times (Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha)
- Next prayer highlighted in gold with a ▶ indicator

### Screen 2 — Countdown
- Large countdown timer to the next prayer (HH:MM format)
- Next prayer name
- City and date

### Screen 3 — Hijri Calendar
- Full month calendar grid in the Hijri calendar
- Current day highlighted
- Month name and year

## Features

- **Any city worldwide** — enter any city name in the companion app; uses the Aladhan API for accurate times
- **London mode** — dedicated London Prayer Times API for higher accuracy in the UK
- **Hijri calendar** — full month grid with accurate Gregorian-to-Hijri conversion via Aladhan
- **Auto-refresh** — prayer times refresh automatically at midnight
- **Live countdown** — countdown screen updates every minute

## Data Sources

| Data | API |
|---|---|
| Prayer times (worldwide) | [Aladhan API](https://aladhan.com/prayer-times-api) |
| Prayer times (London) | [London Prayer Times API](https://www.londonprayertimes.com/api/) |
| Hijri date & calendar | [Aladhan Hijri Calendar API](https://aladhan.com/islamic-calendar-api) |

## Display Layout

```
┌─────────────────────────────────────────────────────────────┐
│  quad_tl (200×100)          │  quad_tr (200×100)            │
│                             │                               │
│  City · Prayer Times   time │                               │
│  Hijri date    Greg date    │                               │
│  ─────────────────────────  │                               │
│  Fajr              05:12    │                               │
│  Sunrise           06:43    │                               │
│  ▶ Dhuhr           12:30 ▶  │                               │
│  Asr               15:45    │                               │
├─────────────────────────────┼───────────────────────────────┤
│  quad_bl (200×100)          │  quad_br (200×100)            │
│                             │                               │
│  Maghrib           18:22    │                               │
│  Isha              19:50    │                               │
│  ─────────────────────────  │                               │
│  double-tap: next screen    │                               │
└─────────────────────────────┴───────────────────────────────┘
```

## Tech Stack

- TypeScript + Vite
- Even Realities G2 SDK (`@evenrealities/even_hub_sdk`)
- HTML5 Canvas for rendering
- Aladhan API + London Prayer Times API

## Getting Started

```bash
npm install
npm run build
npx evenhub pack app.json dist -o noor-prayer.ehpk
```

Sideload `noor-prayer.ehpk` via the Even Realities companion app, then enter your city name in the companion UI.

## Project Structure

```
src/
  main.ts       # G2 plugin — rendering, screen cycling, prayer data
index.html      # Companion UI — city input, status display
app.json        # Even Hub manifest
```

---

## Contributing

Contributions are welcome and appreciated. This project is part of a broader effort to make Quranic tools accessible on wearable devices — any improvement, however small, is meaningful.

### How to contribute

1. **Fork** the repository on GitHub
2. **Create a branch** for your feature or fix: `git checkout -b feature/your-feature-name`
3. **Make your changes** and commit with a clear message
4. **Push** to your fork and open a **Pull Request**

### Ideas for contributions

- Bug fixes and stability improvements
- Additional prayer calculation methods (Hanafi, ISNA, MWL, etc.)
- Qibla direction display on the G2
- Adhan notification support
- Support for GPS-based automatic location detection
- Improved Hijri calendar accuracy
- Documentation and translations

### Guidelines

- Keep changes focused — one feature or fix per pull request
- Test on a physical G2 device if possible, or describe your testing approach
- Respect the existing code style (TypeScript, no external runtime dependencies)
- All contributions must be compatible with the **GNU General Public License v3**

### Reporting issues

Please open a [GitHub Issue](../../issues) with a clear description of the problem, steps to reproduce, and your G2 firmware version and Even Hub app version.

---

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

Any derivative work must also be distributed under GPL v3 and must make its source code available.
