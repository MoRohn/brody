# Lab AI platform

Several AI services for internal teams run on one shared NVIDIA DGX A100 machine, scheduled by Kubernetes.

- The DGX node `dgx-01` has 8 A100 GPUs with 80 GB of memory each (see `cluster/dgx-01-node.yaml`).
- Eight inference services run as Deployments in `deploy/inference-services.yaml`. Each one requests `nvidia.com/gpu: 1`.
- Researchers submit training Jobs such as `deploy/training-job.yaml`, which asks for 2 GPUs.
- The NVIDIA device plugin (`deploy/nvidia-device-plugin.yaml`) advertises whole GPUs. GPU sharing is not enabled.

Utilisation measurements are in `docs/gpu-utilization.md`. The proposal to schedule GPUs dynamically is
`docs/adr/0007-dynamic-gpu-scheduling.md`, with a prototype packer in `src/scheduler/gpu_packer.py`.
