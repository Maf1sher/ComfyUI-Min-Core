"""
Latent Latch — savepoint node for latent data.

Saves the incoming latent to disk and "latches". On subsequent executions,
returns the saved latent WITHOUT triggering upstream nodes. Pressing the
Refresh button in the UI releases the latch, deletes the saved file, and
re-evaluates upstream to capture a new latent.

Persistence: files are stored under ComfyUI's ``input/mincore_latent_latch/``
directory, which survives temp cleanup and ComfyUI restarts.
"""

import os

import safetensors.torch
import torch
from aiohttp import web
from comfy_api.latest import io
from server import PromptServer

import comfy.utils
import folder_paths


# ── Module-level state ────────────────────────────────────────────────────────

# Set of node_ids that should force-refresh on the next execution.
# Populated by the REST endpoint, consumed by check_lazy_status.
_force_refresh_nodes: set[str] = set()

_LATCH_SUBDIR = "mincore_latent_latch"


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
    return os.path.join(_latch_dir(), f"{safe_id}.latent")


def _has_latched_file(node_id: str) -> bool:
    return os.path.isfile(_latch_path(node_id))


def _save_latent(node_id: str, latent: dict) -> None:
    """Persist a latent dict to disk as SafeTensors."""
    path = _latch_path(node_id)
    samples = latent["samples"].contiguous()
    output = {
        "latent_tensor": samples,
        "latent_format_version_0": torch.tensor([]),
    }
    # Preserve optional keys.
    for key in ("noise_mask", "batch_index", "type"):
        if key in latent:
            val = latent[key]
            if isinstance(val, torch.Tensor):
                output[key] = val
    comfy.utils.save_torch_file(output, path)


def _load_latent(node_id: str) -> dict | None:
    """Load a previously saved latent from disk. Returns None if missing."""
    path = _latch_path(node_id)
    if not os.path.isfile(path):
        return None
    try:
        data = safetensors.torch.load_file(path, device="cpu")
    except Exception:
        return None
    if "latent_tensor" not in data:
        return None

    multiplier = 1.0
    if "latent_format_version_0" not in data:
        multiplier = 1.0 / 0.18215

    result: dict = {"samples": data["latent_tensor"].float() * multiplier}
    for key in ("noise_mask", "batch_index", "type"):
        if key in data:
            result[key] = data[key]
    return result


def _delete_latent(node_id: str) -> None:
    """Remove the latched file from disk."""
    path = _latch_path(node_id)
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


# ── REST endpoint ─────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes


@routes.get("/mincore/latch/refresh")
async def _latch_refresh(request: web.Request) -> web.Response:
    """Mark a node for force-refresh and delete its cached latent file."""
    node_id = request.rel_url.query.get("node_id", "")
    if not node_id or ".." in node_id or "/" in node_id:
        return web.Response(status=400, text="Invalid node_id")
    _force_refresh_nodes.add(node_id)
    _delete_latent(node_id)
    return web.Response(status=200, text="OK")


@routes.get("/mincore/latch/status")
async def _latch_status(request: web.Request) -> web.Response:
    """Check whether a node has a latched file on disk."""
    node_id = request.rel_url.query.get("node_id", "")
    if not node_id:
        return web.Response(status=400, text="Invalid node_id")
    has_file = _has_latched_file(node_id)
    return web.json_response({"latched": has_file})


# ── Node ──────────────────────────────────────────────────────────────────────

class LatentLatch(io.ComfyNode):
    """Savepoint node that caches a latent on disk.

    When a downstream node requests the latent, LatentLatch returns the
    cached version without triggering any upstream computation. Pressing
    the Refresh button releases the latch and re-evaluates upstream.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_LatentLatch",
            display_name="Latent Latch",
            category="Min-Core",
            is_output_node=True,
            description=(
                "Savepoint for latent data. Saves the latent to disk and "
                "latches — subsequent runs return the saved latent without "
                "running upstream nodes. Press Refresh to release the latch "
                "and re-capture from upstream."
            ),
            inputs=[
                io.Latent.Input(
                    "latent_input",
                    lazy=True,
                    tooltip="Latent to capture and latch.",
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
            ],
            outputs=[
                io.Latent.Output(
                    "LATENT",
                    tooltip="The latched latent data.",
                ),
            ],
            hidden=[io.Hidden.unique_id],
        )

    # ── Cache control ─────────────────────────────────────────────────────

    @classmethod
    def fingerprint_inputs(cls, latent_input=None, latch_version="0"):
        """Return the latch_version widget value so ComfyUI's cache
        stays valid as long as the version doesn't change. The Refresh
        button bumps this value → cache miss → re-execute."""
        return latch_version

    # ── Lazy evaluation ───────────────────────────────────────────────────

    @classmethod
    def check_lazy_status(cls, latent_input=None, latch_version="0"):
        """Decide whether upstream needs to run.

        If a latched file exists on disk AND we are not in force-refresh
        mode, return [] (don't need any inputs). Otherwise request
        ``latent_input`` so upstream executes.
        """
        unique_id = str(cls.hidden.unique_id)

        # Force refresh: the REST endpoint flagged this node.
        if unique_id in _force_refresh_nodes:
            _force_refresh_nodes.discard(unique_id)
            if latent_input is None:
                return ["latent_input"]
            return []

        # Latched file on disk → skip upstream entirely.
        if _has_latched_file(unique_id):
            return []

        # No file → need upstream data.
        if latent_input is None:
            return ["latent_input"]
        return []

    # ── Execution ─────────────────────────────────────────────────────────

    @classmethod
    def execute(cls, latent_input=None, latch_version="0") -> io.NodeOutput:
        unique_id = str(cls.hidden.unique_id)

        # Try loading from disk first (covers restart / cache-clear cases).
        if latent_input is None:
            saved = _load_latent(unique_id)
            if saved is not None:
                return io.NodeOutput(saved)
            # Should not happen (check_lazy_status should have requested
            # the input), but handle gracefully.
            raise RuntimeError(
                "Latent Latch: no latent available. Connect an upstream "
                "latent source and run again."
            )

        # We have fresh upstream data — save it and latch.
        _save_latent(unique_id, latent_input)
        
        # We also need to let the frontend know that we are now latched.
        # We can pass ui data to trigger the visual feedback.
        return io.NodeOutput(latent_input, ui={"latched": [True]})
