import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 3600 // Cache for 1 hour

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
  note?: string
}

const API_AGG = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
const PARADEX_URL = "https://api.prod.paradex.trade/v1/funding/data?market={market}"

// Utility functions converted from Python
function cleanAlnum(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
}

function coerceRate(val: any): number | null {
  if (val === null || val === undefined) return null

  try {
    let x = Number.parseFloat(val)
    if (isNaN(x)) return null

    // If it's a percentage (1..100), convert to decimal
    if (1.0 < Math.abs(x) && Math.abs(x) <= 100.0) {
      x = x / 100.0
    }

    // Discard rates > 50%/h (probably invalid)
    if (Math.abs(x) > 0.5) return null

    return x
  } catch {
    return null
  }
}

function baseFromSymbol(symbol: string): string {
  const s = (symbol || "").toUpperCase().replace(/[/_]/g, "-").trim()
  const parts = s.split("-").filter((p) => p)
  return parts[0] || s || "?"
}

// Platform mapping
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

  for (const [k, v] of Object.entries(PLAT_MAP)) {
    if (key.includes(k)) return v
  }

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
  return (
    FUND_KEYS.some((x) => kLower.includes(x)) ||
    (kLower.includes("fund") && !kLower.includes("index") && !kLower.includes("time"))
  )
}

function* traverse(node: any, pathKeys: string[] = []): Generator<[any, string[]]> {
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    yield [node, pathKeys]
    for (const [k, v] of Object.entries(node)) {
      yield* traverse(v, [...pathKeys, k])
    }
  } else if (Array.isArray(node)) {
    for (const [idx, v] of node.entries()) {
      yield* traverse(v, [...pathKeys, idx.toString()])
    }
  }
}

function extractRecord(d: any, pathKeys: string[]): [string | null, string | null, number | null] {
  let platform: string | null = null
  let symbol: string | null = null
  let rate: number | null = null

  // 1) Direct extraction
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string") {
      if (isProbablePlatformKey(k) && !platform) {
        platform = normPlatformLabel(v)
      }
      if (isProbableSymbolKey(k) && !symbol) {
        symbol = v
      }
    }
    if ((typeof v === "number" || typeof v === "string") && isProbableRateKey(k) && rate === null) {
      rate = coerceRate(v)
    }
  }

  // 2) Platform from path
  if (!platform) {
    for (const key of pathKeys.reverse()) {
      const guess = normPlatformLabel(key)
      if (guess) {
        platform = guess
        break
      }
    }
  }

  // 3) Nested symbol
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

  // 4) Nested rate
  if (rate === null) {
    for (const v of Object.values(d)) {
      if (typeof v === "object" && v !== null) {
        for (const [kk, vv] of Object.entries(v)) {
          if (isProbableRateKey(kk) && (typeof vv === "number" || typeof vv === "string")) {
            rate = coerceRate(vv)
            if (rate !== null) break
          }
        }
        if (rate !== null) break
      }
    }
  }

  const base = symbol ? baseFromSymbol(symbol) : null
  return [platform, base, rate]
}

async function fetchAgg(): Promise<[Record<string, Record<string, number>>, string[]]> {
  const byBase: Record<string, Record<string, number>> = {}
  const basesLighter: string[] = []

  try {
    console.log("[v0] Fetching aggregator data from:", API_AGG)
    const response = await fetch(API_AGG, {
      headers: { "User-Agent": "funding-triplet/1.1" },
    })

    if (!response.ok) {
      throw new Error(`Aggregator API failed: ${response.status}`)
    }

    const data = await response.json()
    console.log("[v0] Aggregator response received")

    for (const [node, path] of traverse(data)) {
      if (typeof node !== "object" || node === null) continue

      const [plat, base, rate] = extractRecord(node, path)

      if (!plat || !["Lighter", "Hyperliquid"].includes(plat) || !base || rate === null) {
        continue
      }

      if (!byBase[base]) byBase[base] = {}
      byBase[base][plat] = rate

      if (plat === "Lighter" && !basesLighter.includes(base)) {
        basesLighter.push(base)
      }
    }

    console.log("[v0] Parsed aggregator data:", Object.keys(byBase).length, "assets")
    return [byBase, basesLighter]
  } catch (error) {
    console.error("[v0] Error fetching aggregator:", error)
    throw error
  }
}

function parseTs(tsVal: any): number | null {
  if (tsVal === null || tsVal === undefined) return null

  if (typeof tsVal === "number") {
    const x = tsVal
    return x > 1e12 ? x / 1000.0 : x
  }

  if (typeof tsVal === "string") {
    try {
      let s = tsVal.trim()
      if (s.endsWith("Z")) s = s.slice(0, -1) + "+00:00"
      return new Date(s).getTime() / 1000
    } catch {
      return null
    }
  }

  return null
}

function extractParadexLatest(payload: any): number | null {
  let items: any[] | null = null

  if (Array.isArray(payload)) {
    items = payload
  } else if (typeof payload === "object" && payload !== null) {
    items = payload.data || payload.results || payload.items
  }

  if (!Array.isArray(items) || items.length === 0) return null

  const lastItem = items[items.length - 1]

  if (typeof lastItem !== "object" || lastItem === null) return null

  const rateRaw = lastItem.funding_rate || lastItem.fundingRate || lastItem.hourly_funding_rate
  let rate: number | null = null

  try {
    rate = rateRaw !== null && rateRaw !== undefined ? Number.parseFloat(rateRaw) : null
  } catch {
    rate = null
  }

  return rate
}

async function fetchParadexLatestForBase(base: string, quotes: string[]): Promise<number | null> {
  for (const q of quotes) {
    const mkt = `${base}-${q}-PERP`
    const url = PARADEX_URL.replace("{market}", mkt)

    try {
      console.log("[v0] Fetching Paradex data for:", mkt)
      const response = await fetch(url, {
        headers: { "User-Agent": "funding-triplet/1.1" },
      })

      if (response.status === 404) continue
      if (!response.ok) continue

      const data = await response.json()
      const rate = extractParadexLatest(data)

      if (rate !== null) {
        console.log("[v0] Found Paradex rate for", mkt, ":", rate)
        return rate
      }
    } catch (error) {
      console.log("[v0] Paradex error for", mkt, ":", error)
      continue
    }
  }

  return null
}

async function fetchParadexBatch(bases: string[], quotes: string[], batchSize = 10): Promise<Record<string, number>> {
  const results: Record<string, number> = {}

  // Process bases in batches to avoid overwhelming the API
  for (let i = 0; i < bases.length; i += batchSize) {
    const batch = bases.slice(i, i + batchSize)
    console.log(
      `[v0] Processing Paradex batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(bases.length / batchSize)} (${batch.length} assets)`,
    )

    // Process batch in parallel with timeout
    const batchPromises = batch.map(async (base) => {
      try {
        const timeoutPromise = new Promise<number | null>(
          (_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000), // 5 second timeout per request
        )

        const fetchPromise = fetchParadexLatestForBase(base, quotes)
        const rate = await Promise.race([fetchPromise, timeoutPromise])

        if (rate !== null) {
          results[base] = rate
        }
        return { base, rate }
      } catch (error) {
        console.log(`[v0] Paradex timeout/error for ${base}:`, error instanceof Error ? error.message : "Unknown error")
        return { base, rate: null }
      }
    })

    await Promise.all(batchPromises)

    // Small delay between batches to be respectful to the API
    if (i + batchSize < bases.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return results
}

export async function GET() {
  try {
    if (process.env.NODE_ENV === "production" && process.env.VERCEL !== "1") {
      // Return sample data for Firebase static hosting
      const sampleData: FundingData = {
        BTC: { Hyperliquid: 0.0001, Lighter: 0.00012, Paradex: 0.00015 },
        ETH: { Hyperliquid: 0.0002, Lighter: 0.00018, Paradex: 0.00022 },
        SOL: { Hyperliquid: 0.0003, Lighter: null, Paradex: 0.00025 },
        AVAX: { Hyperliquid: 0.0001, Lighter: 0.00015, Paradex: null },
        LINK: { Hyperliquid: 0.0002, Lighter: 0.00019, Paradex: 0.00021 },
      }

      return NextResponse.json({
        data: sampleData,
        timestamp: new Date().toISOString(),
        totalAssets: Object.keys(sampleData).length,
        note: "Sample data - Deploy to Vercel for real-time data",
      })
    }

    console.log("[v0] Starting funding fees collection")

    // 1) Fetch Hyperliquid + Lighter data
    const [byBase, basesLighter] = await fetchAgg()

    // 2) Fetch Paradex data in parallel batches
    const quotes = ["USD", "USDC"]
    const allBases = basesLighter

    console.log(`[v0] Fetching Paradex data for ${allBases.length} assets in parallel batches`)
    const paradexResults = await fetchParadexBatch(allBases, quotes, 10) // Process 10 at a time

    // 3) Merge Paradex results
    for (const [base, rate] of Object.entries(paradexResults)) {
      if (!byBase[base]) byBase[base] = {}
      byBase[base]["Paradex"] = rate
    }

    const response: ApiResponse = {
      data: byBase,
      timestamp: new Date().toISOString(),
      totalAssets: Object.keys(byBase).length,
    }

    console.log("[v0] Successfully collected funding data for", response.totalAssets, "assets")
    return NextResponse.json(response)
  } catch (error) {
    console.error("[v0] API route error:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch funding data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
