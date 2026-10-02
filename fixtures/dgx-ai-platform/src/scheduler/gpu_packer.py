"""Prototype GPU packer for ADR-0007: place inference services on shared GPUs by measured use.

Today Kubernetes gives each service one whole GPU (whole_gpu_allocation). The packer instead places services on as few
GPUs as their measured utilisation and memory allow, so whole GPUs come free for training jobs.
"""
from dataclasses import dataclass, field

GPU_MEMORY_GB = 80
MAX_SERVICES_PER_GPU = 2
UTILISATION_HEADROOM = 0.7


@dataclass
class Service:
    name: str
    utilisation: float  # average share of one GPU, 0..1
    memory_gb: float


@dataclass
class Gpu:
    index: int
    services: list = field(default_factory=list)

    def load(self):
        return sum(s.utilisation for s in self.services)

    def memory(self):
        return sum(s.memory_gb for s in self.services)

    def fits(self, service):
        return (
            len(self.services) < MAX_SERVICES_PER_GPU
            and self.load() + service.utilisation <= UTILISATION_HEADROOM
            and self.memory() + service.memory_gb <= GPU_MEMORY_GB
        )


def whole_gpu_allocation(services, gpu_count):
    """What Kubernetes does today: one whole GPU per service, whatever the service uses."""
    if len(services) > gpu_count:
        raise RuntimeError("Insufficient nvidia.com/gpu")
    return [Gpu(i, [s]) for i, s in enumerate(services)]


def pack_services(services, gpu_count):
    """First-fit decreasing by utilisation: busiest services first, each on the first GPU it fits."""
    gpus = [Gpu(i) for i in range(gpu_count)]
    for service in sorted(services, key=lambda s: s.utilisation, reverse=True):
        target = next((g for g in gpus if g.fits(service)), None)
        if target is None:
            raise RuntimeError(f"No GPU can take {service.name}")
        target.services.append(service)
    return gpus


def free_gpus(gpus):
    """GPUs with nothing placed on them: capacity a training job can use."""
    return [g.index for g in gpus if not g.services]
