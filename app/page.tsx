"use client"
import type { ReactNode } from "react";
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { RefreshCw, TrendingUp, TrendingDown, Clock, Zap } from "lucide-react"

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

interface ErrorResponse {
  error: string
  details?: string
  stdout?: string
}

/* =========================
   Helpers de enlaces
   ========================= */

type Venue = "Hyperliquid" | "Lighter" | "Paradex"
const VENUES: Venue[] = ["Hyperliquid", "Lighter", "Paradex"]

// Si alguna venue usa tickers distintos, mapea aquí
const SYMBOL_MAP: Partial<Record<Venue, Record<string, string>>> = {
  // Hyperliquid: { PEPE: "1000PEPE", SHIB: "1000SHIB" },
}

const toVenueSymbol = (venue: Venue, base: string) =>
  SYMBOL_MAP[venue]?.[base] ?? base

const buildTradeLink = (venue: Venue, base: string): string | null => {
  const b = encodeURIComponent(toVenueSymbol(venue, base).toUpperCase().trim())
  switch (venue) {
    case "Hyperliquid":
      return `https://app.hyperliquid.xyz/trade/${b}`
    case "Lighter":
      return `https://app.lighter.xyz/trade/${b}`
    case "Paradex":
      return `https://app.paradex.trade/trade/${b}-USD-PERP`
    default:
      return null
  }
}

/* =========================
   Componente FundingCell
   ========================= */

function FundingCell({
  venue,
  base,
  rate,
  formatPercentage,
  getPercentageColor,
  getPercentageIcon,
}: {
  venue: Venue
  base: string
  rate?: number | null
  formatPercentage: (v: number | undefined) => string
  getPercentageColor: (v: number | undefined) => string
  getPercentageIcon: (v: number | undefined) => ReactNode
}) {
  const href = buildTradeLink(venue, base)
  const color = getPercentageColor(rate ?? undefined)
  const content = (
    <div className={`flex items-center space-x-1 ${color}`}>
      {getPercentageIcon(rate ?? undefined)}
      <span>{formatPercentage(rate ?? undefined)}</span>
    </div>
  )

  if (rate == null || Number.isNaN(rate) || !href) {
    return content
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-2 hover:underline"
      title={`Abrir ${base} en ${venue}`}
      aria-label={`Abrir ${base} en ${venue}`}
    >
      {content}
    </a>
  )
}

export default function FundingFeesPage() {
  const [fundingData, setFundingData] = useState<FundingData>({})
  const [lastUpdate, setLastUpdate] = useState<string>("")
  const [totalAssets, setTotalAssets] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>("")
  const [errorDetails, setErrorDetails] = useState<string>("")
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStatus, setLoadingStatus] = useState("")

  const fetchFundingData = async () => {
    try {
      setLoading(true)
      setError("")
      setErrorDetails("")
      setLoadingProgress(0)
      setLoadingStatus("Initializing...")
      const progressInterval = setInterval(() => {
        setLoadingProgress((prev) => {
          if (prev < 90) {
            const increment = Math.random() * 10 + 5
            const newProgress = Math.min(prev + increment, 90)
            if (newProgress < 30) setLoadingStatus("Fetching Hyperliquid & Lighter data...")
            else if (newProgress < 80) setLoadingStatus("Processing Paradex data in parallel...")
            else setLoadingStatus("Finalizing results...")
            return newProgress
          }
          return prev
        })
      }, 200)

      const response = await fetch("/api/funding-fees")
      const contentType = response.headers.get("content-type")

      if (!response.ok) {
        clearInterval(progressInterval)
        let errorData: ErrorResponse
        try {
          errorData = contentType?.includes("application/json")
            ? await response.json()
            : { error: `HTTP ${response.status}`, details: (await response.text()).slice(0, 500) }
        } catch {
          errorData = { error: `HTTP ${response.status}`, details: (await response.text()).slice(0, 500) }
        }
        setError(errorData.error || `HTTP error! status: ${response.status}`)
        setErrorDetails(errorData.details || "")
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      let result: ApiResponse
      try {
        if (contentType?.includes("application/json")) {
          result = await response.json()
        } else {
          clearInterval(progressInterval)
          throw new Error("Server returned non-JSON response")
        }
      } catch (parseError) {
        clearInterval(progressInterval)
        throw parseError
      }

      clearInterval(progressInterval)
      setLoadingProgress(100)
      setLoadingStatus("Complete!")

      setFundingData(result.data)
      setLastUpdate(result.timestamp)
      setTotalAssets(result.totalAssets)

      setTimeout(() => {
        setLoadingProgress(0)
        setLoadingStatus("")
      }, 1000)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Error fetching data"
      setError(errorMessage)
      setLoadingProgress(0)
      setLoadingStatus("")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchFundingData()
    const interval = setInterval(fetchFundingData, 3600000)
    return () => clearInterval(interval)
  }, [])

  // ===== formatters =====
  const formatPercentage = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) return "—"
    return `${(value * 100).toFixed(4)}%`
  }
  const formatBps = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) return "—"
    return `${(value * 10000).toFixed(1)} bps`
  }
  const getPercentageColor = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) return "text-muted-foreground"
    if (value > 0) return "text-green-600 dark:text-green-400"
    if (value < 0) return "text-red-600 dark:text-red-400"
    return "text-muted-foreground"
  }
  const getPercentageIcon = (value: number | undefined) => {
    if (value === undefined || value === null || isNaN(value)) return null
    if (value > 0) return <TrendingUp className="h-3 w-3" />
    if (value < 0) return <TrendingDown className="h-3 w-3" />
    return null
  }

  const sortedAssets = Object.keys(fundingData).sort()

  // ===== Annualización =====
  const HOURS_PER_YEAR = 24 * 365
  const toAPY = (hourly: number) => Math.pow(1 + hourly, HOURS_PER_YEAR) - 1

  // ===== TOP 5: mayor discrepancia entre venues (max - min), priorizando signos opuestos
  type TopRow = {
    asset: string
    minVenue: Venue
    minRate: number
    maxVenue: Venue
    maxRate: number
    spread: number
    signFlip: boolean
    apy?: number // APY delta-neutral basado en spread (si hay sign flip)
  }

  const topRows: TopRow[] = (() => {
    const rows: TopRow[] = []

    for (const asset of sortedAssets) {
      const rates = fundingData[asset]
      if (!rates) continue

      // colecciona rates válidos
      const pairs = VENUES.flatMap((v) => {
        const r = rates[v]
        return r === null || r === undefined || Number.isNaN(r) ? [] : ([[v, r]] as [Venue, number][])
      })
      if (pairs.length < 2) continue

      // min y max por venue
      let minV = pairs[0][0], minR = pairs[0][1]
      let maxV = pairs[0][0], maxR = pairs[0][1]
      for (const [v, r] of pairs) {
        if (r < minR) { minR = r; minV = v }
        if (r > maxR) { maxR = r; maxV = v }
      }

      const spread = Math.abs(maxR - minR)
      const signFlip = minR < 0 && maxR > 0
      const apy = signFlip ? toAPY(spread) : undefined

      rows.push({
        asset,
        minVenue: minV,
        minRate: minR,
        maxVenue: maxV,
        maxRate: maxR,
        spread,
        signFlip,
        apy,
      })
    }

    // ordena: primero con signos opuestos, luego por spread desc
    rows.sort((a, b) => {
      const flipDiff = Number(b.signFlip) - Number(a.signFlip)
      return flipDiff !== 0 ? flipDiff : b.spread - a.spread
    })

    return rows.slice(0, 5)
  })()

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Funding Fees Dashboard</h1>
            <p className="text-muted-foreground">Real-time funding rates across Hyperliquid, Lighter, and Paradex</p>
            <br />
          </div>
        <Button onClick={fetchFundingData} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="flex items-center space-x-4 text-sm text-muted-foreground">
          {lastUpdate && <Badge variant="secondary">Last updated: {new Date(lastUpdate).toLocaleString()}</Badge>}
          {totalAssets > 0 && <Badge variant="outline">{totalAssets} assets</Badge>}
          <Badge variant="outline" className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            1h Funding Fees
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            Current rate
          </Badge>
        </div>

        {loading && (
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{loadingStatus}</span>
                  <span className="text-muted-foreground">{Math.round(loadingProgress)}%</span>
                </div>
                <Progress value={loadingProgress} className="h-2" />
                <p className="text-xs text-muted-foreground">Loading 1h Funding Rates...</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ===== TOP 5 DISCREPANCIAS ===== */}
      {!loading && topRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top 5 cross-venue discrepancies</CardTitle>
            <CardDescription>
              Assets with the largest funding-rate gap across venues (prioritizing opposite signs for delta-neutral).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-semibold">Asset</th>
                    <th className="text-left py-3 px-4 font-semibold">Long @</th>
                    <th className="text-left py-3 px-4 font-semibold">Short @</th>
                    <th className="text-left py-3 px-4 font-semibold">Rates (min / max)</th>
                    <th className="text-left py-3 px-4 font-semibold">Spread</th>
                    <th className="text-left py-3 px-4 font-semibold">APY (Δ-neutral)</th>
                    <th className="text-left py-3 px-4 font-semibold">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {topRows.map((row) => {
                    const longVenue = row.minRate < 0 ? row.minVenue : null
                    const shortVenue = row.maxRate > 0 ? row.maxVenue : null
                    return (
                      <tr key={row.asset} className="border-b hover:bg-muted/50">
                        <td className="py-3 px-4 font-medium">{row.asset}</td>
                        <td className="py-3 px-4">
                          {longVenue ? (
                            <a
                              className="underline-offset-2 hover:underline"
                              href={buildTradeLink(longVenue, row.asset) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {longVenue}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {shortVenue ? (
                            <a
                              className="underline-offset-2 hover:underline"
                              href={buildTradeLink(shortVenue, row.asset) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {shortVenue}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {formatPercentage(row.minRate)} / {formatPercentage(row.maxRate)}
                        </td>
                        <td className="py-3 px-4">{formatBps(row.spread)}</td>
                        <td className="py-3 px-4">
                          {row.apy !== undefined ? formatPercentage(row.apy) : "—"}
                        </td>
                        <td className="py-3 px-4">
                          {row.signFlip ? (
                            <Badge variant="default">Opposite signs</Badge>
                          ) : (
                            <Badge variant="outline">Same sign</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Suggestion: <strong>Go Long</strong> where the funding is negative and <strong>Go Short</strong> where it is positive.
              Check liquidity, fees, and borrow limits before executing any strategy.
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-destructive font-medium">Error: {error}</p>
              {errorDetails && (
                <details className="text-sm text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">Show details</summary>
                  <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto">{errorDetails}</pre>
                </details>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Funding Rates by Asset</CardTitle>
          <CardDescription>Hourly funding rates across different trading platforms</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin mr-2" />
              <span>Loading funding data...</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-semibold">Asset</th>
                    <th className="text-left py-3 px-4 font-semibold">Hyperliquid</th>
                    <th className="text-left py-3 px-4 font-semibold">Lighter</th>
                    <th className="text-left py-3 px-4 font-semibold">Paradex</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAssets.map((asset) => {
                    const rates = fundingData[asset]
                    return (
                      <tr key={asset} className="border-b hover:bg-muted/50">
                        <td className="py-3 px-4 font-medium">{asset}</td>

                        <td className="py-3 px-4">
                          <FundingCell
                            venue="Hyperliquid"
                            base={asset}
                            rate={rates.Hyperliquid}
                            formatPercentage={formatPercentage}
                            getPercentageColor={getPercentageColor}
                            getPercentageIcon={getPercentageIcon}
                          />
                        </td>

                        <td className="py-3 px-4">
                          <FundingCell
                            venue="Lighter"
                            base={asset}
                            rate={rates.Lighter}
                            formatPercentage={formatPercentage}
                            getPercentageColor={getPercentageColor}
                            getPercentageIcon={getPercentageIcon}
                          />
                        </td>

                        <td className="py-3 px-4">
                          <FundingCell
                            venue="Paradex"
                            base={asset}
                            rate={rates.Paradex}
                            formatPercentage={formatPercentage}
                            getPercentageColor={getPercentageColor}
                            getPercentageIcon={getPercentageIcon}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {sortedAssets.length === 0 && !loading && (
                <div className="text-center py-8 text-muted-foreground">No funding data available</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
