import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { fetchPublicImage, isPrivateAddress } from './safeImage'

const PUBLIC_IP = '93.184.216.34'
const png = Buffer.from('89504e470d0a1a0a', 'hex')

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

async function withServer(handler: Handler, run: (port: number) => Promise<void>) {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await run((server.address() as AddressInfo).port)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

// Resolve every name to a "public" address, then dial the local server instead (test seam).
const publicLookup = async () => [PUBLIC_IP]
const dial = () => '127.0.0.1'
const base = { lookup: publicLookup, dialAddress: dial }

test('fetchPublicImage_PublicImage_ReturnsBufferAndKeepsHostHeader', async () => {
  let host = ''
  await withServer((req, res) => {
    host = String(req.headers.host)
    res.writeHead(200, { 'content-type': 'image/png; charset=binary' })
    res.end(png)
  }, async (port) => {
    const r = await fetchPublicImage(`http://charts.example.com:${port}/c.png?sv=abc&sig=x%2By`, base)
    assert.deepEqual(r.buffer, png)
    assert.equal(r.mimeType, 'image/png')
    assert.equal(host, `charts.example.com:${port}`)
  })
})

test('fetchPublicImage_FileScheme_Throws', async () => {
  await assert.rejects(fetchPublicImage('file:///etc/passwd', base), /scheme/i)
})

test('fetchPublicImage_DataScheme_Throws', async () => {
  await assert.rejects(fetchPublicImage('data:image/png;base64,AAAA', base), /scheme/i)
})

test('fetchPublicImage_PrivateResolved_Throws', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254']) {
    await assert.rejects(fetchPublicImage('http://x.example.com/a.png', { lookup: async () => [PUBLIC_IP, ip] }), /private/i)
  }
})

test('fetchPublicImage_PrivateIpLiteral_Throws', async () => {
  await assert.rejects(fetchPublicImage('http://169.254.169.254/latest/meta-data'), /private/i)
  await assert.rejects(fetchPublicImage('http://[::1]/a.png'), /private/i)
})

test('fetchPublicImage_RedirectToPrivate_Throws', async () => {
  await withServer((req, res) => {
    res.writeHead(302, { location: 'http://internal.example.com/secret.png' })
    res.end()
  }, async (port) => {
    const lookup = async (h: string) => [h === 'internal.example.com' ? '10.1.2.3' : PUBLIC_IP]
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a.png`, { ...base, lookup }), /private/i)
  })
})

test('fetchPublicImage_RedirectToPublic_Follows', async () => {
  await withServer((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { location: '/b.png' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(png)
  }, async (port) => {
    const r = await fetchPublicImage(`http://pub.example.com:${port}/a`, base)
    assert.equal(r.mimeType, 'image/jpeg')
  })
})

test('fetchPublicImage_TooManyRedirects_Throws', async () => {
  await withServer((req, res) => {
    res.writeHead(302, { location: '/again' }); res.end()
  }, async (port) => {
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a`, { ...base, maxRedirects: 3 }), /redirect/i)
  })
})

test('fetchPublicImage_OverSize_Throws', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' }) // no content-length: must be capped while streaming
    res.write(Buffer.alloc(600)); res.end(Buffer.alloc(600))
  }, async (port) => {
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a.png`, { ...base, maxBytes: 1000 }), /too large|size/i)
  })
})

test('fetchPublicImage_NonImageContentType_Throws', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>')
  }, async (port) => {
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a`, base), /content-type/i)
  })
})

test('fetchPublicImage_Non200_Throws', async () => {
  await withServer((req, res) => { res.writeHead(404, { 'content-type': 'image/png' }); res.end(png) }, async (port) => {
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a`, base), /404/)
  })
})

test('fetchPublicImage_Timeout_Throws', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.write(png) /* never ends */ }, async (port) => {
    await assert.rejects(fetchPublicImage(`http://pub.example.com:${port}/a.png`, { ...base, timeoutMs: 200 }), /timed out/i)
  })
})

test('isPrivateAddress_Table', () => {
  const priv = ['0.0.0.0', '10.0.0.1', '127.0.0.1', '127.255.0.3', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.0.1', 'not-an-ip']
  const pub = ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1',
    '2606:4700:4700::1111', '2001:db8::1', '::ffff:8.8.8.8', '::ffff:808:808']
  for (const ip of priv) assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of pub) assert.equal(isPrivateAddress(ip), false, ip)
})
