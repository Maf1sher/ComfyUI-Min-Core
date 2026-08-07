# ComfyUI-Min-Core

A personal collection of custom ComfyUI nodes created specifically for SDXL workflows. This pack focuses on adding specialized workflow-optimization tools, logic nodes, and utility wrappers that streamline the ComfyUI experience.

## Available Nodes

Below is the list of nodes included in this package. For a detailed description of each node, please click on the link to its dedicated documentation file.

* **[Latent Latch](doc/latent_latch.md)** — A savepoint/checkpoint mechanism specifically designed for latent data. It optimizes workflows with long generation times or multiple samplers by stopping upstream execution if it already has a saved latent for the given execution path.
* **[Mask Painter Latch](doc/mask_painter_latch.md)** — A mask painting node with latch mechanics. Paint a mask on any image using ComfyUI's native editor, with both the mask and background image persisted to disk between runs. Supports optional upstream mask input with independent block controls. Based on [NKD Mask Painter](https://github.com/Nekodificador/ComfyUI-NKD-Preview-Tools).
* **[OpenPose Studio Min](doc/openpose_studio_min.md)** — A full in-browser pose editor with canvas editing, bundled presets, gallery and pose merger. Renders the edited pose to an IMAGE, returns the filtered JSON, and outputs a POSE_KEYPOINT for DWPose/controlnet downstream nodes. Includes a Show String helper output node. Based on [ComfyUI-OpenPose-Studio](https://github.com/andreszs/comfyui-openpose-studio).
