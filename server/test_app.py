import io
import json
import os
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch
from wsgiref.util import setup_testing_defaults

from server.app import Application, create_application
from server.store import LEASE_SECONDS, BlobStore, MemoryStore, TableStore


class APIBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.now = 100000.0
        self.store = MemoryStore(lambda: self.now)
        self.app = Application(self.store)
        self.session = str(uuid.uuid4())

    def request(self, path, value=None, method=None, **headers):
        env = {}
        setup_testing_defaults(env)
        raw = json.dumps(value).encode() if value is not None else b""
        env.update({
            "PATH_INFO": path, "REQUEST_METHOD": method or ("POST" if value is not None else "GET"),
            "CONTENT_TYPE": "application/json", "CONTENT_LENGTH": str(len(raw)),
            "HTTP_HOST": "localhost:8080", "wsgi.input": io.BytesIO(raw),
            **headers,
        })
        result = {}

        def start_response(status, response_headers):
            result["status"] = int(status.split()[0])
            result["headers"] = dict(response_headers)

        body = b"".join(self.app(env, start_response))
        return result, body

    def test_retry_pause_resume_and_expired_presence_do_not_inflate_total(self):
        for _ in range(3):
            result, _ = self.request("/api/presence", {"sessionId": self.session, "playing": True})
            self.assertEqual(result["status"], 200)
        self.assertEqual(self.store.snapshot(), {"playingNow": 1, "adventuresStarted": 1})
        self.request("/api/presence", {"sessionId": self.session, "playing": False})
        self.assertEqual(self.store.snapshot()["playingNow"], 0)
        self.request("/api/presence", {"sessionId": self.session, "playing": True})
        self.now += LEASE_SECONDS + 1
        self.assertEqual(self.store.snapshot(), {"playingNow": 0, "adventuresStarted": 1})
        self.request("/api/presence", {"sessionId": self.session, "playing": True})
        self.assertEqual(self.store.snapshot(), {"playingNow": 1, "adventuresStarted": 1})

    def test_new_adventure_adds_one_and_pause_unknown_does_not(self):
        self.request("/api/presence", {"sessionId": self.session, "playing": False})
        self.assertEqual(self.store.total, 0)
        for _ in range(2):
            self.request("/api/presence", {"sessionId": str(uuid.uuid4()), "playing": True})
        self.assertEqual(self.store.snapshot(), {"playingNow": 2, "adventuresStarted": 2})

    def test_invalid_input_and_cross_site_writes_rejected(self):
        for value in ([], {"sessionId": "not-a-uuid", "playing": True},
                      {"sessionId": self.session, "playing": 1},
                      {"sessionId": self.session, "playing": True, "name": "unwanted"}):
            result, _ = self.request("/api/presence", value)
            self.assertEqual(result["status"], 400)
        result, _ = self.request("/api/presence", {"sessionId": self.session, "playing": True},
                                 HTTP_ORIGIN="https://another.example")
        self.assertEqual(result["status"], 403)
        self.assertEqual(self.store.total, 0)

    def test_stats_are_explicit_and_never_expose_identifiers(self):
        self.request("/api/presence", {"sessionId": self.session, "playing": True})
        result, body = self.request("/api/stats")
        data = json.loads(body)
        self.assertEqual(result["headers"]["Cache-Control"], "no-store")
        self.assertNotIn(self.session.encode(), body)
        self.assertEqual(data, {
            "playingNow": 1, "adventuresStarted": 1, "storage": "memory", "telemetry": "not-configured",
        })

    def test_missing_or_failed_storage_never_falls_back_to_zero(self):
        self.app.store = None
        result, _ = self.request("/api/stats")
        self.assertEqual(result["status"], 503)
        class FailedStore:
            def cleanup(self):
                raise ConnectionError("Do not expose sensitive details")
        self.app.store = FailedStore()
        with self.assertLogs("ocean", level="ERROR") as logs:
            result, body = self.request("/api/stats")
        self.assertEqual(result["status"], 503)
        self.assertNotIn(b"playingNow", body)
        self.assertNotIn("sensitive", str(logs.output))

    def test_only_allowlisted_assets_are_public(self):
        for path in ("/server/app.py", "/requirements.txt", "/builder.yaml", "/../server/app.py"):
            result, _ = self.request(path)
            self.assertEqual(result["status"], 404)
        result, body = self.request("/how-its-built.html")
        self.assertEqual(result["status"], 200)
        self.assertIn(b"App Service Builder", body)

    def test_retention_removes_old_leases_but_preserves_total(self):
        self.store.presence(self.session, True)
        self.now += 86401
        self.store.cleanup()
        self.assertEqual(self.store.leases, {})
        self.assertEqual(self.store.snapshot(), {"playingNow": 0, "adventuresStarted": 1})


class FakeBlob:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = None
        self.version = 0
        self.missing_container = False
        self.inject_conflict = False
        self.failure = None

    @staticmethod
    def error(kind, status, code):
        error = kind(message="Test blob error")
        error.status_code = status
        error.error_code = code
        return error

    def download_blob(self):
        from azure.core.exceptions import ResourceNotFoundError
        with self.lock:
            if self.missing_container:
                raise self.error(ResourceNotFoundError, 404, "ContainerNotFound")
            if self.data is None:
                raise self.error(ResourceNotFoundError, 404, "BlobNotFound")
            data = self.data
            return SimpleNamespace(readall=lambda: data, properties=SimpleNamespace(etag=str(self.version)))

    def upload_blob(self, data, *, overwrite, etag=None, **kwargs):
        from azure.core.exceptions import HttpResponseError, ResourceExistsError
        with self.lock:
            if self.failure:
                raise self.failure
            if not overwrite and self.data is not None:
                raise self.error(ResourceExistsError, 409, "BlobAlreadyExists")
            if overwrite and (self.inject_conflict or etag != str(self.version)):
                self.inject_conflict = False
                raise self.error(HttpResponseError, 412, "ConditionNotMet")
            self.version += 1
            self.data = data


class BlobBehaviorTests(unittest.TestCase):
    def test_builder_connection_variables_configure_blob_store(self):
        variables = {
            "STATS_STORE": "azure-blob",
            "AZURE_STORAGE_ACCOUNT_URL": "https://example.blob.core.windows.net",
            "AZURE_STORAGE_CONTAINER": "oceanstats",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": "",
        }
        with patch.dict(os.environ, variables), patch("azure.identity.ManagedIdentityCredential"):
            app = create_application()
            self.assertEqual(app.store.kind, "azure-blob")
            self.assertEqual(app.store.client.container_name, "oceanstats")

    def test_concurrent_retries_count_each_adventure_once(self):
        blob = FakeBlob()
        stores = [BlobStore(blob, lambda: 100000.0) for _ in range(3)]
        sessions = [str(uuid.uuid4()) for _ in range(10)]
        blob.inject_conflict = True
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(
                lambda pair: stores[pair[0] % 3].presence(pair[1], True),
                list(enumerate(sessions * 2)),
            ))
        self.assertEqual(stores[0].snapshot(), {"playingNow": 10, "adventuresStarted": 10})

    def test_pause_resume_and_cleanup_preserve_total(self):
        now = [100000.0]
        store = BlobStore(FakeBlob(), lambda: now[0])
        session = str(uuid.uuid4())
        self.assertFalse(store.presence(session, False))
        self.assertTrue(store.presence(session, True))
        self.assertFalse(store.presence(session, False))
        self.assertEqual(store.snapshot(), {"playingNow": 0, "adventuresStarted": 1})
        self.assertFalse(store.presence(session, True))
        now[0] += 86401
        store.cleanup()
        self.assertEqual(store.snapshot(), {"playingNow": 0, "adventuresStarted": 1})
        self.assertEqual(store.read()[0]["leases"], {})

    def test_missing_container_and_corrupt_data_are_not_empty_stats(self):
        from azure.core.exceptions import ResourceNotFoundError
        blob = FakeBlob()
        store = BlobStore(blob)
        blob.missing_container = True
        with self.assertRaises(ResourceNotFoundError):
            store.snapshot()
        blob.missing_container = False
        blob.data = b'{"total": 1, "leases": {"bad": [NaN, 0]}}'
        with self.assertRaises(ValueError):
            store.snapshot()

    def test_service_failure_propagates_instead_of_local_fallback(self):
        from azure.core.exceptions import HttpResponseError
        blob = FakeBlob()
        blob.failure = blob.error(HttpResponseError, 503, "ServerBusy")
        with self.assertRaises(HttpResponseError):
            BlobStore(blob).presence(str(uuid.uuid4()), True)


class Entity(dict):
    def __init__(self, value, version):
        super().__init__(value)
        self.metadata = {"etag": str(version)}


class FakeTable:
    """Atomic transaction/ETag model used by multiple TableStore instances."""
    def __init__(self):
        self.rows = {}
        self.lock = threading.Lock()
        self.version = 0
        self.inject_conflict = False

    def error(self, code):
        from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceNotFoundError
        cls = {404: ResourceNotFoundError, 409: ResourceExistsError}.get(code, HttpResponseError)
        error = cls(message="Test table error")
        error.status_code = code
        return error

    def get_entity(self, partition, row):
        with self.lock:
            if row not in self.rows:
                raise self.error(404)
            return Entity(self.rows[row], self.rows[row].metadata["etag"])

    def create_entity(self, entity):
        with self.lock:
            if entity["RowKey"] in self.rows:
                raise self.error(409)
            self.version += 1
            self.rows[entity["RowKey"]] = Entity(entity, self.version)

    def check_update(self, entity, etag):
        current = self.rows.get(entity["RowKey"])
        if current is None or current.metadata["etag"] != etag:
            raise self.error(412)

    def update_entity(self, entity, *, etag, **kwargs):
        with self.lock:
            self.check_update(entity, etag)
            self.version += 1
            self.rows[entity["RowKey"]] = Entity(entity, self.version)

    def submit_transaction(self, operations):
        with self.lock:
            if self.inject_conflict:
                self.inject_conflict = False
                raise self.error(412)
            _, total, options = operations[0]
            _, lease = operations[1]
            self.check_update(total, options["etag"])
            if lease["RowKey"] in self.rows:
                raise self.error(409)
            for value in (total, lease):
                self.version += 1
                self.rows[value["RowKey"]] = Entity(value, self.version)


class TableBehaviorTests(unittest.TestCase):
    def test_multiple_instances_and_retries_increment_once_per_adventure(self):
        table = FakeTable()
        stores = [TableStore(table) for _ in range(3)]
        sessions = [str(uuid.uuid4()) for _ in range(10)]
        table.inject_conflict = True
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(
                lambda pair: stores[pair[0] % 3].presence(pair[1], True),
                list(enumerate(sessions * 2)),
            ))
        self.assertEqual(table.rows["total"]["Count"], 10)
        self.assertEqual(len(table.rows), 11)

    def test_service_failure_propagates_instead_of_local_fallback(self):
        table = FakeTable()
        def fail(*args):
            raise table.error(503)
        table.submit_transaction = fail
        store = TableStore(table)
        with self.assertRaises(Exception) as context:
            store.presence(str(uuid.uuid4()), True)
        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(table.rows["total"]["Count"], 0)


if __name__ == "__main__":
    unittest.main()
