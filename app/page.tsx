"use client"

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
      console.log("[v0] Starting fetch request to /api/funding-fees")

      const progressInterval = setInterval(() => {
        setLoadingProgress((prev) => {
          if (prev < 90) {
            const increment = Math.random() * 10 + 5
            const newProgress = Math.min(prev + increment, 90)

            if (newProgress < 30) {
              setLoadingStatus("Fetching Hyperliquid & Lighter data...")
            } else if (newProgress < 80) {
              setLoadingStatus("Processing Paradex data in parallel...")
            } else {
              setLoadingStatus("Finalizing results...")
            }

            return newProgress
          }
          return prev
        })
      }, 200)

      const response = await fetch("/api/funding-fees")
      console.log("[v0] Response status:", response.status)
      console.log("[v0] Response headers:", Object.fromEntries(response.headers.entries()))

      const contentType = response.headers.get("content-type")
      console.log("[v0] Content-Type:", contentType)

      if (!response.ok) {
        clearInterval(progressInterval)
        let errorData: ErrorResponse
        try {
          if (contentType && contentType.includes("application/json")) {
            errorData = await response.json()
          } else {
            const textResponse = await response.text()
            console.log("[v0] Non-JSON error response:", textResponse)
            errorData = {
              error: `HTTP ${response.status}`,
              details: textResponse.substring(0, 500),
            }
          }
        } catch (parseError) {
          console.log("[v0] Failed to parse error response:", parseError)
          const textResponse = await response.text()
          errorData = {
            error: `HTTP ${response.status}`,
            details: textResponse.substring(0, 500),
          }
        }

        console.log("[v0] Error response:", errorData)
        setError(errorData.error || `HTTP error! status: ${response.status}`)
        setErrorDetails(errorData.details || "")
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      console.log("[v0] Response is OK, starting to parse JSON...")
      let result: ApiResponse
      try {
        if (contentType && contentType.includes("application/json")) {
          console.log("[v0] Parsing JSON response...")
          result = await response.json()
          console.log("[v0] JSON parsed successfully, data keys:", Object.keys(result))
          console.log("[v0] Data object keys count:", Object.keys(result.data || {}).length)
        } else {
          clearInterval(progressInterval)
          const textResponse = await response.text()
          console.log("[v0] Non-JSON success response:", textResponse)
          throw new Error("Server returned non-JSON response: " + textResponse.substring(0, 200))
        }
      } catch (parseError) {
        clearInterval(progressInterval)
        console.log("[v0] Failed to parse success response:", parseError)
        throw new Error("Failed to parse server response: " + parseError)
      }

      clearInterval(progressInterval)
      setLoadingProgress(100)
      setLoadingStatus("Complete!")

      console.log("[v0] Setting state with parsed data...")
      console.log("[v0] Result data type:", typeof result.data)
      console.log("[v0] Result data is object:", result.data && typeof result.data === "object")

      if (!result.data || typeof result.data !== "object") {
        throw new Error("Invalid data format received from server")
      }

      setFundingData(result.data)
      setLastUpdate(result.timestamp || new Date().toISOString())
      setTotalAssets(result.totalAssets || Object.keys(result.data).length)

      console.log("[v0] State updated successfully!")

      setTimeout(() => {
        setLoadingProgress(0)
        setLoadingStatus("")
      }, 1000)
    } catch (err) {
      console.log("[v0] Caught error in fetchFundingData:", err)
      const errorMessage = err instanceof Error ? err.message : "Error fetching data"
      setError(errorMessage)
      console.error("[v0] Error fetching funding data:", err)
      setLoadingProgress(0)
      setLoadingStatus("")
    } finally {
      setLoading(false)
      console.log("[v0] fetchFundingData completed, loading set to false")
    }
  }

  useEffect(() => {
    fetchFundingData()

    const interval = setInterval(fetchFundingData, 3600000)

    return () => clearInterval(interval)
  }, [])

  const formatPercentage = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) {
      return "—"
    }
    return `${(value * 100).toFixed(4)}%`
  }

  const getPercentageColor = (value: number | undefined): string => {
    if (value === undefined || value === null || isNaN(value)) {
      return "text-muted-foreground"
    }
    if (value > 0) return "text-green-600 dark:text-green-400"
    if (value < 0) return "text-red-600 dark:text-red-400"
    return "text-muted-foreground"
  }

  const getPercentageIcon = (value: number | undefined) => {
    if (value === undefined || value === null || isNaN(value)) {
      return null
    }
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
                    <th className="text-left py-3 px-4 font-semibold">Hyperliquid/hr</th>
                    <th className="text-left py-3 px-4 font-semibold">Lighter/hr</th>
                    <th className="text-left py-3 px-4 font-semibold">Paradex/hr</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAssets.map((asset) => {
                    const rates = fundingData[asset]
                    return (
                      <tr key={asset} className="border-b hover:bg-muted/50">
                        <td className="py-3 px-4 font-medium">{asset}</td>
                        <td className={`py-3 px-4 ${getPercentageColor(rates.Hyperliquid)}`}>
                          <div className="flex items-center space-x-1">
                            {getPercentageIcon(rates.Hyperliquid)}
                            <span>{formatPercentage(rates.Hyperliquid)}</span>
                          </div>
                        </td>
                        <td className={`py-3 px-4 ${getPercentageColor(rates.Lighter)}`}>
                          <div className="flex items-center space-x-1">
                            {getPercentageIcon(rates.Lighter)}
                            <span>{formatPercentage(rates.Lighter)}</span>
                          </div>
                        </td>
                        <td className={`py-3 px-4 ${getPercentageColor(rates.Paradex)}`}>
                          <div className="flex items-center space-x-1">
                            {getPercentageIcon(rates.Paradex)}
                            <span>{formatPercentage(rates.Paradex)}</span>
                          </div>
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
