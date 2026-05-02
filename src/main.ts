import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// ─── G2 Display constants ─────────────────────────────────────────────────────
//
// G2 physical display: 576 × 288 px
// Plugin uses a centred 400 × 200 canvas split into 4 quadrant tiles (2×2 grid)
// Each quadrant: 200 × 100 px
// Offsets (centred): xPos = (576 - 400) / 2 = 88,  yPos = (288 - 200) / 2 = 44
//
const DISPLAY_W  = 576
const DISPLAY_H  = 288
const IMG_W      = 400   // full canvas width  (2 × QUAD_W)
const IMG_H      = 200   // full canvas height (2 × QUAD_H)
const QUAD_W     = 200
const QUAD_H     = 100
const IMG_OFFSET_X = (DISPLAY_W - IMG_W) / 2   // 88
const IMG_OFFSET_Y = (DISPLAY_H - IMG_H) / 2   // 44

// Fonts — sized for maximum readability on the 400×200 G2 canvas
const FONT_TITLE  = 'bold 16px sans-serif'   // screen title / city
const FONT_HEADER = '11px sans-serif'         // secondary header info
const FONT_BODY   = '15px sans-serif'         // prayer name + time rows
const FONT_BOLD   = 'bold 16px sans-serif'    // next-prayer highlight
const FONT_LARGE  = 'bold 38px sans-serif'    // big countdown number
const FONT_MED    = 'bold 16px sans-serif'    // "until Isha" label
const FONT_HINT   = '11px sans-serif'         // footer hint
const FONT_CAL_DAY   = '12px sans-serif'      // calendar day numbers
const FONT_CAL_TODAY = 'bold 13px sans-serif' // today highlight
const FONT_CAL_HDR   = '11px sans-serif'      // Su Mo Tu … headers

// Screen cycle order
const SCREENS = ['main', 'countdown', 'calendar'] as const
type Screen = typeof SCREENS[number]
// ─── Render queue — prevents BLE bandwidth saturation ────────────────────────
// Rapid events (swipes) are coalesced: only the latest render is sent.
let _renderRunning = false
let _renderPending: (() => Promise<void>) | null = null

async function drainRenderQueue(): Promise<void> {
  while (_renderPending) {
    const fn = _renderPending
    _renderPending = null
    try { await fn() } catch (e) { console.error('[Prayer] render error:', e) }
  }
  _renderRunning = false
}

function enqueueRender(fn: () => Promise<void>): void {
  _renderPending = fn  // overwrite: only latest render matters
  if (!_renderRunning) {
    _renderRunning = true
    drainRenderQueue()
  }
}

// ─── Event resolver ───────────────────────────────────────────────────────────
function resolveEventType(event: any): number | null {
  const candidates = [
    event?.jsonData?.eventType,
    event?.textEvent?.eventType,
    event?.sysEvent?.eventType,
    event?.eventType,
    event?.data?.eventType,
  ]
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue
    const resolved = OsEventTypeList.fromJson(raw)
    if (resolved !== null && resolved !== undefined) return resolved as number
    if (typeof raw === 'number') return raw
  }
  // G2 single tap sends sysEvent/jsonData with eventSource but NO eventType.
  // Treat this as CLICK_EVENT (0).
  if (
    (event?.sysEvent?.eventSource !== undefined || event?.jsonData?.eventSource !== undefined) &&
    event?.sysEvent?.eventType === undefined &&
    event?.jsonData?.eventType === undefined
  ) {
    return 0
  }
  return null
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Prayer {
  name: string
  time: string
}

interface HijriMonthData {
  day: number
  month: number
  monthName: string
  year: number
  daysInMonth: number
  firstWeekday: number
}

interface PrayerData {
  prayers: Prayer[]
  cityLabel: string
  hijriDate: string
  gregDate: string
  timezone: string
  hijriMonth: HijriMonthData
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LONDON_API_KEY = 'e8137a30-6de0-4b86-a1b5-6e0a7a8d582b'

const toMins = (s: string): number => {
  if (!s) return 9999
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

const minsToCountdown = (mins: number): string => {
  if (mins <= 0) return 'Now!'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h${String(m).padStart(2, '0')}`
}

const getCityTime = (timezone: string): Date => {
  const now = new Date()
  return new Date(now.toLocaleString('en-US', { timeZone: timezone }))
}

const fetchWithTimeout = async (url: string, ms = 12000): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

type CanvasPair = [HTMLCanvasElement, CanvasRenderingContext2D]

const makeCanvas = (w: number, h: number): CanvasPair => {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#fff'
  return [c, ctx]
}

/**
 * Encode canvas to 8-bit palette PNG → number[].
 *
 * Our canvases use only a handful of flat colours (black bg, white/grey/
 * yellow/green text). Switching from 32-bit RGBA to 8-bit indexed PNG
 * reduces each quadrant from ~20 KB to ~4 KB, cutting BLE payload ~5×.
 *
 * iOS-safe: no spread operators on large arrays (avoids WKWebView stack overflow).
 * Returns number[] (List<int>) for the Dart bridge — same contract as before.
 */
const canvasToPngBytes = (canvas: HTMLCanvasElement): number[] => {
  const w = canvas.width, h = canvas.height
  const ctx2 = canvas.getContext('2d')!
  const imgData = ctx2.getImageData(0, 0, w, h).data  // Uint8ClampedArray RGBA

  // ── Build palette (max 256 unique RGBA colours) ──────────────────────────
  const colourMap = new Map<number, number>()
  const palette: number[] = []  // flat [R,G,B,A, ...]

  const packRGBA = (r: number, g: number, b: number, a: number) =>
    ((r << 24) | (g << 16) | (b << 8) | a) >>> 0

  for (let i = 0; i < imgData.length; i += 4) {
    const key = packRGBA(imgData[i], imgData[i+1], imgData[i+2], imgData[i+3])
    if (!colourMap.has(key)) {
      if (colourMap.size >= 256) break
      colourMap.set(key, colourMap.size)
      palette.push(imgData[i], imgData[i+1], imgData[i+2], imgData[i+3])
    }
  }
  const palSize = colourMap.size

  // ── Build indexed pixel array ─────────────────────────────────────────────
  const rowLen = 1 + w
  const raw = new Uint8Array(rowLen * h)
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0  // filter type None
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * 4
      const key = packRGBA(imgData[pi], imgData[pi+1], imgData[pi+2], imgData[pi+3])
      raw[y * rowLen + 1 + x] = colourMap.get(key) ?? 0
    }
  }

  // ── zlib (uncompressed deflate blocks) ───────────────────────────────────
  const zlibData = deflateUncompressed(raw)

  // ── PNG helpers ───────────────────────────────────────────────────────────
  const crc32Table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[i] = c
    }
    return t
  })()

  const crc32 = (buf: Uint8Array): number => {
    let c = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  const u32be = (n: number, out: number[], off: number) => {
    out[off]   = (n >>> 24) & 0xFF
    out[off+1] = (n >>> 16) & 0xFF
    out[off+2] = (n >>> 8)  & 0xFF
    out[off+3] =  n         & 0xFF
  }

  // Build a PNG chunk: length(4) + type(4) + data(n) + crc32(type+data)(4)
  const chunk = (type: string, data: number[]): number[] => {
    const dlen = data.length
    // CRC covers type + data
    const crcBuf = new Uint8Array(4 + dlen)
    crcBuf[0] = type.charCodeAt(0); crcBuf[1] = type.charCodeAt(1)
    crcBuf[2] = type.charCodeAt(2); crcBuf[3] = type.charCodeAt(3)
    for (let i = 0; i < dlen; i++) crcBuf[4 + i] = data[i]
    const c = crc32(crcBuf)
    // Assemble: length(4) + type(4) + data(n) + crc(4)
    const result: number[] = new Array(4 + 4 + dlen + 4)
    u32be(dlen, result, 0)
    result[4] = type.charCodeAt(0); result[5] = type.charCodeAt(1)
    result[6] = type.charCodeAt(2); result[7] = type.charCodeAt(3)
    for (let i = 0; i < dlen; i++) result[8 + i] = data[i]
    u32be(c, result, 8 + dlen)
    return result
  }

  // ── IHDR ─────────────────────────────────────────────────────────────────
  const ihdrData: number[] = new Array(13)
  u32be(w, ihdrData, 0); u32be(h, ihdrData, 4)
  ihdrData[8] = 8; ihdrData[9] = 3; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0
  const ihdr = chunk('IHDR', ihdrData)

  // ── PLTE ─────────────────────────────────────────────────────────────────
  const plteData: number[] = new Array(palSize * 3)
  for (let i = 0; i < palSize; i++) {
    plteData[i*3]   = palette[i*4]
    plteData[i*3+1] = palette[i*4+1]
    plteData[i*3+2] = palette[i*4+2]
  }
  const plte = chunk('PLTE', plteData)

  // ── tRNS ─────────────────────────────────────────────────────────────────
  const trnsData: number[] = new Array(palSize)
  for (let i = 0; i < palSize; i++) trnsData[i] = palette[i*4+3]
  const trns = chunk('tRNS', trnsData)

  // ── IDAT ─────────────────────────────────────────────────────────────────
  const idatArr: number[] = new Array(zlibData.length)
  for (let i = 0; i < zlibData.length; i++) idatArr[i] = zlibData[i]
  const idat = chunk('IDAT', idatArr)

  // ── IEND ─────────────────────────────────────────────────────────────────
  const iend = chunk('IEND', [])

  // ── Assemble PNG (no spread on large arrays) ──────────────────────────────
  const parts = [
    [137, 80, 78, 71, 13, 10, 26, 10],  // PNG signature
    ihdr, plte, trns, idat, iend,
  ]
  let totalLen = 0
  for (let p = 0; p < parts.length; p++) totalLen += parts[p].length
  const result: number[] = new Array(totalLen)
  let pos2 = 0
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]
    for (let i = 0; i < part.length; i++) result[pos2++] = part[i]
  }
  return result
}

/** Build a zlib stream using uncompressed deflate blocks (no compression).
 *  iOS-safe: no spread operators on large Uint8Array. */
function deflateUncompressed(data: Uint8Array): Uint8Array {
  const BLOCK = 65535
  // Calculate total output size
  const numBlocks = Math.ceil(data.length / BLOCK) || 1
  const outLen = 2 + numBlocks * 5 + data.length + 4  // header + blocks + adler
  const out = new Uint8Array(outLen)
  out[0] = 0x78; out[1] = 0x01  // zlib header
  let wp = 2, rp = 0
  while (rp < data.length || wp === 2) {
    const end  = Math.min(rp + BLOCK, data.length)
    const len  = end - rp
    const last = end >= data.length ? 1 : 0
    out[wp++] = last
    out[wp++] = len & 0xFF
    out[wp++] = (len >> 8) & 0xFF
    out[wp++] = (~len) & 0xFF
    out[wp++] = ((~len) >> 8) & 0xFF
    for (let i = rp; i < end; i++) out[wp++] = data[i]
    rp = end
    if (rp >= data.length) break
  }
  // Adler-32
  let s1 = 1, s2 = 0
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521
    s2 = (s2 + s1) % 65521
  }
  const adler = (s2 << 16) | s1
  out[wp++] = (adler >>> 24) & 0xFF
  out[wp++] = (adler >>> 16) & 0xFF
  out[wp++] = (adler >>> 8)  & 0xFF
  out[wp]   =  adler         & 0xFF
  return out
}

/** Slice the 400×200 canvas into 4 quadrant PNGs (TL, TR, BL, BR) */
const sliceQuadrants = (canvas: HTMLCanvasElement): [number[], number[], number[], number[]] => {
  const quad = (sx: number, sy: number): number[] => {
    const [t, tc] = makeCanvas(QUAD_W, QUAD_H)
    tc.drawImage(canvas, sx, sy, QUAD_W, QUAD_H, 0, 0, QUAD_W, QUAD_H)
    return canvasToPngBytes(t)
  }
  return [
    quad(0,      0),       // TL
    quad(QUAD_W, 0),       // TR
    quad(0,      QUAD_H),  // BL
    quad(QUAD_W, QUAD_H),  // BR
  ]
}

const drawSeparator = (ctx: CanvasRenderingContext2D, y: number, x0 = 4, x1 = IMG_W - 4) => {
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke()
}

// ─── API ──────────────────────────────────────────────────────────────────────

const getPrayerData = async (city: string, method = -1): Promise<PrayerData> => {
  const today = new Date()
  const dd = String(today.getDate()).padStart(2, '0')
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const yyyy = today.getFullYear()

  let prayers: Prayer[], cityLabel: string, timezone: string, hijriDate: string, gregDate: string
  let hijriDay: number, hijriMonth: number, hijriYear: number, hijriMonthName: string

  if (city === 'london') {
    const dateStr = `${yyyy}-${mm}-${dd}`
    const res = await fetchWithTimeout(
      `https://www.londonprayertimes.com/api/times/?format=json&key=${LONDON_API_KEY}&date=${dateStr}&24hours=true`
    )
    const t = await res.json()
    cityLabel = 'London'
    timezone  = 'Europe/London'
    prayers = [
      { name: 'Fajr',    time: t.fajr },
      { name: 'Sunrise', time: t.sunrise },
      { name: 'Dhuhr',   time: t.dhuhr },
      { name: 'Asr',     time: t.asr },
      { name: 'Maghrib', time: t.magrib },
      { name: 'Isha',    time: t.isha },
    ]
    const hRes  = await fetchWithTimeout(
      `https://api.aladhan.com/v1/timingsByCity?city=London&country=United+Kingdom&method=1`
    )
    const hData = await hRes.json()
    const hijri = hData.data.date.hijri
    const greg  = hData.data.date.gregorian
    hijriDay   = parseInt(hijri.day)
    hijriMonth = parseInt(hijri.month.number)
    hijriYear  = parseInt(hijri.year)
    hijriMonthName = hijri.month.en
    hijriDate  = `${hijri.day} ${hijriMonthName} ${hijri.year} AH`
    gregDate   = `${greg.weekday.en.slice(0,3)} ${greg.day} ${greg.month.en.slice(0,3)} ${greg.year}`
  } else {
    const cityName = city.charAt(0).toUpperCase() + city.slice(1)
    let res  = await fetchWithTimeout(
      `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(cityName)}&method=${method >= 0 ? method : 3}`
    )
    let data = await res.json()

    if (!data.data?.timings) {
      res  = await fetchWithTimeout(
        `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(cityName)}&country=${encodeURIComponent(cityName)}&method=${method >= 0 ? method : 3}`
      )
      data = await res.json()
    }

    if (!data.data?.timings) throw new Error(`City not found: ${cityName}`)

    timezone  = data.data.meta?.timezone || 'UTC'
    const t   = data.data.timings
    const hijri = data.data.date.hijri
    const greg  = data.data.date.gregorian
    cityLabel  = cityName
    hijriDay   = parseInt(hijri.day)
    hijriMonth = parseInt(hijri.month.number)
    hijriYear  = parseInt(hijri.year)
    hijriMonthName = hijri.month.en
    hijriDate  = `${hijri.day} ${hijriMonthName} ${hijri.year} AH`
    gregDate   = `${greg.weekday.en.slice(0,3)} ${greg.day} ${greg.month.en.slice(0,3)} ${greg.year}`
    prayers = [
      { name: 'Fajr',    time: t.Fajr },
      { name: 'Sunrise', time: t.Sunrise },
      { name: 'Dhuhr',   time: t.Dhuhr },
      { name: 'Asr',     time: t.Asr },
      { name: 'Maghrib', time: t.Maghrib },
      { name: 'Isha',    time: t.Isha },
    ]
  }

  // Fetch Hijri month calendar for accurate grid
  let daysInMonth = 29
  let firstWeekday = 0
  try {
    const calRes  = await fetchWithTimeout(
      `https://api.aladhan.com/v1/hToGCalendar/${hijriMonth}/${hijriYear}`
    )
    const calData = await calRes.json()
    if (calData.data && Array.isArray(calData.data)) {
      daysInMonth = calData.data.length
      const firstGreg = calData.data[0]?.gregorian?.date
      if (firstGreg) {
        const parts = firstGreg.split('-')
        const d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]))
        firstWeekday = d.getDay()
      }
    }
  } catch (_) {
    firstWeekday = (today.getDay() - ((hijriDay - 1) % 7) + 7) % 7
  }

  return {
    prayers, cityLabel, hijriDate, gregDate, timezone,
    hijriMonth: {
      day: hijriDay, month: hijriMonth, monthName: hijriMonthName,
      year: hijriYear, daysInMonth, firstWeekday,
    },
  }
}

// ─── Screen renderers ─────────────────────────────────────────────────────────
//
// All screens render onto a 400×200 canvas which is then sliced into 4 quadrants.
//
// Layout zones on the 400×200 canvas:
//   Header:  y 0–22   (title + hijri/greg date + time)
//   Sep:     y 23
//   Body:    y 25–178
//   Sep:     y 179
//   Footer:  y 181–199 (hint text)
//

const renderMainScreen = async (data: PrayerData): Promise<[number[], number[], number[], number[]]> => {
  const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
  const cityTime = getCityTime(data.timezone)
  const nowMins  = cityTime.getHours() * 60 + cityTime.getMinutes()
  const timeNow  = `${String(cityTime.getHours()).padStart(2,'0')}:${String(cityTime.getMinutes()).padStart(2,'0')}`

  const prayerOnly = data.prayers.filter(p => p.name !== 'Sunrise')
  let nextIdx = prayerOnly.findIndex(p => toMins(p.time) > nowMins)
  if (nextIdx === -1) nextIdx = 0
  const nextName = prayerOnly[nextIdx].name

  // ── Header ──────────────────────────────────────────────────────────────────
  // Row 1: title + time (right)
  ctx.font = FONT_TITLE; ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(`${data.cityLabel}  ·  Prayer Times`, 6, 4)

  ctx.font = FONT_TITLE; ctx.fillStyle = '#ffcc00'
  ctx.textAlign = 'right'
  ctx.fillText(timeNow, IMG_W - 6, 4)

  // Row 2: hijri + gregorian date
  ctx.font = FONT_HEADER; ctx.fillStyle = '#666'
  ctx.textAlign = 'left'
  ctx.fillText(data.hijriDate, 6, 22)
  ctx.textAlign = 'right'
  ctx.fillText(data.gregDate, IMG_W - 6, 22)

  drawSeparator(ctx, 36)

  // ── Prayer rows ─────────────────────────────────────────────────────────────
  // 6 prayers × 25px row height = 150px, starting at y=40  → ends at y=190
  const ROW_H  = 25
  const ROW_Y0 = 40
  const TIME_X = IMG_W - 8

  data.prayers.forEach((p, i) => {
    const y         = ROW_Y0 + i * ROW_H
    const isNext    = p.name === nextName
    const isSunrise = p.name === 'Sunrise'

    if (isNext) {
      // Full-row background highlight
      ctx.fillStyle = '#1e1600'
      ctx.fillRect(2, y - 1, IMG_W - 4, ROW_H)
      // Arrow badge box on the far right
      const BADGE_W = 18
      const BADGE_X = IMG_W - 2 - BADGE_W
      ctx.fillStyle = '#ffcc00'
      ctx.beginPath()
      ctx.roundRect(BADGE_X, y + 2, BADGE_W, ROW_H - 4, 3)
      ctx.fill()
      // Arrow glyph inside badge (black on yellow)
      ctx.fillStyle = '#000'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('▶', BADGE_X + BADGE_W / 2, y + ROW_H / 2)
    }

    // Prayer name
    ctx.font = isNext ? FONT_BOLD : (isSunrise ? FONT_HEADER : FONT_BODY)
    ctx.fillStyle = isNext ? '#ffcc00' : (isSunrise ? '#444' : '#ccc')
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(p.name, 10, y + ROW_H / 2)

    // Time — shift left to avoid the badge when isNext
    const timeX = isNext ? IMG_W - 2 - 18 - 6 : TIME_X
    ctx.font = isNext ? FONT_BOLD : (isSunrise ? FONT_HEADER : FONT_BODY)
    ctx.fillStyle = isNext ? '#ffcc00' : (isSunrise ? '#444' : '#888')
    ctx.textAlign = 'right'
    ctx.fillText(p.time, timeX, y + ROW_H / 2)
  })

  // ── Footer ───────────────────────────────────────────────────────────────────
  drawSeparator(ctx, IMG_H - 14)
  ctx.font = FONT_HINT; ctx.fillStyle = '#444'
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText('swipe: scroll  |  tap: next  |  2x: exit', IMG_W / 2, IMG_H - 2)

  return sliceQuadrants(canvas)
}

const renderCountdownScreen = async (data: PrayerData): Promise<[number[], number[], number[], number[]]> => {
  const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
  const cityTime = getCityTime(data.timezone)
  const nowMins  = cityTime.getHours() * 60 + cityTime.getMinutes()
  const timeNow  = `${String(cityTime.getHours()).padStart(2,'0')}:${String(cityTime.getMinutes()).padStart(2,'0')}`

  const prayerOnly = data.prayers.filter(p => p.name !== 'Sunrise')
  let nextIdx = prayerOnly.findIndex(p => toMins(p.time) > nowMins)
  if (nextIdx === -1) nextIdx = 0
  const next    = prayerOnly[nextIdx]
  const prevIdx = nextIdx === 0 ? prayerOnly.length - 1 : nextIdx - 1
  const prev    = prayerOnly[prevIdx]

  let minsLeft = toMins(next.time) - nowMins
  if (minsLeft < 0) minsLeft += 24 * 60

  let totalGap = toMins(next.time) - toMins(prev.time)
  if (totalGap <= 0) totalGap += 24 * 60
  const elapsed = Math.max(0, totalGap - minsLeft)
  const pct     = Math.round((elapsed / totalGap) * 100)

  // ── Header ───────────────────────────────────────────────────────────────────
  ctx.font = FONT_TITLE; ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(`${data.cityLabel}  ·  Countdown`, 6, 4)

  ctx.font = FONT_TITLE; ctx.fillStyle = '#ffcc00'
  ctx.textAlign = 'right'
  ctx.fillText(timeNow, IMG_W - 6, 4)

  ctx.font = FONT_HEADER; ctx.fillStyle = '#666'
  ctx.textAlign = 'left'
  ctx.fillText(data.hijriDate, 6, 22)
  ctx.textAlign = 'right'
  ctx.fillText(data.gregDate, IMG_W - 6, 22)

  drawSeparator(ctx, 36)

  // ── Prev → Next labels ───────────────────────────────────────────────────────
  ctx.font = FONT_BODY; ctx.fillStyle = '#555'
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(`${prev.name}  ${prev.time}`, 10, 42)

  ctx.font = FONT_BOLD; ctx.fillStyle = '#ffcc00'
  ctx.textAlign = 'right'
  ctx.fillText(`${next.name}  ${next.time}`, IMG_W - 10, 42)

  // ── Progress bar ─────────────────────────────────────────────────────────────
  const BAR_Y = 64
  const BAR_H = 12
  const BAR_W = IMG_W - 20
  const filled = Math.round((pct / 100) * BAR_W)

  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(10, BAR_Y, BAR_W, BAR_H)
  ctx.fillStyle = '#ffcc00'
  ctx.fillRect(10, BAR_Y, filled, BAR_H)
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1
  ctx.strokeRect(10, BAR_Y, BAR_W, BAR_H)

  ctx.font = FONT_HEADER; ctx.fillStyle = '#666'
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(`${pct}% elapsed`, IMG_W / 2, BAR_Y + BAR_H + 4)

  // ── Big countdown ─────────────────────────────────────────────────────────────
  ctx.font = FONT_LARGE; ctx.fillStyle = '#ffcc00'
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(minsToCountdown(minsLeft), IMG_W / 2, 92)

  ctx.font = FONT_MED; ctx.fillStyle = '#aaa'
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(`until ${next.name}`, IMG_W / 2, 138)

  // ── Footer ───────────────────────────────────────────────────────────────────
  drawSeparator(ctx, IMG_H - 14)
  ctx.font = FONT_HINT; ctx.fillStyle = '#444'
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText('swipe: scroll  |  tap: next  |  2x: exit', IMG_W / 2, IMG_H - 2)

  return sliceQuadrants(canvas)
}

const renderCalendarScreen = async (data: PrayerData): Promise<[number[], number[], number[], number[]]> => {
  const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
  const hm = data.hijriMonth

  // ── Header ───────────────────────────────────────────────────────────────────
  ctx.font = FONT_TITLE; ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(`${hm.monthName} ${hm.year} AH`, 6, 4)

  ctx.font = FONT_HEADER; ctx.fillStyle = '#666'
  ctx.textAlign = 'right'
  ctx.fillText(data.gregDate, IMG_W - 6, 22)

  drawSeparator(ctx, 36)

  // ── Calendar grid ─────────────────────────────────────────────────────────────
  // 7 columns × 52px = 364px; centred in 400px → x0 = 18
  const DAYS_HDR = ['Su','Mo','Tu','We','Th','Fr','Sa']
  const CELL_W   = 52
  const GRID_W   = CELL_W * 7          // 364px
  const GRID_X0  = (IMG_W - GRID_W) / 2  // 18
  const GRID_Y0  = 40
  const ROW_H    = 24

  // Day-of-week headers
  ctx.font = FONT_CAL_HDR
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  DAYS_HDR.forEach((d, i) => {
    const x = GRID_X0 + i * CELL_W + CELL_W / 2
    ctx.fillStyle = i === 5 ? '#ffcc00' : '#555'
    ctx.fillText(d, x, GRID_Y0)
  })

  let col = hm.firstWeekday
  let row = 1
  let lastRowUsed = 1

  for (let d = 1; d <= hm.daysInMonth; d++) {
    const x = GRID_X0 + col * CELL_W + CELL_W / 2
    const y = GRID_Y0 + row * ROW_H + 2
    const isToday = d === hm.day

    if (isToday) {
      ctx.fillStyle = '#ffcc00'
      ctx.beginPath()
      ctx.arc(x, y + 6, 10, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.font = isToday ? FONT_CAL_TODAY : FONT_CAL_DAY
    ctx.fillStyle = isToday ? '#000' : (col === 5 ? '#ffcc00' : '#ccc')
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(String(d), x, y)

    lastRowUsed = row
    col++
    if (col === 7) { col = 0; row++ }
  }

  // ── Footer ── drawn below the last calendar row, never overlapping ────────────
  // Last row bottom edge: GRID_Y0 + lastRowUsed * ROW_H + 2 + 14 (font height)
  const lastRowBottom = GRID_Y0 + lastRowUsed * ROW_H + 18
  const sepY = Math.max(lastRowBottom + 3, IMG_H - 16)
  // If the grid is too tall to fit a footer, skip the separator and just show hint
  if (sepY < IMG_H - 2) {
    drawSeparator(ctx, sepY)
    ctx.font = FONT_HINT; ctx.fillStyle = '#444'
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText('swipe: scroll  |  tap: next  |  2x: exit', IMG_W / 2, IMG_H - 2)
  }

  return sliceQuadrants(canvas)
}

const renderLoadingScreen = async (city: string): Promise<[number[], number[], number[], number[]]> => {
  const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
  ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('Noor Prayer', IMG_W / 2, IMG_H / 2 - 16)
  ctx.font = FONT_BODY; ctx.fillStyle = '#888'
  ctx.fillText(`Loading ${city.charAt(0).toUpperCase() + city.slice(1)}...`, IMG_W / 2, IMG_H / 2 + 12)
  return sliceQuadrants(canvas)
}

// ─── State ────────────────────────────────────────────────────────────────────

let bridge: any = null
let currentScreen: Screen = 'main'
let cachedData: PrayerData | null = null
let _savedCity   = 'london'
let _savedMethod = -1

let cachedMainTiles:      [number[], number[], number[], number[]] | null = null
let cachedCountdownTiles: [number[], number[], number[], number[]] | null = null
let cachedCalendarTiles:  [number[], number[], number[], number[]] | null = null

// ─── Container setup ──────────────────────────────────────────────────────────
// G2: 4 image containers in a 2×2 grid centred on the 576×288 display
// TL: (88, 44)   TR: (288, 44)
// BL: (88, 144)  BR: (288, 144)

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const initPage = async () => {
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 5,
    textObject: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: DISPLAY_W, height: DISPLAY_H,
        borderWidth: 0, borderColor: 0, paddingLength: 0,
        containerID: 5, containerName: 'evt', content: '', isEventCapture: 1,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({ xPosition: IMG_OFFSET_X,           yPosition: IMG_OFFSET_Y,           width: QUAD_W, height: QUAD_H, containerID: 1, containerName: 'quad_tl' }),
      new ImageContainerProperty({ xPosition: IMG_OFFSET_X + QUAD_W,  yPosition: IMG_OFFSET_Y,           width: QUAD_W, height: QUAD_H, containerID: 2, containerName: 'quad_tr' }),
      new ImageContainerProperty({ xPosition: IMG_OFFSET_X,           yPosition: IMG_OFFSET_Y + QUAD_H,  width: QUAD_W, height: QUAD_H, containerID: 3, containerName: 'quad_bl' }),
      new ImageContainerProperty({ xPosition: IMG_OFFSET_X + QUAD_W,  yPosition: IMG_OFFSET_Y + QUAD_H,  width: QUAD_W, height: QUAD_H, containerID: 4, containerName: 'quad_br' }),
    ],
  }))
  await delay(500)
}

// ─── Send tiles ───────────────────────────────────────────────────────────────

const sendTiles = async (tiles: [number[], number[], number[], number[]]) => {
  const [tl, tr, bl, br] = tiles
  // Sequential sends for iOS WKWebView BLE stability (parallel BLE calls crash on iOS)
  await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 1, containerName: 'quad_tl', imageData: tl }))
  await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 2, containerName: 'quad_tr', imageData: tr }))
  await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 3, containerName: 'quad_bl', imageData: bl }))
  await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: 'quad_br', imageData: br }))
}

// ─── Main flow ────────────────────────────────────────────────────────────────

const loadAndShow = async (city: string, method = -1) => {
  await sendTiles(await renderLoadingScreen(city))
  try {
    const data = await getPrayerData(city, method)
    cachedData           = data
    currentScreen        = 'main'
    cachedMainTiles      = await renderMainScreen(data)
    // Countdown is rendered on demand (always fresh) — skip at startup
    cachedCountdownTiles = null
    cachedCalendarTiles  = await renderCalendarScreen(data)
    await sendTiles(cachedMainTiles)
  } catch (e: any) {
    const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
    ctx.font = FONT_BODY; ctx.fillStyle = '#f66'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`Error: ${e.message}`, IMG_W / 2, IMG_H / 2)
    await sendTiles(sliceQuadrants(canvas))
  }
}

const scheduleNextMidnight = () => {
  const now      = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 1, 0, 0)
  const msUntil = tomorrow.getTime() - now.getTime()
  setTimeout(async () => {
    try {
      await loadAndShow(_savedCity, _savedMethod)
    } catch (_) {}
    scheduleNextMidnight()
  }, msUntil)
}

// ─── Settings UI (phone) ──────────────────────────────────────────────────────

const setupSettingsUI = () => {
  const cityInput = document.getElementById('cityInput') as HTMLInputElement | null
  if (!cityInput) return

  const setStatus = (msg: string, type: 'success' | 'error' | 'info') => {
    const el = document.getElementById('status')
    if (!el) return
    el.className = `status ${type}`
    el.textContent = msg
  }

  const updateInfo = (data: PrayerData) => {
    const elCity = document.getElementById('currentCity')
    const elSrc  = document.getElementById('source')
    const elTz   = document.getElementById('timezone')
    if (elCity) elCity.textContent = data.cityLabel
    if (elSrc)  elSrc.textContent  = data.cityLabel === 'London' ? 'ICCUK London API' : 'Aladhan API'
    if (elTz)   elTz.textContent   = data.timezone
  }

  bridge.getLocalStorage('prayer_city').then((stored: string) => {
    const city = (stored && stored.length > 0) ? stored : 'london'
    cityInput.value = city.charAt(0).toUpperCase() + city.slice(1)
  }).catch(() => {
    cityInput.value = 'London'
  })

  const setLoading = (loading: boolean) => {
    const btn     = document.getElementById('startBtn')
    const spinner = document.getElementById('spinner')
    const label   = document.getElementById('startLabel')
    if (loading) {
      btn?.classList.add('loading')
      if (spinner) spinner.style.display = 'inline-block'
      if (label)   label.textContent = 'Loading...'
    } else {
      btn?.classList.remove('loading')
      if (spinner) spinner.style.display = 'none'
      if (label)   label.textContent = '☾ Show on Glasses'
    }
  }

  ;(window as any).saveAndStart = async () => {
    const cityInput  = document.getElementById('cityInput')  as HTMLInputElement | null
    const methodSel  = document.getElementById('methodSelect') as HTMLSelectElement | null
    const city   = cityInput?.value.trim().toLowerCase() || ''
    const method = methodSel ? parseInt(methodSel.value) : -1
    if (!city) return
    setLoading(true)
    try {
      const data = await getPrayerData(city, method)
      if (bridge) {
        await bridge.setLocalStorage('prayer_city', city)
        await bridge.setLocalStorage('prayer_method', String(method))
        _savedCity   = city
        _savedMethod = method
        cachedData           = data
        currentScreen        = 'main'
        cachedMainTiles      = await renderMainScreen(data)
        cachedCountdownTiles = null
        cachedCalendarTiles  = await renderCalendarScreen(data)
        await sendTiles(cachedMainTiles)
        // Update active screen button
        const updateBtn = (scr: string) => {
          ;['main','countdown','calendar'].forEach(s => {
            const el = document.getElementById('btn-' + s)
            if (el) el.classList.toggle('active', s === scr)
          })
        }
        updateBtn('main')
      }
      updateInfo(data)
      setStatus(`✓ Showing ${data.cityLabel} on glasses!`, 'success')
    } catch (e: any) {
      setStatus(`Error: ${e.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

;(window as any).noor = {
  version: '1.3.8',
  exit: () => { if (bridge) bridge.shutDownPageContainer(0) },
  getMethod: () => _savedMethod,
  getCity:   () => _savedCity,
  switchScreen: (scr: string) => {
    if (!cachedData) return
    currentScreen = scr as Screen
    enqueueRender(async () => {
      if (!cachedData) return
      if (scr === 'main') {
        if (!cachedMainTiles) cachedMainTiles = await renderMainScreen(cachedData)
        await sendTiles(cachedMainTiles!)
      } else if (scr === 'countdown') {
        cachedCountdownTiles = await renderCountdownScreen(cachedData)
        await sendTiles(cachedCountdownTiles)
      } else if (scr === 'calendar') {
        if (!cachedCalendarTiles) cachedCalendarTiles = await renderCalendarScreen(cachedData)
        await sendTiles(cachedCalendarTiles!)
      }
    })
  },
}

;(async () => {
  bridge = await waitForEvenAppBridge()

  bridge.onEvenHubEvent(async (event: any) => {
    const evType = resolveEventType(event)
    if (!cachedData) return
    if (evType === null) return

    // Swipe left (2) or single tap (0) → next screen
    // Swipe right (1) → previous screen
    // Double tap (3) → exit plugin
    const showScreen = (scr: Screen) => {
      currentScreen = scr
      enqueueRender(async () => {
        if (scr === 'main' && cachedMainTiles) {
          await sendTiles(cachedMainTiles)
        } else if (scr === 'countdown' && cachedData) {
          // Always re-render countdown so the time-until value is fresh
          cachedCountdownTiles = await renderCountdownScreen(cachedData)
          await sendTiles(cachedCountdownTiles)
        } else if (scr === 'calendar' && cachedCalendarTiles) {
          await sendTiles(cachedCalendarTiles)
        }
      })
    }
    if (evType === 0 || evType === 2) {
      const idx = SCREENS.indexOf(currentScreen)
      showScreen(SCREENS[(idx + 1) % SCREENS.length])
    } else if (evType === 1) {
      const idx = SCREENS.indexOf(currentScreen)
      showScreen(SCREENS[(idx - 1 + SCREENS.length) % SCREENS.length])
    } else if (evType === 3) {
      await bridge.shutDownPageContainer(1)
    }
  })

  setupSettingsUI()
  await initPage()

  try {
    const [storedCity, storedMethod] = await Promise.all([
      bridge.getLocalStorage('prayer_city').catch(() => ''),
      bridge.getLocalStorage('prayer_method').catch(() => ''),
    ])
    const city   = (storedCity && storedCity.length > 0) ? storedCity.toLowerCase().trim() : 'london'
    const method = (storedMethod !== '' && storedMethod !== null) ? parseInt(storedMethod) : -1
    _savedCity   = city
    _savedMethod = method
    await loadAndShow(city, method)
    scheduleNextMidnight()
  } catch (_) {
    await loadAndShow('london', -1)
  }
})()
