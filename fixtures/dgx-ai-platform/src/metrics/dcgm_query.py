"""Read per-GPU utilisation from the DCGM exporter's Prometheus metrics."""
import urllib.request

PROMETHEUS = "http://prometheus.monitoring:9090/api/v1/query"
UTIL_QUERY = "avg_over_time(DCGM_FI_DEV_GPU_UTIL{Hostname='dgx-01'}[14d])"


def gpu_utilisation():
    """Average utilisation of each GPU over 14 days, as a share of 1."""
    with urllib.request.urlopen(f"{PROMETHEUS}?query={UTIL_QUERY}") as r:
        import json
        data = json.load(r)
    return {int(x["metric"]["gpu"]): float(x["value"][1]) / 100 for x in data["data"]["result"]}
