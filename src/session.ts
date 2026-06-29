import * as fs from 'fs'
import * as path from 'path'

const SESSION_FILE = path.join(process.cwd(), 'session.json')

export interface LocalSession {
  sessionId: string
  agentId: string
  hubUrl: string
}

export function loadSession(): LocalSession | null {
  if (!fs.existsSync(SESSION_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as LocalSession
  } catch {
    return null
  }
}

export function saveSession(data: LocalSession): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) fs.rmSync(SESSION_FILE)
}
