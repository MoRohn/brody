"""Minimal inference server used by every service: one model, loaded on the GPU the pod was given."""
import os

MODEL = os.environ.get("MODEL_NAME", "llm-chat")
DEVICE = "cuda:0"  # the one whole GPU Kubernetes allocated to this pod


def load_model(name=MODEL, device=DEVICE):
    """Load the model weights onto the pod's GPU."""
    return {"name": name, "device": device}


def handle(request, model):
    """Answer one request. Requests arrive a few per second, so the GPU is mostly idle between them."""
    return {"model": model["name"], "output": f"processed {len(request.get('input', ''))} characters"}
