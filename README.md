# ComfyUI-Min-Core

A personal collection of custom ComfyUI nodes created specifically for advanced SDXL workflows. This pack focuses on adding specialized workflow-optimization tools, logic nodes, and utility wrappers that streamline the ComfyUI experience.

## Available Nodes

Below is the list of nodes included in this package. For a detailed description of each node, please click on the link to its dedicated documentation file.

* **[Latent Latch](doc/latent_latch.md)** — A savepoint/checkpoint mechanism specifically designed for latent data. It optimizes workflows with long generation times or multiple samplers by stopping upstream execution if it already has a saved latent for the given execution path.
