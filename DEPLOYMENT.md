# Deploy with Azure App Service Builder

The game runs locally on its own. Shared statistics and telemetry require the
Python API and Azure resources configured below.

## Local demo

```shell
python -m server.app --demo
```

Open <http://localhost:8080>. Demo counters are temporary and reset when the
server stops.

## Configure Builder

In App Service Builder, connect this repository or upload the app source with
[`builder.yaml`](builder.yaml) at its root. The manifest runs the game and API
together as a Python 3.13 web component.

Before deploying, prepare:

- A private Blob container and an Application Insights resource.
- A managed identity attached to the app, with **Storage Blob Data Contributor**
  on the container and **Monitoring Metrics Publisher** on Application Insights.
- The server-side runtime settings below:

| Variable | Value |
| --- | --- |
| `STATS_STORE` | `azure-blob` |
| `AZURE_STORAGE_ACCOUNT_URL` | HTTPS Blob endpoint |
| `AZURE_STORAGE_CONTAINER` | Existing private container name |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Application Insights connection string |
| `AZURE_CLIENT_ID` | User-assigned identity client ID; omit for system-assigned identity |

Builder's Blob connection can provide the storage endpoint and container.
Configure all settings server-side, never in browser code. After saving
configuration, deploy a new version so it reaches the running app.
Switching from Table Storage to Blob Storage starts a separate counter; existing
data is not migrated.

## Verify

- `/api/health` checks process reachability only.
- `/api/stats` should return HTTP 200 with `"storage":"azure-blob"`.
- Start an adventure and check that `adventuresStarted` increases.
- In the linked Log Analytics workspace, check `AppMetrics` for
  `ocean.api.requests`, `ocean.api.duration`, and
  `ocean.adventures.started`. Metrics export every 60 seconds; ingestion may
  take longer.

An active connection or a configured exporter does not by itself confirm data
flow. Verify storage writes and Application Insights ingestion separately.

## Privacy and tests

Statistics count adventures, not people. Random adventure IDs are kept
temporarily for presence and deduplication. The app exports aggregate API
metrics, not player details. Azure infrastructure may keep separate logs.

Run the backend tests with:

```shell
python -m pip install -r requirements.txt
python -m unittest server.test_app
```

These tests use fake storage clients; they do not verify Azure permissions or
telemetry ingestion.

For platform details, see the [Builder documentation](https://builder.appservice.azure.com/docs/),
[service connections](https://builder.appservice.azure.com/docs/guides/connect-to-services/),
and [managed identity](https://builder.appservice.azure.com/docs/guides/managed-identity/).
