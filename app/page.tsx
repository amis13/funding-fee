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

// Si alguna venue usa tickers distintos, mapea aquí
const SYMBOL_MAP: Partial<Record<Venue, Record<string, string>>> = {
  // Ejemplos:
  // Hyperliquid: { PEPE: "1000PEPE", SHIB: "1000SHIB" },
  // Paradex:     { WIF: "WIF" },
}

const toVenueSymbol = (venue: Venue, base: string) =>
  SYMBOL_MAP[venue]?.[base] ?? base

const buildTradeLink = (venue: Venue, base: string): string | null => {
  const b = encodeURIComponent(toVenueSymbol(venue, base).toUpperCase().trim())
  switch (venue) {
    case "Hyperliquid":
      // También sirve /perp/{BASE}
      return `https://app.hyperliquid.xyz/trade/${b}`
    case "Lighter":
      return `https://app.lighter.xyz/trade/${b}`
    case "Paradex":
      // Paradex necesita el MARKET completo
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

  // Si no hay dato o no hay link, solo texto (no clicable)
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

  const formatPercentage = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) return "—"
    return `${(value * 100).toFixed(4)}%`
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

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Funding Fees Dashboard</h1>
            <p className="text-muted-foreground">Real-time funding rates across Hyperliquid, Lighter, and Paradex</p>
            <br></br>
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
            Auto-refresh: Every hour
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            Optimized parallel loading
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
                <p className="text-xs text-muted-foreground">
                  Using parallel processing to fetch data from multiple exchanges simultaneously
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

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
