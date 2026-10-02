# ADR-0007: Dynamic GPU scheduling for shared inference

Status: proposed

## Problem

Kubernetes allocates GPUs as whole, indivisible units. Each inference service requests `nvidia.com/gpu: 1`, so the
scheduler gives every service an entire A100 even though each one uses about 12% of it. All 8 GPUs are allocated
while most of their capacity is idle, and the training job that needs 2 GPUs stays Pending.

## Decision

Schedule inference GPUs dynamically instead of one whole GPU per service:

1. Enable time-slicing in the device plugin (`deploy/time-slicing-config.yaml`), advertising each GPU as 4 replicas,
   so several inference pods can share one GPU.
2. Place inference services with the GPU packer (`src/scheduler/gpu_packer.py`), which packs services onto GPUs by their
   measured utilisation and memory, two services per GPU at most.
3. Keep MIG partitions as the option for services that need memory isolation.

## Consequences

The 8 inference services fit on 4 GPUs, which frees 4 GPUs for training, so the fine-tuning job can start.
Time-slicing gives no memory isolation between pods that share a GPU, which is why the packer also checks memory.
