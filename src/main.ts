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

const canvasToPngBytes = (canvas: HTMLCanvasElement): Uint8Array => {
  const b64 = canvas.toDataURL('image/png').split(',')[1]
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Slice the 400×200 canvas into 4 quadrant PNGs (TL, TR, BL, BR) */
const sliceQuadrants = (canvas: HTMLCanvasElement): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] => {
  const quad = (sx: number, sy: number): Uint8Array => {
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

const getPrayerData = async (city: string): Promise<PrayerData> => {
  const today = new Date()
  const dd = String(today.getDate()).padStart(2, '0')
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const yyyy = today.getFullYear()
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const gregDate = `${days[today.getDay()]} ${today.getDate()} ${months[today.getMonth()]} ${yyyy}`

  let prayers: Prayer[], cityLabel: string, timezone: string, hijriDate: string
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
      `https://api.aladhan.com/v1/timingsByCity/${dd}-${mm}-${yyyy}?city=London&country=United+Kingdom&method=1`
    )
    const hData = await hRes.json()
    const hijri = hData.data.date.hijri
    hijriDay   = parseInt(hijri.day)
    hijriMonth = parseInt(hijri.month.number)
    hijriYear  = parseInt(hijri.year)
    hijriMonthName = hijri.month.en
    hijriDate  = `${hijri.day} ${hijriMonthName} ${hijri.year} AH`
  } else {
    const cityName = city.charAt(0).toUpperCase() + city.slice(1)
    let res  = await fetchWithTimeout(
      `https://api.aladhan.com/v1/timingsByCity/${dd}-${mm}-${yyyy}?city=${encodeURIComponent(cityName)}&method=1`
    )
    let data = await res.json()

    if (!data.data?.timings) {
      res  = await fetchWithTimeout(
        `https://api.aladhan.com/v1/timingsByCity/${dd}-${mm}-${yyyy}?city=${encodeURIComponent(cityName)}&country=${encodeURIComponent(cityName)}&method=1`
      )
      data = await res.json()
    }

    if (!data.data?.timings) throw new Error(`City not found: ${cityName}`)

    timezone  = data.data.meta?.timezone || 'UTC'
    const t   = data.data.timings
    const hijri = data.data.date.hijri
    cityLabel  = cityName
    hijriDay   = parseInt(hijri.day)
    hijriMonth = parseInt(hijri.month.number)
    hijriYear  = parseInt(hijri.year)
    hijriMonthName = hijri.month.en
    hijriDate  = `${hijri.day} ${hijriMonthName} ${hijri.year} AH`
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

const renderMainScreen = (data: PrayerData): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] => {
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
      ctx.fillStyle = '#1e1600'
      ctx.fillRect(2, y - 1, IMG_W - 4, ROW_H)
    }

    // Prayer name
    ctx.font = isNext ? FONT_BOLD : (isSunrise ? FONT_HEADER : FONT_BODY)
    ctx.fillStyle = isNext ? '#ffcc00' : (isSunrise ? '#444' : '#ccc')
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(p.name, 10, y + ROW_H / 2)

    // Time
    ctx.font = isNext ? FONT_BOLD : (isSunrise ? FONT_HEADER : FONT_BODY)
    ctx.fillStyle = isNext ? '#ffcc00' : (isSunrise ? '#444' : '#888')
    ctx.textAlign = 'right'
    ctx.fillText(p.time, TIME_X - (isNext ? 18 : 0), y + ROW_H / 2)

    // Next-prayer indicator arrow
    if (isNext) {
      ctx.fillStyle = '#ffcc00'
      ctx.font = FONT_BOLD
      ctx.textAlign = 'right'
      ctx.fillText('▶', TIME_X, y + ROW_H / 2)
    }
  })

  // ── Footer ───────────────────────────────────────────────────────────────────
  drawSeparator(ctx, IMG_H - 14)
  ctx.font = FONT_HINT; ctx.fillStyle = '#444'
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText('double-tap: next screen', IMG_W / 2, IMG_H - 2)

  return sliceQuadrants(canvas)
}

const renderCountdownScreen = (data: PrayerData): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] => {
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
  ctx.fillText('double-tap: next screen', IMG_W / 2, IMG_H - 2)

  return sliceQuadrants(canvas)
}

const renderCalendarScreen = (data: PrayerData): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] => {
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
    ctx.fillText('double-tap: next screen', IMG_W / 2, IMG_H - 2)
  }

  return sliceQuadrants(canvas)
}

const renderLoadingScreen = (city: string): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] => {
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

let cachedMainTiles:      [Uint8Array, Uint8Array, Uint8Array, Uint8Array] | null = null
let cachedCountdownTiles: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] | null = null
let cachedCalendarTiles:  [Uint8Array, Uint8Array, Uint8Array, Uint8Array] | null = null

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

const sendTiles = async (tiles: [Uint8Array, Uint8Array, Uint8Array, Uint8Array]) => {
  const [tl, tr, bl, br] = tiles
  await Promise.all([
    bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 1, containerName: 'quad_tl', imageData: tl })),
    bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 2, containerName: 'quad_tr', imageData: tr })),
    bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 3, containerName: 'quad_bl', imageData: bl })),
    bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: 'quad_br', imageData: br })),
  ])
}

// ─── Main flow ────────────────────────────────────────────────────────────────

const loadAndShow = async (city: string) => {
  await sendTiles(renderLoadingScreen(city))
  try {
    const data = await getPrayerData(city)
    cachedData           = data
    currentScreen        = 'main'
    cachedMainTiles      = renderMainScreen(data)
    cachedCountdownTiles = renderCountdownScreen(data)
    cachedCalendarTiles  = renderCalendarScreen(data)
    await sendTiles(cachedMainTiles)
  } catch (e: any) {
    const [canvas, ctx] = makeCanvas(IMG_W, IMG_H)
    ctx.font = FONT_BODY; ctx.fillStyle = '#f66'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`Error: ${e.message}`, IMG_W / 2, IMG_H / 2)
    const bytes = canvasToPngBytes(canvas)
    await sendTiles([bytes, bytes, bytes, bytes])
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
      const stored = await bridge.getLocalStorage('prayer_city')
      const city   = (stored && stored.length > 0) ? stored.toLowerCase().trim() : 'london'
      await loadAndShow(city)
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
    const city = cityInput.value.trim().toLowerCase()
    if (!city) return
    setLoading(true)
    try {
      const data = await getPrayerData(city)
      if (bridge) {
        await bridge.setLocalStorage('prayer_city', city)
        cachedData           = data
        currentScreen        = 'main'
        cachedMainTiles      = renderMainScreen(data)
        cachedCountdownTiles = renderCountdownScreen(data)
        cachedCalendarTiles  = renderCalendarScreen(data)
        await sendTiles(cachedMainTiles)
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

;(async () => {
  bridge = await waitForEvenAppBridge()

  bridge.onEvenHubEvent(async (event: any) => {
    if (!cachedData) return

    const evType = resolveEventType(event)
    if (evType === null) return

    // Hardware confirmed: double-tap fires sysEvent.eventType = 3
    // Cycle screens on every type-3 event
    if (evType === 3) {
      const idx     = SCREENS.indexOf(currentScreen)
      const nextScr = SCREENS[(idx + 1) % SCREENS.length]
      currentScreen = nextScr

      if (nextScr === 'main'      && cachedMainTiles)      await sendTiles(cachedMainTiles)
      if (nextScr === 'countdown' && cachedCountdownTiles) await sendTiles(cachedCountdownTiles)
      if (nextScr === 'calendar'  && cachedCalendarTiles)  await sendTiles(cachedCalendarTiles)
    }
  })

  setupSettingsUI()
  await initPage()

  try {
    const stored = await bridge.getLocalStorage('prayer_city')
    const city   = (stored && stored.length > 0) ? stored.toLowerCase().trim() : 'london'
    await loadAndShow(city)
    scheduleNextMidnight()
  } catch (_) {
    await loadAndShow('london')
  }
})()
