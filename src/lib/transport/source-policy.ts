import type { ProxyToOptions } from '../../server/proxy'

export const SOURCE_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

export const MANGADEX_USER_AGENT = 'kagi/1.0 (https://github.com/Jocseh07/kagi)'

export const sourceProxyPolicies: Readonly<Record<string, ProxyToOptions>> = {
  '/asurascans': { prefix: '/asurascans', target: 'https://api.asurascans.com', redirects: 'manual' },
  '/asuracdn': { prefix: '/asuracdn', target: 'https://cdn.asurascans.com', redirects: 'manual', assets: true },
  '/comick': { prefix: '/comick', target: 'https://comick.live', redirects: 'manual', browserHeaders: true, referer: 'https://comick.live/' },
  '/comickcdn': { prefix: '/comickcdn', target: 'https://meo.comick.pictures', hostPattern: /^[a-z0-9]+\.comick(new)?\.pictures$/, redirects: 'follow', referer: 'https://comick.live/', assets: true },
  '/fenrirealm': { prefix: '/fenrirealm', target: 'https://fenrirealm.com', redirects: 'follow', browserHeaders: true },
  '/flamecomics': { prefix: '/flamecomics', target: 'https://flamecomics.xyz', redirects: 'manual', browserHeaders: true },
  '/flamecdn': { prefix: '/flamecdn', target: 'https://cdn.flamecomics.xyz', redirects: 'follow', assets: true },
  '/mangadex': { prefix: '/mangadex', target: 'https://api.mangadex.org', redirects: 'follow', userAgent: MANGADEX_USER_AGENT },
  '/mdcovers': { prefix: '/mdcovers', target: 'https://uploads.mangadex.org', redirects: 'follow', userAgent: MANGADEX_USER_AGENT, assets: true },
  '/mdimage': { prefix: '/mdimage', target: 'https://mangadex.network', hostPattern: /^[a-z0-9-]+\.mangadex\.network$/, redirects: 'follow', userAgent: MANGADEX_USER_AGENT, assets: true },
  '/mangadot': { prefix: '/mangadot', target: 'https://mangadot.net', redirects: 'manual' },
  '/mangakatana': { prefix: '/mangakatana', target: 'https://mangakatana.com', redirects: 'manual', browserHeaders: true },
  '/katanacdn': { prefix: '/katanacdn', target: 'https://i1.mangakatana.com', hostPattern: /^i[0-9]*\.mangakatana\.com$/, redirects: 'follow', assets: true },
  '/mangaplus': { prefix: '/mangaplus', target: 'https://jumpg-webapi.tokyo-cdn.com', redirects: 'follow' },
  '/mangapluscdn': { prefix: '/mangapluscdn', target: 'https://mangaplus.shueisha.co.jp', hostPattern: /^[a-z0-9-]+\.tokyo-cdn\.com$/, redirects: 'follow', headerParams: { vw: 'Plus-Vw-Token' }, xorKeyParam: 'key', assets: true },
  '/novelfull': { prefix: '/novelfull', target: 'https://novelfull.com', redirects: 'follow', browserHeaders: true },
  '/novelmtl': { prefix: '/novelmtl', target: 'https://novelmtl.app', redirects: 'follow', browserHeaders: true },
  '/novelping': { prefix: '/novelping', target: 'https://novelping.com', redirects: 'follow', browserHeaders: true },
  '/thunderscans': { prefix: '/thunderscans', target: 'https://en-thunderscans.com', redirects: 'manual' },
  '/toonily': { prefix: '/toonily', target: 'https://toonily.com', redirects: 'manual', browserHeaders: true, cookies: { 'toonily-mature': '1' } },
  '/toonilycdn': { prefix: '/toonilycdn', target: 'https://data.tnlycdn.com', hostPattern: /^(data|static)\.tnlycdn\.com$/, redirects: 'follow', referer: 'https://toonily.com/', assets: true },
  '/webnovel': { prefix: '/webnovel', target: 'https://www.webnovel.com', redirects: 'follow', browserHeaders: true },
  '/webtoons': { prefix: '/webtoons', target: 'https://www.webtoons.com', redirects: 'follow', browserHeaders: true, cookies: { ageGatePass: 'true', locale: 'en', needGDPR: 'false' } },
  '/webtoonscdn': { prefix: '/webtoonscdn', target: 'https://webtoon-phinf.pstatic.net', hostPattern: /^[a-z-]+\.pstatic\.net$/, redirects: 'follow', referer: 'https://www.webtoons.com/', assets: true },
  '/weebcentral': { prefix: '/weebcentral', target: 'https://weebcentral.com', redirects: 'manual' },
  '/weebcdn': { prefix: '/weebcdn', target: 'https://temp.compsci88.com', redirects: 'follow', assets: true },
}
