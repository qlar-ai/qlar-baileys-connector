import { exec } from 'child_process'

// Opens the connector's local GUI. On Windows we try Edge's `--app` mode first,
// which drops the address bar/tabs so it reads as a real window instead of a
// browser tab (Edge ships with every Windows 10/11 install, so no extra
// dependency). Falls back to the OS default browser everywhere else.
export function openInBrowser(url: string): void {
  if (process.platform === 'win32') {
    exec(`start msedge --app=${url}`, (err) => {
      if (err) exec(`start ${url}`)
    })
    return
  }

  if (process.platform === 'darwin') {
    exec(`open ${url}`)
    return
  }

  exec(`xdg-open ${url}`)
}
