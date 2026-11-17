"""Builder-hosted game and same-origin API. Run locally with --demo for memory stats."""

import argparse
import atexit
import json
import logging
import mimetypes
import os
import re
import threading
import time
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from server.store import BlobStore, MemoryStore, TableStore
from server.telemetry import Telemetry

LOGGER = logging.getLogger("ocean")
ROOT = Path(__file__).resolve().parent.parent
PUBLIC = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/game.js": "game.js",
    "/stats.js": "stats.js",
    "/how-its-built.html": "how-its-built.html",
    "/assets/app-service-builder.svg": "assets/app-service-builder.svg",
}


class Application:
    def __init__(self, store=None, telemetry=None):
        self.store = store
        self.telemetry = telemetry or Telemetry()
        self.cache = None
        self.cached_at = 0
        self.cache_lock = threading.Lock()
        self.cleanup_at = 0
        self.cleanup_lock = threading.Lock()

    def stats(self):
        with self.cache_lock:
            now = time.monotonic()
            if self.cache is None or now - self.cached_at >= 3:
                self.cache = {
                    **self.store.snapshot(),
                    "storage": self.store.kind,
                    "telemetry": "configured" if self.telemetry.configured else "not-configured",
                }
                self.cached_at = now
            return self.cache

    def cleanup(self):
        if time.monotonic() - self.cleanup_at < 600 or not self.cleanup_lock.acquire(blocking=False):
            return
        try:
            self.store.cleanup()
            self.cleanup_at = time.monotonic()
        finally:
            self.cleanup_lock.release()

    def route(self, env):
        method, path = env["REQUEST_METHOD"], env.get("PATH_INFO", "/")
        if method in ("GET", "HEAD") and path in PUBLIC:
            file = ROOT / PUBLIC[path]
            body = file.read_bytes()
            content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            return 200, body, content_type
        if method == "GET" and path == "/api/health":
            # Reachability, not a claim that Azure permissions or ingestion work.
            return 200, {"status": "ok", "statsConfigured": self.store is not None}, None
        if path not in ("/api/stats", "/api/presence"):
            return 404, {"error": "Not found"}, None
        if (path == "/api/stats" and method != "GET") or (path == "/api/presence" and method != "POST"):
            return 405, {"error": "Method not allowed"}, None
        if self.store is None:
            return 503, {"error": "Shared stats are not configured"}, None
        if path == "/api/stats":
            self.cleanup()
            return 200, self.stats(), None
        # No CORS permissions are sent. Cross-origin browser writes are rejected too.
        if env.get("HTTP_SEC_FETCH_SITE") == "cross-site":
            return 403, {"error": "Same-origin requests only"}, None
        origin = env.get("HTTP_ORIGIN")
        if origin and urlsplit(origin).netloc != env.get("HTTP_HOST"):
            return 403, {"error": "Same-origin requests only"}, None
        if env.get("CONTENT_TYPE", "").split(";")[0].strip() != "application/json":
            return 415, {"error": "Use application/json"}, None
        length = env.get("CONTENT_LENGTH", "")
        if not length.isdecimal() or not 1 <= int(length) <= 256:
            return 413, {"error": "Expected a JSON body of at most 256 bytes"}, None
        try:
            value = json.loads(env["wsgi.input"].read(int(length)))
        except (ValueError, UnicodeDecodeError):
            return 400, {"error": "Invalid JSON"}, None
        if not isinstance(value, dict) or set(value) != {"sessionId", "playing"}:
            return 400, {"error": "Expected sessionId and playing"}, None
        session_id = value["sessionId"]
        if not isinstance(session_id, str) or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", session_id
        ) or type(value["playing"]) is not bool:
            return 400, {"error": "Expected a random UUID v4 and boolean playing"}, None
        created = self.store.presence(session_id, value["playing"])
        if created:
            self.telemetry.adventure()
        return 200, {"accepted": True}, None

    def __call__(self, env, start_response):
        started = time.monotonic()
        try:
            code, body, content_type = self.route(env)
        except Exception as error:
            # Never log identifiers, request bodies, credentials, or raw SDK errors.
            LOGGER.error("Request failed: type=%s status=%s", type(error).__name__, getattr(error, "status_code", None))
            code, body, content_type = 503, {"error": "Shared stats temporarily unavailable"}, None
        if content_type is None:
            body = json.dumps(body, separators=(",", ":")).encode()
            content_type = "application/json"
        headers = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store" if env.get("PATH_INFO", "").startswith("/api/") else "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "no-referrer"),
            ("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; "
             "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"),
            ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
        ]
        from http import HTTPStatus
        start_response(f"{code} {HTTPStatus(code).phrase}", headers)
        if env.get("PATH_INFO", "").startswith("/api/"):
            self.telemetry.request(code, (time.monotonic() - started) * 1000)
        return [b"" if env["REQUEST_METHOD"] == "HEAD" else body]


def create_application():
    mode = os.environ.get("STATS_STORE", "disabled")
    if mode not in ("disabled", "memory", "azure", "azure-blob"):
        raise ValueError("STATS_STORE must be disabled, memory, azure, or azure-blob")
    credential = None
    if mode in ("azure", "azure-blob") or os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        from azure.identity import ManagedIdentityCredential
        client_id = os.environ.get("AZURE_CLIENT_ID")
        credential = ManagedIdentityCredential(client_id=client_id) if client_id else ManagedIdentityCredential()
        atexit.register(credential.close)
    if mode == "memory":
        LOGGER.warning("LOCAL DEMO: in-memory counts are not shared or durable")
        store = MemoryStore()
    elif mode == "azure-blob":
        from azure.storage.blob import BlobServiceClient
        endpoint = os.environ["AZURE_STORAGE_ACCOUNT_URL"]
        parsed = urlsplit(endpoint)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment
                or parsed.username or parsed.path not in ("", "/")):
            raise ValueError("Use an HTTPS Blob account endpoint without credentials or query parameters")
        container = os.environ["AZURE_STORAGE_CONTAINER"]
        if not container:
            raise ValueError("AZURE_STORAGE_CONTAINER must not be empty")
        service = BlobServiceClient(
            account_url=endpoint, credential=credential, retry_total=2, connection_timeout=3, read_timeout=5,
        )
        atexit.register(service.close)
        store = BlobStore(service.get_blob_client(container=container, blob="ocean/stats.json"))
    elif mode == "azure":
        from azure.data.tables import TableClient
        endpoint = os.environ["AZURE_STORAGE_TABLE_ENDPOINT"]
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Use an HTTPS Table endpoint without credentials or query parameters")
        client = TableClient(
            endpoint=endpoint, table_name=os.environ.get("AZURE_STORAGE_TABLE_NAME", "OceanStats"),
            credential=credential, retry_total=2, connection_timeout=3, read_timeout=5,
        )
        atexit.register(client.close)
        store = TableStore(client)
    else:
        LOGGER.warning("Shared stats disabled until STATS_STORE is configured")
        store = None
    telemetry = Telemetry(os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"), credential)
    atexit.register(telemetry.close)
    return Application(store, telemetry)


class LocalServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class PrivateRequestHandler(WSGIRequestHandler):
    def log_message(self, format_string, *args):
        # wsgiref's default access log contains visitor IP addresses and URLs.
        pass


application = None
if __name__ != "__main__":
    application = create_application()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Explicitly enable temporary local counters")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if args.demo:
        os.environ["STATS_STORE"] = "memory"
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    app = create_application()
    print(f"Ocean ready at http://localhost:{args.port}", flush=True)
    with make_server("127.0.0.1", args.port, app, LocalServer, PrivateRequestHandler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
