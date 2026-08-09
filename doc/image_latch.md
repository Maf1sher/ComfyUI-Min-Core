# Image Latch

## Overview

Image Latch is a ComfyUI node acting as a savepoint/checkpoint mechanism specifically designed for image data. It optimizes workflows by stopping upstream execution if it already has a saved image for the given execution path.

## How it works

1. **Lazy Evaluation:** `ImageLatch` uses ComfyUI's `lazy` evaluation feature. When the workflow runs, ComfyUI checks with this node whether it needs its upstream inputs evaluated.
2. **Latch Status:**
    - If the `block` input is **True** and the node has a latched image file saved on disk, it does **not** evaluate its upstream nodes. It loads the file from disk and outputs it directly. This saves significant generation time.
    - If the `block` input is **False**, or the node does **not** have a latched file on disk, it requests the upstream nodes to execute, saves the incoming image to disk, and outputs it.
3. **Cache Invalidation:** ComfyUI caches nodes based on their inputs. To force an update, `ImageLatch` has an internal version string that is bumped when you press the **Refresh** button.

## Usage
Add `ImageLatch` to your workflow between expensive operations (e.g., right after a long upscale, a VAE Decode, or an expensive image-processing stage) to avoid re-running them on every iteration.

### Inputs
- **block** (Boolean, default: True): Controls whether the node should use the latched file (if present). If set to `False`, the node bypasses the latch and always evaluates the upstream nodes, capturing a fresh image. This input can be converted to an input socket to be dynamically controlled by other nodes.

### Buttons
- **🔄 Refresh:** This button releases the latch. It deletes the saved file and invalidates ComfyUI's cache for this node. The next time you run the workflow, the upstream nodes will be re-evaluated to capture a fresh image. Even if `block` is True, pressing Refresh will force a single upstream evaluation.

### Visual Feedback
The node provides visual feedback to indicate its current state:
- **Default color:** The node is not latched (no file saved).
- **Dark blue color:** The node is currently latched. Running the workflow will use the saved data without executing upstream nodes.

## Cache Stability

When an image is latched, the node produces a **stable cache fingerprint** based on the modification time of the saved file on disk. This means that downstream nodes can re-run **without forcing upstream nodes to re-execute** — the latched image is simply loaded from disk.

This is especially useful in multi-stage pipelines: you can iterate on later stages without regenerating earlier (potentially expensive) results.

## Storage
The latched images are saved as PNG files in the `input/mincore/image_latch/` directory inside your ComfyUI installation. Only the first frame of the IMAGE tensor is persisted.
- **Persistence:** Because the files are stored in `input/`, they survive ComfyUI restarts and temp directory cleanups.
- **Cleanup:** You can manually delete the files in this directory if you want to free up space. Doing so will simply unlatch all nodes.
