"""Opt-in aggregate metrics only. No automatic request or browser instrumentation."""

class Telemetry:
    def __init__(self, connection_string=None, credential=None):
        self.configured = bool(connection_string)
        self.provider = None
        if not self.configured:
            return
        from azure.monitor.opentelemetry.exporter import AzureMonitorMetricExporter
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource

        exporter = AzureMonitorMetricExporter(
            connection_string=connection_string,
            credential=credential,
            disable_offline_storage=True,
        )
        self.provider = MeterProvider(
            resource=Resource.create({"service.name": "little-ocean"}),
            metric_readers=[PeriodicExportingMetricReader(exporter, export_interval_millis=60000)],
        )
        meter = self.provider.get_meter("ocean")
        self.requests = meter.create_counter("ocean.api.requests", unit="1")
        self.duration = meter.create_histogram("ocean.api.duration", unit="ms")
        self.adventures = meter.create_counter("ocean.adventures.started", unit="1")

    def request(self, status_code, elapsed_ms):
        if self.configured:
            attributes = {"status_code": status_code}
            self.requests.add(1, attributes)
            self.duration.record(elapsed_ms, attributes)

    def adventure(self):
        if self.configured:
            self.adventures.add(1)

    def close(self):
        if self.provider:
            self.provider.shutdown()
