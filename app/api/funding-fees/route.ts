// app/api/funding/route.ts
import { NextResponse } from "next/server"

// Fuerza ejecución dinámica en prod (sin ISR/caché)
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

interface FundingData {
  [asset: string]: {
    Hyperliquid?: number
    Lighter?: number
    Paradex?: number
  }
}

interface ApiResponse {
  data: FundingData
  timestamp: string
  totalAssets: number
}

const API_AGG = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
const PARADEX_URL = "https://api.prod.paradex.trade/v1/funding/data?market={market}"

// --- Utils ---
function cleanAlnum(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
}

function coerceRate(val: any): number | null {
  if (val === null || val === undefined) return null
  const x = Number.parseFloat(val)
  if (Number.isNaN(x)) return null
  // Si viene en %, pásalo a decimal
  const y = 1.0 < Math.abs(x) && Math.abs(x) <= 100.0 ? x / 100.0 : x
  // Filtra outliers absurdos (>50%/h)
  if (Math.abs(y) > 0.5) return null
  return y
}

function baseFromSymbol(symbol: string): string {
  const s = (symbol || "").toUpperCase().replace(/[/_]/g, "-").trim()
  const parts = s.split("-").filter((p) => p)
  return parts[0] || s || "?"
}

// --- Normalización por plataforma (todo a %/hr) ---
// ⚠️ Ahora Hyperliquid y Lighter vienen x8 → dividimos entre 8
const PERIOD_HOURS: Record<string, number> = {
  Hyperliquid: 8, // <- cambiado a 8
  Lighter: 8,
  Paradex: 8,     // la UI muestra 8h; luego lo normalizamos a 1h en extract
}
const normalizePerHour = (plat: string, rate: number | null) =>
  rate == null ? null : rate / (PERIOD_HOURS[plat] ?? 1)

// --- Heurísticas de parseo ---
const PLAT_MAP: Record<string, string> = {
  lighter: "Lighter",
  zklighter: "Lighter",
  hyperliquid: "Hyperliquid",
  hyperliquidv2: "Hyperliquid",
  hyper: "Hyperliquid",
}
const PLATFORM_KEYS = ["platform", "exchange", "venue", "source", "provider", "dex", "market_provider"]
const SYMBOL_KEYS = ["symbol", "market", "pair", "name", "base", "asset", "coin", "ticker"]
const FUND_KEYS = ["funding_rate", "fundingrate", "hourlyfundingrate", "predictedfundingrate", "rate", "value"]

function normPlatformLabel(raw: string | null): string | null {
  if (!raw) return null
  const key = cleanAlnum(raw)
  if (key in PLAT_MAP) return PLAT_MAP[key]
  for (const [k, v] of Object.entries(PLAT_MAP)) if (key.includes(k)) return v
  return null
}
function isProbableSymbolKey(k: string): boolean {
  return SYMBOL_KEYS.some((x) => k.toLowerCase().includes(x))
}
function isProbablePlatformKey(k: string): boolean {
  return PLATFORM_KEYS.some((x) => k.toLowerCase().includes(x))
}
function isProbableRateKey(k: string): boolean {
  const kLower = k.toLowerCase()
  return FUND_KEYS.some((x) => kLower.includes(x)) || (kLower.includes("fund") && !kLower.includes("index") && !kLower.includes("time"))
}

// Prioriza campos instantáneos/por hora sobre predicted
function pickRate(obj: any): number | null {
  if (!obj || typeof obj !== "object") return null

  // 1) Preferidos (lo que suele mostrar la UI por hora)
  const preferred = [
    "intrFunding",
    "instantFunding",
    "currentFunding",
    "hourlyFundingRate",
    "funding_rate_hour",
    "fundingRateHour",
    "hourly_funding_rate",
  ]
  for (const k of Object.keys(obj)) {
    if (preferred.includes(k)) {
      const r = coerceRate((obj as any)[k])
      if (r !== null) return r
    }
  }

  // 2) Genéricos
  const generic = ["funding_rate", "fundingRate", "rate", "value"]
  for (const k of Object.keys(obj)) {
    if (generic.includes(k)) {
      const r = coerceRate((obj as any)[k])
      if (r !== null) return r
    }
  }

  // 3) Predicted/next (último recurso)
  const predicted = ["predictedfundingrate", "predictedFundingRate", "nextFundingRate"]
  for (const k of Object.keys(obj)) {
    if (predicted.includes(k)) {
      const r = coerceRate((obj as any)[k])
      if (r !== null) return r
    }
  }

  return null
}

function* traverse(node: any, pathKeys: string[] = []): Generator<[any, string[]]> {
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    yield [node, pathKeys]
    for (const [k, v] of Object.entries(node)) yield* traverse(v, [...pathKeys, k])
  } else if (Array.isArray(node)) {
    for (const [idx, v] of node.entries()) yield* traverse(v, [...pathKeys, idx.toString()])
  }
}

function extractRecord(d: any, pathKeys: string[]): [string | null, string | null, number | null] {
  let platform: string | null = null
  let symbol: string | null = null
  let rate: number | null = null

  // Plataforma y símbolo por clave directa
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string") {
      if (isProbablePlatformKey(k) && !platform) platform = normPlatformLabel(v)
      if (isProbableSymbolKey(k) && !symbol) symbol = v
    }
    // Posible rate directo
    if ((typeof v === "number" || typeof v === "string") && isProbableRateKey(k) && rate === null) {
      rate = coerceRate(v)
    }
  }

  // Plataforma derivada del path
  if (!platform) {
    for (const key of [...pathKeys].reverse()) {
      const guess = normPlatformLabel(key)
      if (guess) {
        platform = guess
        break
      }
    }
  }

  // Símbolo anidado
  if (!symbol) {
    for (const v of Object.values(d)) {
      if (typeof v === "object" && v !== null) {
        for (const [kk, vv] of Object.entries(v)) {
          if (typeof vv === "string" && isProbableSymbolKey(kk)) {
            symbol = vv
            break
          }
        }
        if (symbol) break
      }
    }
  }

  // Rate con prioridad (objeto actual)
  if (rate === null) rate = pickRate(d)

  // Rate anidado (fallback)
  if (rate === null) {
    for (const v of Object.values(d)) {
      if (typeof v === "object" && v !== null) {
        const r = pickRate(v)
        if (r !== null) {
          rate = r
          break
        }
      }
    }
  }

  const base = symbol ? baseFromSymbol(symbol) : null
  return [platform, base, rate]
}

// --- Fetch agregador (Hyperliquid + Lighter) ---
async function fetchAgg(): Promise<[Record<string, Record<string, number>>, string[]]> {
  const byBase: Record<string, Record<string, number>> = {}
  const basesLighter: string[] = []

  console.log("[v0] Fetching aggregator data from:", API_AGG)
  const response = await fetch(API_AGG, {
    headers: { "User-Agent": "funding-triplet/1.1" },
    cache: "no-store",
    next: { revalidate: 0 },
  })
  if (!response.ok) throw new Error(`Aggregator API failed: ${response.status}`)

  const data = await response.json()
  console.log("[v0] Aggregator response received")

  for (const [node, path] of traverse(data)) {
    if (typeof node !== "object" || node === null) continue
    const [plat, base, rateRaw] = extractRecord(node, path)

    if (!plat || !["Lighter", "Hyperliquid"].includes(plat) || !base) continue
    const rate = normalizePerHour(plat, rateRaw)
    if (rate === null) continue

    if (!byBase[base]) byBase[base] = {}
    byBase[base][plat] = rate

    if (plat === "Lighter" && !basesLighter.includes(base)) basesLighter.push(base)
  }

  console.log("[v0] Parsed aggregator data:", Object.keys(byBase).length, "assets")
  return [byBase, basesLighter]
}

// --- Paradex helpers ---
function extractParadexLatest(payload: any): number | null {
  let items: any[] | null = null
  if (Array.isArray(payload)) items = payload
  else if (payload && typeof payload === "object") items = payload.data || payload.results || payload.items
  if (!Array.isArray(items) || items.length === 0) return null

  const last = items[items.length - 1]
  if (!last || typeof last !== "object") return null

  // Prioridad: hourly_funding_rate > funding_rate (8h)
  const hourly = last.hourly_funding_rate ?? last.fundingRateHour ?? null
  const eightH = last.funding_rate ?? last.fundingRate ?? null

  let r: number | null = null
  if (hourly != null) r = coerceRate(hourly)
  else if (eightH != null) {
    const raw = coerceRate(eightH)
    r = raw == null ? null : raw / 8 // normaliza 8h -> 1h
  }
  return r
}

async function fetchParadexLatestForBase(base: string, quotes: string[]): Promise<number | null> {
  for (const q of quotes) {
    const mkt = `${base}-${q}-PERP`
    const url = PARADEX_URL.replace("{market}", mkt)

    try {
      console.log("[v0] Fetching Paradex data for:", mkt)
      const response = await fetch(url, {
        headers: { "User-Agent": "funding-triplet/1.1" },
        cache: "no-store",
        next: { revalidate: 0 },
      })

      if (response.status === 404) continue
      if (!response.ok) continue

      const data = await response.json()
      const hourlyRate = extractParadexLatest(data) // ya viene /hr
      if (hourlyRate !== null) return hourlyRate
    } catch (error) {
      console.log("[v0] Paradex error for", mkt, ":", error)
      continue
    }
  }
  return null
}

async function fetchParadexBatch(bases: string[], quotes: string[], batchSize = 10): Promise<Record<string, number>> {
  const results: Record<string, number> = {}

  for (let i = 0; i < bases.length; i += batchSize) {
    const batch = bases.slice(i, i + batchSize)
    console.log(
      `[v0] Processing Paradex batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        bases.length / batchSize,
      )} (${batch.length} assets)`,
    )

    const batchPromises = batch.map(async (base) => {
      try {
        const timeoutPromise = new Promise<number | null>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000),
        )
        const fetchPromise = fetchParadexLatestForBase(base, quotes)
        const rate = await Promise.race([fetchPromise, timeoutPromise])

        if (rate !== null) results[base] = rate
        return { base, rate }
      } catch (error) {
        console.log(`[v0] Paradex timeout/error for ${base}:`, error instanceof Error ? error.message : "Unknown error")
        return { base, rate: null }
      }
    })

    await Promise.all(batchPromises)
    if (i + batchSize < bases.length) await new Promise((r) => setTimeout(r, 100))
  }

  return results
}

// --- Handler ---
export async function GET() {
  try {
    console.log("[v0] Starting funding fees collection")

    // 1) Hyperliquid + Lighter del agregador (ambos ÷ 8)
    const [byBase, basesLighter] = await fetchAgg()

    // 2) Paradex en lotes (normalizado a /hr en extract)
    const quotes = ["USD", "USDC"]
    const allBases = basesLighter
    console.log(`[v0] Fetching Paradex data for ${allBases.length} assets in parallel batches`)
    const paradexResults = await fetchParadexBatch(allBases, quotes, 10)

    // 3) Merge Paradex
    for (const [base, rate] of Object.entries(paradexResults)) {
      if (rate == null) continue
      if (!byBase[base]) byBase[base] = {}
      byBase[base]["Paradex"] = rate // ya es /hr
    }

    const response: ApiResponse = {
      data: byBase,
      timestamp: new Date().toISOString(),
      totalAssets: Object.keys(byBase).length,
    }

    console.log("[v0] Successfully collected funding data for", response.totalAssets, "assets")
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
    })
  } catch (error) {
    console.error("[v0] API route error:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch funding data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
      },
    )
  }
}
