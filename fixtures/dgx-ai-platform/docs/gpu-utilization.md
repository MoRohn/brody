# GPU utilisation on dgx-01

Measured with the DCGM exporter (`DCGM_FI_DEV_GPU_UTIL` and `DCGM_FI_DEV_FB_USED`) over 14 days.

| Service | GPU | Average GPU utilisation | Memory used |
| --- | --- | --- | --- |
| chat-assistant | GPU 0 | 14% | 31 GB of 80 GB |
| code-completion | GPU 1 | 11% | 22 GB of 80 GB |
| embeddings | GPU 2 | 9% | 6 GB of 80 GB |
| reranker | GPU 3 | 8% | 5 GB of 80 GB |
| speech-to-text | GPU 4 | 15% | 12 GB of 80 GB |
| vision-ocr | GPU 5 | 13% | 10 GB of 80 GB |
| summarizer | GPU 6 | 16% | 18 GB of 80 GB |
| moderation | GPU 7 | 10% | 4 GB of 80 GB |

Each inference service uses about 12% of its GPU on average. All 8 GPUs are allocated, so the node reports
`nvidia.com/gpu` allocatable 8 and allocated 8.

The fine-tuning job `finetune-llm-v4` has been Pending for 3 days with the event
`0/1 nodes are available: 1 Insufficient nvidia.com/gpu`. It needs 2 GPUs, and every GPU is already allocated to an
inference service, even though most of each GPU is idle.
