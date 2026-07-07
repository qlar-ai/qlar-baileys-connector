// Baked in as a string (not read from disk at runtime) so the packaged exe
// doesn't depend on pkg's asset-embedding path resolution — see the pkg
// "File ... was not included into executable" failure this replaced.
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pusaka Connector</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #111318;
    color: #eee;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    margin: 0;
  }
  h1 {
    font-size: 1rem;
    font-weight: 600;
    color: #888;
    letter-spacing: .04em;
    text-transform: uppercase;
    margin: 0 0 1.2rem;
  }
  .status {
    font-weight: 700;
    font-size: 1.6rem;
    letter-spacing: .05em;
    margin-bottom: 1.5rem;
  }
  .status.connected { color: #22c55e; }
  .status.disconnected { color: #ef4444; }
  #codeWrap { margin-bottom: 1rem; display: none; }
  input {
    padding: .6rem .8rem;
    font-size: 1rem;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1c1f26;
    color: #eee;
    width: 240px;
    text-align: center;
  }
  input:focus { outline: 1px solid #666; }
  .error {
    color: #ef4444;
    font-size: .85rem;
    min-height: 1.1rem;
    margin-bottom: .8rem;
  }
  button {
    padding: .6rem 1.4rem;
    font-size: .95rem;
    font-weight: 600;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    margin: .3rem;
  }
  button:disabled { background: #444 !important; color: #999 !important; cursor: not-allowed; }
  #connectBtn { background: #22c55e; color: #0a0a0a; }
  #logoutBtn { background: #ef4444; color: #fff; }
  #shutdownBtn { background: #2a2d35; color: #eee; }
</style>
</head>
<body>
  <h1>Pusaka Connector</h1>
  <div id="status" class="status disconnected">NOT CONNECTED</div>

  <div id="codeWrap">
    <input id="code" placeholder="Pairing code dari CMS-Web" autocomplete="off" />
  </div>
  <div id="error" class="error"></div>

  <div>
    <button id="connectBtn">Connect</button>
    <button id="logoutBtn">Logout</button>
    <button id="shutdownBtn">Shutdown</button>
  </div>

<script>
  const statusEl = document.getElementById('status')
  const connectBtn = document.getElementById('connectBtn')
  const logoutBtn = document.getElementById('logoutBtn')
  const shutdownBtn = document.getElementById('shutdownBtn')
  const codeWrap = document.getElementById('codeWrap')
  const codeInput = document.getElementById('code')
  const errorEl = document.getElementById('error')

  function setStatus(status) {
    const connected = status === 'connected'
    statusEl.textContent = connected ? 'CONNECTED' : 'NOT CONNECTED'
    statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected')
  }

  function showCodeInput(show) {
    codeWrap.style.display = show ? 'block' : 'none'
  }

  async function init() {
    const res = await fetch('/api/status')
    const data = await res.json()
    setStatus(data.status)
    showCodeInput(!data.hasSession)
  }

  connectBtn.addEventListener('click', async () => {
    errorEl.textContent = ''
    connectBtn.disabled = true
    const code = codeInput.value.trim()
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code || undefined }),
    })
    if (!res.ok) {
      connectBtn.disabled = false
      const data = await res.json().catch(() => ({}))
      errorEl.textContent = data.error ?? 'Gagal memulai koneksi.'
    }
  })

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true
    await fetch('/api/clear-session', { method: 'POST' })
    logoutBtn.disabled = false
  })

  shutdownBtn.addEventListener('click', async () => {
    shutdownBtn.disabled = true
    connectBtn.disabled = true
    logoutBtn.disabled = true
    statusEl.textContent = 'SHUTTING DOWN'
    statusEl.className = 'status disconnected'
    await fetch('/api/shutdown', { method: 'POST' }).catch(() => {})
  })

  const events = new EventSource('/api/events')
  events.addEventListener('status', (e) => setStatus(JSON.parse(e.data).status))
  events.addEventListener('error', (e) => {
    errorEl.textContent = JSON.parse(e.data).message
    connectBtn.disabled = false
  })
  events.addEventListener('sessionCleared', () => {
    setStatus('disconnected')
    showCodeInput(true)
    codeInput.value = ''
    connectBtn.disabled = false
  })

  init()
</script>
</body>
</html>
`
