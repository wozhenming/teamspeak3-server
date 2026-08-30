const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')

const tmpPath = require('os').tmpdir()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 图片代理：本容器拥有外网出口，music-bot 可经此抓取网易云封面，
// 规避其自身无外网或网易云外链防盗链的问题。
const IMG_HOSTS = ['.music.126.net', '.music.163.com']
function startImgProxy(port) {
  http
    .createServer((req, res) => {
      let u
      try {
        u = new URL(req.url, 'http://localhost')
      } catch (e) {
        res.writeHead(400)
        return res.end('bad url')
      }
      const target = u.searchParams.get('u')
      let t
      try {
        t = new URL(target)
      } catch (e) {
        res.writeHead(400)
        return res.end('bad target')
      }
      if (t.protocol !== 'http:' && t.protocol !== 'https:') {
        res.writeHead(400)
        return res.end('bad protocol')
      }
      if (!IMG_HOSTS.some((h) => t.hostname.endsWith(h))) {
        res.writeHead(400)
        return res.end('blocked host')
      }
      const lib = t.protocol === 'https:' ? https : http
      // 关键：转发 Range 头并透传 206/Content-Range，让下游(ffmpeg -ss 输入定位)能真正跳转，
      // 否则 seek 会被上游无视、音频从头开始
      const upstreamHeaders = {
        Referer: 'https://music.126.net/',
        'User-Agent': 'Mozilla/5.0',
      }
      if (req.headers.range) upstreamHeaders.Range = req.headers.range
      const r = lib.get(t, { headers: upstreamHeaders }, (up) => {
        const h = {
          'content-type': up.headers['content-type'] || 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        }
        if (up.headers['content-range']) h['content-range'] = up.headers['content-range']
        if (up.headers['accept-ranges']) h['accept-ranges'] = up.headers['accept-ranges']
        if (up.headers['content-length']) h['content-length'] = up.headers['content-length']
        res.writeHead(up.statusCode || 200, h)
        up.pipe(res)
      })
      r.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502)
          res.end('fetch error')
        }
      })
    })
    .listen(port, () => console.log('[img-proxy] listening on', port))
}

async function warmup() {
  const generateConfig = require('./generateConfig')
  const keyFile = path.resolve(tmpPath, 'xeapi_public_key')
  const tokenFile = path.resolve(tmpPath, 'anonymous_token')
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await generateConfig()
    } catch (error) {
      console.log('[start] warmup error:', error)
    }
    const keyReady =
      fs.existsSync(keyFile) && fs.statSync(keyFile).size > 0
    const tokenReady =
      fs.existsSync(tokenFile) && fs.statSync(tokenFile).size > 0
    if (keyReady && tokenReady) {
      console.log('[start] anonymous token & xeapi public key ready')
      return
    }
    await sleep(5000)
  }
  console.log('[start] warmup incomplete, starting server anyway')
}

async function main() {
  require('./main')
  warmup()
  require('./server').serveNcmApi({ checkVersion: false })
  startImgProxy(parseInt(process.env.IMG_PROXY_PORT || '3100', 10))
}

main()
