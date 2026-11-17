# little ocean on App Service Builder

The browser game still runs by opening `index.html`. Shared statistics need the
included Python API. Nothing has been provisioned or deployed by these files.

## Local showcase

Run `python -m server.app --demo` from this folder, then open
`http://localhost:8080`. This uses explicitly labeled in-memory counters, not Azure.
Multiple tabs share them; restarting the server clears them. No packages are
needed for this local mode. Without `--demo`, unconfigured shared stats return 503.

## Azure setup

Use an App Service Builder development/test app. Builder is in preview.
The checked-in `builder.yaml` runs the game and API together on Python 3.13,
using Gunicorn on port 8080. Only an explicit allowlist of browser assets is
served; server source, configuration, and dependency files are not public.

1. Provision an Azure Storage account with a private Blob container and an
   Application Insights resource. Builder does not create these dependencies.
2. Assign a system-managed identity to the Builder app.
3. Grant it **Storage Blob Data Contributor** at the narrowest applicable container
   scope, and **Monitoring Metrics Publisher** on Application Insights.
   Ensure both destinations are reachable from the app.
4. Configure server-side Builder runtime variables:

   | Variable | Value |
   | --- | --- |
   | `STATS_STORE` | `azure-blob` |
   | `AZURE_STORAGE_ACCOUNT_URL` | Your storage account's HTTPS **Blob** endpoint |
   | `AZURE_STORAGE_CONTAINER` | Your private Blob container name |
   | `APPLICATIONINSIGHTS_CONNECTION_STRING` | Your Application Insights connection string |

   For a user-assigned identity instead, attach it, grant the same destination
   permissions, and set `AZURE_CLIENT_ID` to its client ID. No account keys are
   needed. Never put credentials or runtime configuration in browser files.
5. Upload source with `builder.yaml` at the archive root, or connect a repository.
   Include the game files, `assets`, `server` (excluding bytecode), and
   `requirements.txt`. Exclude virtual environments, ZIPs, credentials, caches,
   and local logs. Follow Builder's current deployment documentation.
6. Deploy only after selecting the intended app, subscription, and source.

### Connection support

The `storageBlob` named connection can supply `AZURE_STORAGE_ACCOUNT_URL` and
`AZURE_STORAGE_CONTAINER` to the Blob SDK. Configure the app identity and its
container-scoped write permission separately, and avoid duplicate variable names.
Application Insights named-connection delivery is under construction; configure
its connection string as a server-side variable unless that path is available
and verified. Both services require the app's SDK and managed identity; they
are not Connector Namespace actions. Saving a connection does not prove access.

Existing `STATS_STORE=azure` deployments continue to use Table Storage with their
existing settings. Switching to `azure-blob` starts a separate counter: Table
data is not deleted or automatically migrated. Plan a migration before switching
if existing totals must be preserved.

## Verify the deployed app

- `/api/health` checks process reachability only.
- `/api/stats` must return 200 and `"storage":"azure-blob"`. A storage outage
  returns 503; there is no memory fallback in Azure mode.
- Start an adventure in each of two tabs. Within a refresh cycle both contribute
  to Playing now. Pause one; its lease is released. Abrupt disconnects expire
  within 90 seconds, plus the 3-second snapshot cache.
- Restarting the app must preserve Adventures started.
- In Application Insights Logs, check `customMetrics` (or `AppMetrics` in the
  workspace) for `ocean.api.requests`, `ocean.api.duration`, and
  `ocean.adventures.started` after traffic and export propagation. The exporter
  runs every 60 seconds. Configured does not mean ingestion has been verified.

## Counting and privacy

Counts are anonymous adventures, **not unique humans** and not abuse-proof
analytics. Every new adventure gets a random UUID in tab memory. Start retries
are deduplicated in the stats blob; the counter and lease are updated together
using an ETag-conditional write. Heartbeats
refresh a 90-second lease every 20 seconds while actively playing. Pausing,
finishing, or hiding the game releases presence. The footer polls every 15 seconds.

The service retains an aggregate total and random adventure IDs with timestamps.
Inactive records become eligible for deletion after 24 hours, with opportunistic
cleanup on stats requests at most every 10 minutes per worker. A dormant tab
resuming after its deduplication record was removed may register as another
adventure. The live count is an estimate.

The demo stores all counts and leases in one Blob. Each heartbeat reads and
rewrites it; contention, Blob size and request costs grow with usage. Conflicting
writes are retried and return an error if they do not settle. This design is for
a small showcase, not a high-traffic deployment.

No player names, emails, scores, IPs, user agents, URLs, or adventure IDs are
exported by the application to telemetry. Only manually instrumented aggregate
API metrics are enabled; exporter disk buffering is disabled. Browser storage,
cookies, automatic request instrumentation, and browser telemetry are not used.
The local server suppresses access logging and Gunicorn access logs are off by
default. Azure infrastructure can maintain separate logs: review those policies,
retention, applicable child-privacy requirements, and public-endpoint abuse/rate
controls before a public launch. No production readiness is implied.

## Local checks

The Azure SDKs are backend-only dependencies. In an isolated environment, install
`requirements.txt`, then run `python -m unittest server.test_app`.
The tests cover API validation, presence lifecycle, failure behavior, retention,
and concurrent transaction/ETag behavior using fake Blob and Table clients. They do not prove
Azure permissions, named-connection delivery, or telemetry ingestion.

References:

- https://builder.appservice.azure.com/docs/
- https://builder.appservice.azure.com/docs/guides/connect-to-services/
- https://builder.appservice.azure.com/docs/guides/managed-identity/
- https://builder.appservice.azure.com/docs/tutorials/blob-storage/
- https://builder.appservice.azure.com/docs/tutorials/application-insights/
- https://builder.appservice.azure.com/docs/guides/deploy-zip-source/
