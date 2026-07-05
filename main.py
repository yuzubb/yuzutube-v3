"""
YuzuTube 統合サーバー（これ1つで画面もAPIも配信）
起動:  python main.py   （ブラウザで http://localhost:8000 ）
依存:  yt-dlp httpx innertube（Rustビルド不要）
"""
import asyncio, json, os, threading, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

import httpx
import youtube as yt
from cache import TwoTierCache, TTLDict

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
PORT = int(os.getenv("YUZU_PORT", "8000"))
CACHE_DIR = os.getenv("YUZU_CACHE_DIR", os.path.join(HERE, "cache"))
CACHE_TTL = int(os.getenv("YUZU_CACHE_TTL", str(7 * 60 * 60)))

meta = TwoTierCache(CACHE_DIR, CACHE_TTL)
stream_urls = TTLDict(ttl=5 * 60 * 60)

LOOP = asyncio.new_event_loop()
threading.Thread(target=lambda: (asyncio.set_event_loop(LOOP), LOOP.run_forever()), daemon=True).start()
def run_async(c): return asyncio.run_coroutine_threadsafe(c, LOOP).result()
def cached(k, f): return run_async(meta.get_or_set(k, f))

# URL -> 配信するHTMLファイル
PAGES = {"/": "index.html", "/watch": "watch.html", "/results": "search.html",
         "/comments": "comment.html", "/playlist": "playlist.html"}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def _json(self, obj, status=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self._cors(); self.end_headers(); self.wfile.write(b)

    def _file(self, name):
        p = os.path.join(PUBLIC, name)
        if not os.path.isfile(p):
            return self._json({"error": "not_found"}, 404)
        ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
        with open(p, "rb") as f:
            b = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204); self._cors()
        self.send_header("Content-Length", "0"); self.end_headers()

    def do_GET(self):
        u = urlparse(self.path); path = u.path
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if path.startswith("/api/"):
                return self.api(path, q)
            # 画面
            if path in PAGES:
                return self._file(PAGES[path])
            if path.startswith("/channel/") or path.startswith("/@"):
                return self._file("channel.html")
            # 静的（common.js / style.css など）
            name = path.lstrip("/")
            if name and ".." not in name and os.path.isfile(os.path.join(PUBLIC, name)):
                return self._file(name)
            return self._file("index.html")
        except BrokenPipeError:
            pass
        except Exception as e:
            try: self._json({"error": "server_error", "detail": str(e)}, 500)
            except Exception: pass

    def api(self, path, q):
        if path == "/api/health":
            h = yt.health(); h["ok"] = True; return self._json(h)
        if path == "/api/cache/clear":
            return self._json({"cleared": meta.clear()})
        if path == "/api/suggest":
            return self._json({"suggestions": run_async(yt.suggest(q.get("q", "")))})
        if path == "/api/trending":
            c = q.get("continuation")
            return self._json(cached(f"trending:{c or 'f'}", lambda: yt.trending(c)))
        if path == "/api/search":
            query = q.get("q", ""); c = q.get("continuation")
            if not query and not c: return self._json({"results": [], "continuation": None})
            return self._json(cached(f"search:{query}:{c or 'f'}", lambda: yt.search(query, c)))
        if path.startswith("/api/video/"):
            v = path[11:]; return self._json(cached(f"video:{v}", lambda: yt.video(v)))
        if path.startswith("/api/related/"):
            v = path[13:]; return self._json(cached(f"related:{v}", lambda: yt.related(v)))
        if path.startswith("/api/comments/"):
            v = path[14:]; return self._json(cached(f"comments:{v}", lambda: yt.comments(v)))
        if path.startswith("/api/channel/"):
            i = unquote(path[13:]); return self._json(cached(f"channel:{i}", lambda: yt.channel(i)))
        if path.startswith("/api/playlist/"):
            i = unquote(path[14:]); return self._json(cached(f"playlist:{i}", lambda: yt.playlist(i)))
        if path.startswith("/api/stream/"):
            return self.stream(path[12:], q.get("itag"))
        return self._json({"error": "not_found"}, 404)

    def stream(self, vid, itag):
        key = f"{vid}:{itag or 'best'}"
        def resolve(force):
            if not force:
                c = stream_urls.get(key)
                if c: return c
            url, ext = run_async(yt.resolve_stream(vid, itag))
            if url: stream_urls.set(key, (url, ext))
            return (url, ext)
        real = (resolve(False) or (None,))[0]
        if not real: return self._json({"error": "stream_not_found"}, 404)
        fwd = {}
        if self.headers.get("Range"): fwd["Range"] = self.headers["Range"]
        with httpx.Client(timeout=None, follow_redirects=True) as cl:
            with cl.stream("GET", real, headers=fwd) as up:
                if up.status_code in (403, 410):
                    stream_urls.delete(key)
                    real = (resolve(True) or (None,))[0]
                    if not real: return self._json({"error": "stream_not_found"}, 404)
                    with cl.stream("GET", real, headers=fwd) as up2:
                        return self._pipe(up2)
                return self._pipe(up)

    def _pipe(self, up):
        self.send_response(up.status_code)
        for h in ("content-type", "content-length", "content-range", "accept-ranges"):
            if h in up.headers: self.send_header(h, up.headers[h])
        self.send_header("Accept-Ranges", "bytes"); self._cors(); self.end_headers()
        try:
            for chunk in up.iter_bytes(65536): self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError): pass


if __name__ == "__main__":
    print(f"YuzuTube -> http://localhost:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
