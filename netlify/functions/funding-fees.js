const https = require("https")
const http = require("http")

// Helper function to make HTTP requests
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https:") ? https : http
    const req = protocol.get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          resolve(data)
        }
      })
    })
    req.on("error", reject)
    req.setTimeout(5000, () => {
      req.destroy()
      reject(new Error("Request timeout"))
    })
  })
}

// Batch process with concurrency limit
async function processBatch(items, batchSize, processor) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.allSettled(batch.map(processor))
    results.push(...batchResults)
  }
  return results
}

exports.handler = async (event, context) => {
  // Set CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  }

  // Handle preflight requests
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    }
  }

  try {
    console.log("[v0] Starting funding fees fetch...")

    // Get Lighter data
    console.log("[v0] Fetching Lighter data...")
    const lighterData = await makeRequest("https://api.lighter.xyz/v1/funding/aggregated")
    const basesLighter = lighterData?.data?.map((item) => item.base) || []
    console.log(`[v0] Found ${basesLighter.length} assets from Lighter`)

    // Get Hyperliquid data
    console.log("[v0] Fetching Hyperliquid data...")
    const hyperliquidData = await makeRequest("https://api.hyperliquid.xyz/info")

    // Process Paradex data in batches
    console.log("[v0] Processing Paradex data in batches...")
    const paradexProcessor = async (base) => {
      try {
        const url = `https://api.prod.paradex.trade/v1/funding/data?market=${base}-USD-PERP`
        const data = await makeRequest(url)

        if (data && Array.isArray(data) && data.length > 0) {
          // Take the last element (most recent)
          const latest = data[data.length - 1]
          return {
            base,
            fundingRate: latest.funding_rate ? Number.parseFloat(latest.funding_rate) : null,
          }
        }
        return { base, fundingRate: null }
      } catch (error) {
        console.log(`[v0] Error fetching Paradex data for ${base}:`, error.message)
        return { base, fundingRate: null }
      }
    }

    const paradexResults = await processBatch(basesLighter, 10, paradexProcessor)
    const paradexData = {}

    paradexResults.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        const { base, fundingRate } = result.value
        if (fundingRate !== null) {
          paradexData[base] = fundingRate
        }
      }
    })

    console.log(`[v0] Processed ${Object.keys(paradexData).length} Paradex assets`)

    // Combine all data
    const combinedData = []
    const processedBases = new Set()

    // Process Lighter data
    lighterData?.data?.forEach((item) => {
      if (!processedBases.has(item.base)) {
        combinedData.push({
          asset: item.base,
          hyperliquid: null,
          lighter: Number.parseFloat(item.funding_rate) || 0,
          paradex: paradexData[item.base] || null,
        })
        processedBases.add(item.base)
      }
    })

    // Add Hyperliquid data
    if (hyperliquidData?.universe) {
      hyperliquidData.universe.forEach((item) => {
        const existing = combinedData.find((d) => d.asset === item.name)
        if (existing) {
          existing.hyperliquid = Number.parseFloat(item.funding) || 0
        } else if (!processedBases.has(item.name)) {
          combinedData.push({
            asset: item.name,
            hyperliquid: Number.parseFloat(item.funding) || 0,
            lighter: null,
            paradex: paradexData[item.name] || null,
          })
          processedBases.add(item.name)
        }
      })
    }

    // Sort by asset name
    combinedData.sort((a, b) => a.asset.localeCompare(b.asset))

    const formattedData = {}
    combinedData.forEach((item) => {
      formattedData[item.asset] = {
        Hyperliquid: item.hyperliquid,
        Lighter: item.lighter,
        Paradex: item.paradex,
      }
    })

    console.log(`[v0] Successfully collected funding data for ${combinedData.length} assets`)

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: formattedData,
        timestamp: new Date().toISOString(),
        totalAssets: combinedData.length,
      }),
    }
  } catch (error) {
    console.error("[v0] Error in funding fees function:", error)

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    }
  }
}
