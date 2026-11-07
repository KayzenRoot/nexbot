# 9Router tunnel (WORK-035): keeps an SSH port-forward alive so the local
# NexBot stack can reach the 9Router on the VPS (loopback-only :20128).
# Reconnects every 5 s when the tunnel drops. Install at logon:
#   schtasks /create /tn "NexBot 9Router tunnel" /tr "pwsh -NoProfile -WindowStyle Hidden -File <path>\9router-tunnel.ps1" /sc onlogon /rl limited
$ErrorActionPreference = 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\9router_tunnel'
$remote = 'ubuntu@129.153.213.19'
$forward = '20128:127.0.0.1:20128'

while ($true) {
    Write-Host "$(Get-Date -Format s) opening tunnel..."
    & ssh @(
        '-i', $key,
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-N', '-L', $forward, $remote
    )
    Write-Host "$(Get-Date -Format s) tunnel exited ($LASTEXITCODE), retrying in 5s"
    Start-Sleep -Seconds 5
}
