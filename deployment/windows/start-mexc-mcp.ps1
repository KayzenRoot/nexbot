# Start the MEXC futures MCP server (Streamable HTTP on 127.0.0.1:4315).
#
# WHAT THIS IS
#   mcp/mexc-server.mjs is a standalone MCP server that exposes MEXC futures
#   market data as tools for NexBot dots:
#     mexc_ticker, mexc_klines, mexc_orderbook, mexc_funding  - public, no key
#     mexc_positions, mexc_balance                            - private, need key
#
# HOW TO RUN (manual)
#   node mcp/mexc-server.mjs
#
# ENV VARS
#   MEXC_MCP_PORT    port to listen on            (default 4315)
#   MEXC_API_KEY     MEXC API access key          (optional; enables private tools)
#   MEXC_API_SECRET  MEXC API secret key          (optional; enables private tools)
#   Create a key at https://www.mexc.com (user center > API management), enable
#   futures read permission, and bind it to 127.0.0.1 if possible. Public tools
#   work without any key.
#
# HOW TO CONNECT IN NEXBOT (Connections)
#   1. Keep this server running (e.g. via autostart below).
#   2. In the NexBot app open Connections and add an MCP server with URL:
#        http://127.0.0.1:4315/mcp
#   3. The six mexc_* tools become available to dots.
#
# The server binds to 127.0.0.1 only and never logs the key, secret or the
# computed request signature.

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

# Optional: place the key/secret in a .env.mexc-mcp file next to .env.local
# ("MEXC_API_KEY=...", "MEXC_API_SECRET=...") so the secret is not typed into
# shells. Environment variables already set win over the file.
$envFile = Join-Path $repo '.env.mexc-mcp'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*MEXC_([A-Z_]+)\s*=\s*(.+)\s*$') {
            $name = "MEXC_$($Matches[1])"
            if (-not [Environment]::GetEnvironmentVariable($name)) {
                Set-Item "Env:$name" $Matches[2]
            }
        }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node was not found on PATH. Install Node.js >= 24 first.'
}

Write-Host 'Starting MEXC futures MCP server on http://127.0.0.1:4315/mcp' -ForegroundColor Cyan
Write-Host 'Press Ctrl+C to stop it.' -ForegroundColor DarkGray
node mcp/mexc-server.mjs
