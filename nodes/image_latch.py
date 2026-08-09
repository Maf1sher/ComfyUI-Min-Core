"""
Image Latch — savepoint node for image data.

Saves the incoming image to disk and "latches". On subsequent executions,
returns the saved image WITHOUT triggering upstream nodes. Pressing the
Refresh button in the UI releases the latch, deletes the saved file, and
re-evaluates upstream to capture a new image.

The first frame of the IMAGE tensor is persisted as a PNG.

Persistence: files are stored under ComfyUI's ``input/mincore/image_latch/``
directory, which survives temp cleanup and ComfyUI restarts.
"""

import os

import numpy as np
import torch
from PIL import Image as PILImage
from aiohttp import web
from comfy_api.latest import io
from server import PromptServer

import folder_paths


# ── Module-level state ────────────────────────────────────────────────────────

# Set of node_ids that should force-refresh on the next execution.
# Populated by the REST endpoint, consumed by check_lazy_status.
_force_refresh_nodes: set[str] = set()

_LATCH_SUBDIR = os.path.join("mincore", "image_latch")


# ── Disk helpers ──────────────────────────────────────────────────────────────

def _latch_dir() -> str:
    """Return the absolute path to the latch storage directory, creating it
    if necessary."""
    d = os.path.join(folder_paths.get_input_directory(), _LATCH_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _latch_path(node_id: str) -> str:
    """Return the absolute path for a given node's latched file."""
    # Sanitise node_id to prevent path traversal.
    safe_id = str(node_id).replace("/", "_").replace("\\", "_").replace("..", "_")
    return os.path.join(_latch_dir(), f"{safe_id}.png")


def _has_latched_file(node_id: str) -> bool:
    return os.path.isfile(_latch_path(node_id))


def _save_image(node_id: str, image: torch.Tensor) -> None:
    """Persist the first frame of an IMAGE tensor as an RGB PNG."""
    img_np = np.clip(255.0 * image[0].cpu().numpy(), 0, 255).astype(np.uint8)
    PILImage.fromarray(img_np, "RGB").save(_latch_path(node_id))


def _load_image(node_id: str) -> torch.Tensor | None:
    """Load a previously saved image as [1,H,W,3] float32 tensor or None."""
    path = _latch_path(node_id)
    if not os.path.isfile(path):
        return None
    try:
        img = PILImage.open(path).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception:
        return None


def _delete_image(node_id: str) -> None:
    """Remove the latched file from disk."""
    path = _latch_path(node_id)
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


# ── REST endpoint ─────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes


@routes.get("/mincore/image_latch/refresh")
async def _image_latch_refresh(request: web.Request) -> web.Response:
    """Mark a node for force-refresh and delete its cached image file."""
    node_id = request.rel_url.query.get("node_id", "")
    if not node_id or ".." in node_id or "/" in node_id:
        return web.Response(status=400, text="Invalid node_id")
    _force_refresh_nodes.add(node_id)
    _delete_image(node_id)
    return web.Response(status=200, text="OK")


@routes.get("/mincore/image_latch/status")
async def _image_latch_status(request: web.Request) -> web.Response:
    """Check whether a node has a latched file on disk."""
    node_id = request.rel_url.query.get("node_id", "")
    if not node_id:
        return web.Response(status=400, text="Invalid node_id")
    has_file = _has_latched_file(node_id)
    return web.json_response({"latched": has_file})


@routes.get("/mincore/image_latch/backup_status")
async def _image_latch_backup_status(request: web.Request) -> web.Response:
    """Return backup status for one or more node IDs (comma-separated).

    Used by the frontend to decide whether upstream links can be removed
    from the serialized prompt (breaking the cache dependency chain).
    """
    raw = request.rel_url.query.get("node_ids", "")
    if not raw:
        return web.Response(status=400, text="Missing node_ids")
    result = {}
    for nid in raw.split(","):
        nid = nid.strip()
        if nid:
            result[nid] = _has_latched_file(nid)
    return web.json_response(result)


# ── Node ──────────────────────────────────────────────────────────────────────

class ImageLatch(io.ComfyNode):
    """Savepoint node that caches an image on disk.

    When a downstream node requests the image, ImageLatch returns the
    cached version without triggering any upstream computation. Pressing
    the Refresh button releases the latch and re-evaluates upstream.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_ImageLatch",
            display_name="Image Latch",
            category="Min-Core",
            is_output_node=True,
            has_intermediate_output=True,
            description=(
                "Savepoint for image data. Saves the image to disk and "
                "latches — subsequent runs return the saved image without "
                "running upstream nodes. Press Refresh to release the latch "
                "and re-capture from upstream."
            ),
            inputs=[
                io.Image.Input(
                    "image",
                    optional=True,
                    lazy=True,
                    tooltip="Image to capture and latch.",
                ),
                io.String.Input(
                    "latch_version",
                    default="0",
                    socketless=True,
                    tooltip=(
                        "Internal version tracker — bumped by the Refresh "
                        "button to invalidate ComfyUI's cache. Do not edit "
                        "manually."
                    ),
                ),
                io.Boolean.Input(
                    "block",
                    default=True,
                    tooltip="Czy obraz jest zatrzaśnięty. Jeśli False, pomija pamięć i pobiera z wejścia.",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "IMAGE",
                    tooltip="The latched image data.",
                ),
            ],
            hidden=[io.Hidden.unique_id],
        )

    # ── Cache control ─────────────────────────────────────────────────────

    @classmethod
    def fingerprint_inputs(cls, image=None, latch_version="0", block=True):
        """Return a stable fingerprint based on latch_version, block state,
        and the modification time of the latched file on disk.  This ensures
        ComfyUI's cache is only invalidated when the underlying data actually
        changes."""
        unique_id = str(cls.hidden.unique_id)
        try:
            mtime = str(os.path.getmtime(_latch_path(unique_id)))
        except OSError:
            mtime = "0"
        return f"{latch_version}_{block}_{mtime}"

    # ── Lazy evaluation ───────────────────────────────────────────────────

    @classmethod
    def check_lazy_status(cls, image=None, latch_version="0", block=True):
        """Decide whether upstream needs to run.

        If block is True and a latched file exists on disk AND we are not
        in force-refresh mode, return [] (don't need any inputs).
        Otherwise request ``image`` so upstream executes.
        """
        unique_id = str(cls.hidden.unique_id)

        # Force refresh: the REST endpoint flagged this node.
        if unique_id in _force_refresh_nodes:
            _force_refresh_nodes.discard(unique_id)
            if image is None:
                return ["image"]
            return []

        # Latched file on disk AND block is True → skip upstream entirely.
        if block and _has_latched_file(unique_id):
            return []

        # No file or block is False → need upstream data.
        if image is None:
            return ["image"]
        return []

    # ── Execution ─────────────────────────────────────────────────────────

    @classmethod
    def execute(cls, image=None, latch_version="0", block=True) -> io.NodeOutput:
        unique_id = str(cls.hidden.unique_id)

        # Try loading from disk first (covers restart / cache-clear cases).
        if image is None:
            saved = _load_image(unique_id)
            if saved is not None:
                return io.NodeOutput(saved)
            # Should not happen (check_lazy_status should have requested
            # the input), but handle gracefully.
            raise RuntimeError(
                "Image Latch: no image available. Connect an upstream "
                "image source and run again."
            )

        # We have fresh upstream data — save it and latch.
        _save_image(unique_id, image)

        # We also need to let the frontend know that we are now latched.
        # We can pass ui data to trigger the visual feedback.
        return io.NodeOutput(image, ui={"latched": [True]})
