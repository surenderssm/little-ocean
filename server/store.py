"""Anonymous adventure totals and expiring presence leases."""

import json
import math
import threading
import time
from datetime import datetime, timedelta, timezone

LEASE_SECONDS = 90
RETENTION_SECONDS = 86400
PARTITION = "ocean"


class StoreUnavailable(RuntimeError):
    pass


class MemoryStore:
    kind = "memory"

    def __init__(self, clock=time.time):
        self.clock = clock
        self.lock = threading.Lock()
        self.leases = {}
        self.total = 0

    def presence(self, session_id, playing):
        now = self.clock()
        with self.lock:
            existing = self.leases.get(session_id)
            created = existing is None and playing
            if created:
                self.total += 1
            if existing is not None or playing:
                self.leases[session_id] = (now + LEASE_SECONDS if playing else now, now)
            return created

    def snapshot(self):
        now = self.clock()
        with self.lock:
            return {
                "playingNow": sum(expiry > now for expiry, _ in self.leases.values()),
                "adventuresStarted": self.total,
            }

    def cleanup(self):
        cutoff = self.clock() - RETENTION_SECONDS
        with self.lock:
            self.leases = {key: value for key, value in self.leases.items() if value[1] > cutoff}


class BlobStore:
    kind = "azure-blob"

    def __init__(self, client, clock=time.time):
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceNotFoundError

        self.client = client
        self.clock = clock
        self.match = MatchConditions.IfNotModified
        self.http_error = HttpResponseError
        self.exists_error = ResourceExistsError
        self.not_found = ResourceNotFoundError

    def read(self):
        try:
            download = self.client.download_blob()
        except self.not_found as error:
            if getattr(error, "error_code", None) == "BlobNotFound":
                return {"total": 0, "leases": {}}, None
            raise
        state = json.loads(download.readall())
        if (not isinstance(state, dict) or set(state) != {"total", "leases"}
                or type(state["total"]) is not int or state["total"] < 0
                or not isinstance(state["leases"], dict)):
            raise ValueError("Invalid blob stats data")
        for key, lease in state["leases"].items():
            if (not isinstance(key, str) or not isinstance(lease, list) or len(lease) != 2
                    or any(type(value) not in (int, float) or not math.isfinite(value) for value in lease)):
                raise ValueError("Invalid blob presence data")
        return state, download.properties.etag

    def update(self, operation):
        for attempt in range(8):
            state, etag = self.read()
            changed, result = operation(state)
            if not changed:
                return result
            payload = json.dumps(state, separators=(",", ":"), allow_nan=False).encode("utf-8")
            try:
                if etag is None:
                    self.client.upload_blob(payload, overwrite=False)
                else:
                    self.client.upload_blob(payload, overwrite=True, etag=etag, match_condition=self.match)
                return result
            except self.http_error as error:
                if error.status_code != 412 and not (etag is None and isinstance(error, self.exists_error)):
                    raise
                time.sleep(min(0.01 * 2 ** attempt, 0.2))
        raise StoreUnavailable("Concurrent blob update did not settle")

    def presence(self, session_id, playing):
        def apply(state):
            now = self.clock()
            existing = state["leases"].get(session_id)
            if existing is None and not playing:
                return False, False
            created = existing is None
            if created:
                state["total"] += 1
            state["leases"][session_id] = [now + LEASE_SECONDS if playing else now, now]
            return True, created
        return self.update(apply)

    def snapshot(self):
        state, _ = self.read()
        now = self.clock()
        return {
            "playingNow": sum(expiry > now for expiry, _ in state["leases"].values()),
            "adventuresStarted": state["total"],
        }

    def cleanup(self):
        def apply(state):
            cutoff = self.clock() - RETENTION_SECONDS
            leases = {key: value for key, value in state["leases"].items() if value[1] > cutoff}
            changed = len(leases) != len(state["leases"])
            state["leases"] = leases
            return changed, None
        self.update(apply)


class TableStore:
    kind = "azure-table"

    def __init__(self, client, clock=lambda: datetime.now(timezone.utc)):
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceNotFoundError
        from azure.data.tables import UpdateMode

        self.client = client
        self.clock = clock
        self.match = MatchConditions.IfNotModified
        self.replace = UpdateMode.REPLACE
        self.http_error = HttpResponseError
        self.exists_error = ResourceExistsError
        self.not_found = ResourceNotFoundError

    def get(self, row):
        try:
            return self.client.get_entity(PARTITION, row)
        except self.not_found as error:
            # A missing table is a configuration error, not an empty ocean.
            if getattr(error, "error_code", None) == "TableNotFound":
                raise
            return None

    def presence(self, session_id, playing):
        row = "adventure-" + session_id
        for attempt in range(8):
            now = self.clock()
            lease = self.get(row)
            if lease is None and not playing:
                return False
            entity = {
                "PartitionKey": PARTITION,
                "RowKey": row,
                "ExpiresAt": now + timedelta(seconds=LEASE_SECONDS) if playing else now,
                "LastSeen": now,
            }
            try:
                if lease is not None:
                    self.client.update_entity(
                        entity, mode=self.replace, etag=lease.metadata["etag"], match_condition=self.match
                    )
                    return False
                total = self.get("total")
                if total is None:
                    try:
                        self.client.create_entity({
                            "PartitionKey": PARTITION, "RowKey": "total", "Count": 0,
                        })
                    except self.exists_error:
                        pass  # Another instance initialized this same counter.
                    continue
                # The increment and deduplication record commit together, or neither does.
                self.client.submit_transaction([
                    ("update", {
                        "PartitionKey": PARTITION, "RowKey": "total", "Count": total["Count"] + 1,
                    }, {"mode": self.replace, "etag": total.metadata["etag"], "match_condition": self.match}),
                    ("create", entity),
                ])
                return True
            except self.http_error as error:
                if error.status_code not in (409, 412):
                    raise
                time.sleep(min(0.01 * 2 ** attempt, 0.2))
        raise StoreUnavailable("Concurrent counter update did not settle")

    def snapshot(self):
        now = self.clock()
        leases = self.client.query_entities(
            "PartitionKey eq @partition and ExpiresAt gt @now",
            parameters={"partition": PARTITION, "now": now},
            select=["RowKey"],
        )
        playing = sum(1 for _ in leases)
        total = self.get("total")
        return {"playingNow": playing, "adventuresStarted": total["Count"] if total else 0}

    def cleanup(self):
        cutoff = self.clock() - timedelta(seconds=RETENTION_SECONDS)
        leases = self.client.query_entities(
            "PartitionKey eq @partition and LastSeen lt @cutoff",
            parameters={"partition": PARTITION, "cutoff": cutoff},
        )
        for entity in leases:
            try:
                self.client.delete_entity(
                    entity["PartitionKey"], entity["RowKey"],
                    etag=entity.metadata["etag"], match_condition=self.match,
                )
            except self.http_error as error:
                # A concurrent heartbeat must win over retention cleanup.
                if error.status_code not in (404, 412):
                    raise
