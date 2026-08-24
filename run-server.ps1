# Starts the multi-session Public connector server for LOCAL testing.
#
# HUB_URL must point to the SAME Messenger-BE that CMS-Web talks to
# (VITE_API_MESSENGER_SERVICE) — pairing codes are in-memory per process.
# Default below = local Messenger-BE on port 7193. Change if you use DEV.

$env:HUB_URL           = "https://localhost:7193/hubs/connector"
$env:CONNECTOR_DATA_DIR = "./data"
$env:PORT              = "8080"
$env:LOG_LEVEL         = "info"

Write-Host "Starting connector server -> HUB_URL=$($env:HUB_URL) PORT=$($env:PORT)" -ForegroundColor Cyan
npm run dev:server
