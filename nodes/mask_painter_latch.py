"""
Mask Painter Latch — mask painting node with latch mechanics.

Combines NKD Mask Painter's mask-editor workflow with Latent Latch's
persistence mechanics.  The painted mask AND the background image are
saved to disk and "latched" — subsequent executions return the saved
data WITHOUT triggering upstream nodes (when blocked).

Two independent ``block_image`` / ``block_mask`` booleans control
whether the respective upstream input is evaluated.  Pressing the
Refresh / Refresh-Mask buttons forces a single upstream evaluation
for the corresponding input regardless of the block state.

Based on NKD Mask Painter from ComfyUI-NKD-Preview-Tools:
https://github.com/Nekodificador/ComfyUI-NKD-Preview-Tools

Persistence: files are stored under ComfyUI's
``input/mincore_mask_painter_latch/`` directory, which survives temp
cleanup and ComfyUI restarts.
"""

import os

import folder_paths
import numpy as np
import torch
from PIL import Image as PILImage
from aiohttp import web
from server import PromptServer

from comfy_api.latest import io
from comfy_api.latest._io import _UIOutput


# ── Module-level state ────────────────────────────────────────────────────────

_LATCH_SUBDIR = "mincore_mask_painter_latch"
_TEMP_PREFIX = "MinCoreMaskPainter/MCMP-"

# pb_id ("$<node_id>-<counter>") → (abs_rgba_path, rgba_item, clean_item|None)
_pb_id_map: dict[str, tuple[str, dict, dict | None]] = {}

# (node_id, abs_path) → pb_id
_pb_name_map: dict[tuple, str] = {}

_user_edited_pb_ids: set[str] = set()

# node_id → (images_tensor_id, last_pb_id)
_pb_cache: dict[str, tuple[int, str]] = {}

# Monotonic counter for unique pb_ids.
_pb_counter = 0

# Force-refresh flags, populated by REST endpoints, consumed by
# check_lazy_status.
_force_refresh_image_nodes: set[str] = set()
_force_refresh_mask_nodes: set[str] = set()
_force_clear_nodes: set[str] = set()

_pending_execute_image: set[str] = set()
_pending_execute_mask: set[str] = set()


# ── Disk helpers ──────────────────────────────────────────────────────────────

def _latch_dir() -> str:
    """Return the absolute path to the latch storage directory."""
    d = os.path.join(folder_paths.get_input_directory(), _LATCH_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _safe_id(node_id: str) -> str:
    return str(node_id).replace("/", "_").replace("\\", "_").replace("..", "_")


# ── Mask backup ───────────────────────────────────────────────────────────────

def _mask_backup_path(node_id: str) -> str:
    return os.path.join(_latch_dir(), f"{_safe_id(node_id)}_mask.png")


def _save_backup_mask(node_id: str, mask_2d: np.ndarray) -> None:
    """Persist a 2D uint8 mask (255=masked, 0=unmasked) to disk."""
    PILImage.fromarray(mask_2d, "L").save(_mask_backup_path(node_id))


def _load_backup_mask(node_id: str) -> np.ndarray | None:
    """Load persisted mask as 2D uint8 (255=masked) or None."""
    p = _mask_backup_path(node_id)
    if not os.path.isfile(p):
        return None
    try:
        return np.array(PILImage.open(p).convert("L"), dtype=np.uint8)
    except Exception:
        return None


def _delete_backup_mask(node_id: str) -> None:
    p = _mask_backup_path(node_id)
    if os.path.isfile(p):
        try:
            os.remove(p)
        except OSError:
            pass


def _has_backup_mask(node_id: str) -> bool:
    return os.path.isfile(_mask_backup_path(node_id))


# ── Image backup ──────────────────────────────────────────────────────────────

def _image_backup_path(node_id: str) -> str:
    return os.path.join(_latch_dir(), f"{_safe_id(node_id)}_image.png")


def _save_backup_image(node_id: str, image_tensor: torch.Tensor) -> None:
    """Persist the first frame of an IMAGE tensor as RGB PNG."""
    img_np = np.clip(255.0 * image_tensor[0].cpu().numpy(), 0, 255).astype(np.uint8)
    PILImage.fromarray(img_np, "RGB").save(_image_backup_path(node_id))


def _load_backup_image(node_id: str) -> torch.Tensor | None:
    """Load persisted image as [1,H,W,3] float32 tensor or None."""
    p = _image_backup_path(node_id)
    if not os.path.isfile(p):
        return None
    try:
        img = PILImage.open(p).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception:
        return None


def _delete_backup_image(node_id: str) -> None:
    p = _image_backup_path(node_id)
    if os.path.isfile(p):
        try:
            os.remove(p)
        except OSError:
            pass


def _has_backup_image(node_id: str) -> bool:
    return os.path.isfile(_image_backup_path(node_id))


def _backup_mtime(node_id: str, kind: str) -> str:
    """Return the mtime of a backup file as a string, or '0' if missing.

    Used by ``fingerprint_inputs`` to produce a stable cache key that
    only changes when the underlying backup file is actually rewritten.
    """
    p = _image_backup_path(node_id) if kind == "image" else _mask_backup_path(node_id)
    try:
        return str(os.path.getmtime(p))
    except OSError:
        return "0"


# ── Mask conventions ──────────────────────────────────────────────────────────
#
# Editor PNG (RGBA):   alpha=255 → not masked, alpha=0 → masked.
# ComfyUI mask tensor: 0.0 → not masked, 1.0 → masked.
# Backup PNG (mode L): 0 → not masked, 255 → masked. (i.e. 255 - alpha)


def _mask_tensor_from_alpha(alpha_uint8: np.ndarray) -> torch.Tensor:
    """alpha_uint8 [H,W] → mask tensor [1,H,W] float32 (1.0 = masked)."""
    return torch.from_numpy(
        1.0 - alpha_uint8.astype(np.float32) / 255.0
    ).unsqueeze(0)


def _alpha_from_input_mask(mask: torch.Tensor, H: int, W: int) -> np.ndarray:
    """Convert an incoming MASK tensor (1.0 = masked) into an alpha array
    matching the image size.  Resamples if needed.
    """
    m = mask[0] if mask.dim() == 3 else mask
    arr = np.clip(m.cpu().numpy(), 0.0, 1.0)
    if arr.shape != (H, W):
        u8 = (arr * 255.0).astype(np.uint8)
        u8 = np.array(
            PILImage.fromarray(u8, "L").resize((W, H), PILImage.LANCZOS),
            dtype=np.uint8,
        )
        arr = u8.astype(np.float32) / 255.0
    return ((1.0 - arr) * 255.0).astype(np.uint8)


# ── Editor PNG infrastructure ─────────────────────────────────────────────────

def _build_editor_png(
    image_tensor: torch.Tensor,
    alpha_uint8: np.ndarray | None,
) -> tuple[str, dict, dict, int, int]:
    """Compose RGBA + clean RGB PNGs in temp/.
    Returns (rgba_path, rgba_item, clean_item, W, H).
    """
    img_np = np.clip(
        255.0 * image_tensor[0].cpu().numpy(), 0, 255
    ).astype(np.uint8)
    H, W = img_np.shape[:2]

    if alpha_uint8 is None or alpha_uint8.shape != (H, W):
        alpha_uint8 = np.full((H, W), 255, dtype=np.uint8)

    rgb = PILImage.fromarray(img_np, "RGB")
    rgba = rgb.convert("RGBA")
    rgba.putalpha(PILImage.fromarray(alpha_uint8, "L"))

    full_output_folder, filename, counter, subfolder, _ = (
        folder_paths.get_save_image_path(
            _TEMP_PREFIX, folder_paths.get_temp_directory(), W, H
        )
    )
    os.makedirs(full_output_folder, exist_ok=True)

    rgba_file = f"{filename}_{counter:05}_.png"
    rgba_path = os.path.join(full_output_folder, rgba_file)
    rgba.save(rgba_path, compress_level=4)

    clean_file = f"{filename}_{counter:05}_clean_.png"
    clean_path = os.path.join(full_output_folder, clean_file)
    rgb.save(clean_path, compress_level=4)

    rgba_item = {"filename": rgba_file, "subfolder": subfolder, "type": "temp"}
    clean_item = {"filename": clean_file, "subfolder": subfolder, "type": "temp"}
    return rgba_path, rgba_item, clean_item, W, H


def _set_pb_image(
    node_id: str, path: str, item: dict, clean_item: dict | None = None,
) -> str:
    """Mint a new pb_id (or reuse one for the same file) and register it."""
    global _pb_counter

    key = (node_id, path)
    if key in _pb_name_map:
        existing = _pb_name_map[key]
        if existing.startswith(f"${node_id}-"):
            _pb_id_map[existing] = (path, item, clean_item)
            return existing

    _pb_counter += 1
    pb_id = f"${node_id}-{_pb_counter}"
    _pb_id_map[pb_id] = (path, item, clean_item)
    _pb_name_map[key] = pb_id
    return pb_id


def _resolve_clipspace_path(
    filename: str, ftype: str, subfolder: str,
) -> str | None:
    base = {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }.get(ftype)
    if not base:
        return None
    p = (
        os.path.join(base, subfolder, filename)
        if subfolder
        else os.path.join(base, filename)
    )
    return p if os.path.exists(p) else None


# ── UI output ─────────────────────────────────────────────────────────────────

class _MaskPainterLatchUI(_UIOutput):
    def __init__(self, item: dict, pb_id: str, has_mask: bool, latched: bool):
        super().__init__()
        self.item = item
        self.pb_id = pb_id
        self.has_mask = has_mask
        self.latched = latched

    def as_dict(self) -> dict:
        return {
            "images": [self.item],
            "mcmp_pb_id": [self.pb_id],
            "mcmp_has_mask": [self.has_mask],
            "mcmp_latched": [self.latched],
        }


# ── REST endpoints ────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes


def _validate_node_id(node_id: str) -> bool:
    return bool(
        node_id
        and not node_id.startswith("-")
        and "/" not in node_id
        and ".." not in node_id
    )


@routes.get("/mincore/mask_painter/bridge/set")
async def _bridge_set(request: web.Request) -> web.Response:
    """Register a clipspace file after mask editor save."""
    q = request.rel_url.query
    node_id = q.get("node_id", "")
    filename = q.get("filename", "")
    ftype = q.get("type", "input")
    subfolder = q.get("subfolder", "")

    if not _validate_node_id(node_id):
        return web.Response(status=400, text="Invalid node_id")

    abs_path = _resolve_clipspace_path(filename, ftype, subfolder)
    if abs_path is None:
        return web.Response(status=400, text="File not found")

    item = {"filename": filename, "subfolder": subfolder, "type": ftype}
    pb_id = _set_pb_image(node_id, abs_path, item)
    _user_edited_pb_ids.add(pb_id)

    # Mirror alpha to persistent backup.
    try:
        alpha = np.array(
            PILImage.open(abs_path).convert("RGBA").getchannel("A"),
            dtype=np.uint8,
        )
        _save_backup_mask(node_id, (255 - alpha).astype(np.uint8))
    except Exception:
        pass

    return web.Response(text=pb_id)


@routes.get("/mincore/mask_painter/bridge/get")
async def _bridge_get(request: web.Request) -> web.Response:
    """Return metadata for a registered pb_id."""
    pb_id = request.rel_url.query.get("id", "")
    entry = _pb_id_map.get(pb_id)
    if entry is None:
        return web.Response(status=404, text="Unknown pb_id")
    path, item, _clean = entry
    if not os.path.isfile(path):
        return web.Response(status=404, text="File missing")
    return web.json_response(item)


@routes.get("/mincore/mask_painter/clear")
async def _clear(request: web.Request) -> web.Response:
    """Clear both image and mask backups, invalidate registrations."""
    node_id = request.rel_url.query.get("node_id", "")
    if not _validate_node_id(node_id):
        return web.Response(status=400, text="Invalid node_id")

    # Find the most recent clean thumbnail.
    clean_item: dict | None = None
    candidate_keys = [k for k in _pb_id_map if k.startswith(f"${node_id}-")]
    candidate_keys.sort(
        key=lambda k: int(k.rsplit("-", 1)[-1]) if k.rsplit("-", 1)[-1].isdigit() else 0,
        reverse=True,
    )
    for k in candidate_keys:
        _, _item, _clean = _pb_id_map[k]
        if _clean is not None:
            clean_path = os.path.join(
                folder_paths.get_temp_directory(),
                _clean.get("subfolder", ""),
                _clean.get("filename", ""),
            )
            if os.path.isfile(clean_path):
                clean_item = _clean
                break

    # Delete backups.
    _delete_backup_mask(node_id)
    _delete_backup_image(node_id)

    # Invalidate registrations.
    for k in candidate_keys:
        _pb_id_map.pop(k, None)
        _user_edited_pb_ids.discard(k)
    for k in [k for k in _pb_name_map if k[0] == node_id]:
        _pb_name_map.pop(k, None)
    _pb_cache.pop(node_id, None)

    # Flag for check_lazy_status.
    _force_clear_nodes.add(node_id)
    return web.json_response({"clean": clean_item})


@routes.get("/mincore/mask_painter/refresh_image")
async def _refresh_image(request: web.Request) -> web.Response:
    """Mark a node for force-refresh of the image input."""
    node_id = request.rel_url.query.get("node_id", "")
    if not _validate_node_id(node_id):
        return web.Response(status=400, text="Invalid node_id")
    _force_refresh_image_nodes.add(node_id)
    _pending_execute_image.add(node_id)
    _delete_backup_image(node_id)
    # Invalidate pb registrations so a new editor PNG is built.
    for k in [k for k in _pb_id_map if k.startswith(f"${node_id}-")]:
        _pb_id_map.pop(k, None)
        _user_edited_pb_ids.discard(k)
    for k in [k for k in _pb_name_map if k[0] == node_id]:
        _pb_name_map.pop(k, None)
    _pb_cache.pop(node_id, None)
    return web.Response(status=200, text="OK")


@routes.get("/mincore/mask_painter/refresh_mask")
async def _refresh_mask(request: web.Request) -> web.Response:
    """Mark a node for force-refresh of the mask input."""
    node_id = request.rel_url.query.get("node_id", "")
    if not _validate_node_id(node_id):
        return web.Response(status=400, text="Invalid node_id")
    _force_refresh_mask_nodes.add(node_id)
    _pending_execute_mask.add(node_id)
    _delete_backup_mask(node_id)
    # Invalidate pb registrations so a new editor PNG is built.
    for k in [k for k in _pb_id_map if k.startswith(f"${node_id}-")]:
        _pb_id_map.pop(k, None)
        _user_edited_pb_ids.discard(k)
    for k in [k for k in _pb_name_map if k[0] == node_id]:
        _pb_name_map.pop(k, None)
    _pb_cache.pop(node_id, None)
    return web.Response(status=200, text="OK")


@routes.get("/mincore/mask_painter/backup_status")
async def _backup_status(request: web.Request) -> web.Response:
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
            result[nid] = {
                "image": _has_backup_image(nid),
                "mask": _has_backup_mask(nid),
            }
    return web.json_response(result)


# ── Node ──────────────────────────────────────────────────────────────────────

class MaskPainterLatch(io.ComfyNode):
    """Mask painting node with latch mechanics.

    Retains the painted mask and background image between runs.
    Supports optional upstream mask input with independent block controls.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_MaskPainterLatch",
            display_name="Mask Painter Latch",
            category="Min-Core",
            description=(
                "Paint a mask on top of any image using ComfyUI's native "
                "mask editor, with latch mechanics — the painted mask and "
                "background image are saved to disk and persist between "
                "runs. Supports optional upstream mask input. "
                "Based on NKD Mask Painter."
            ),
            inputs=[
                io.Image.Input(
                    "image",
                    optional=True,
                    lazy=True,
                    tooltip="Background image. Passed through to the IMAGE output.",
                ),
                io.Mask.Input(
                    "mask",
                    optional=True,
                    lazy=True,
                    tooltip=(
                        "Optional upstream mask. Press Refresh Mask to load "
                        "it into the editor canvas, replacing the current "
                        "painted mask."
                    ),
                ),
                io.String.Input(
                    "image_widget",
                    default="",
                    socketless=True,
                    tooltip="Internal pb_id tracker. Do not edit manually.",
                ),
                io.String.Input(
                    "latch_version",
                    default="0",
                    socketless=True,
                    tooltip=(
                        "Internal version tracker — bumped by buttons to "
                        "invalidate ComfyUI's cache. Do not edit manually."
                    ),
                ),
                io.Boolean.Input(
                    "block_image",
                    default=True,
                    tooltip=(
                        "When True, the background image is loaded from "
                        "disk instead of evaluating the upstream image "
                        "input. Set to False to always re-evaluate."
                    ),
                ),
                io.Boolean.Input(
                    "block_mask",
                    default=True,
                    tooltip=(
                        "When True, the mask is loaded from disk instead "
                        "of evaluating the upstream mask input. Set to "
                        "False to always re-evaluate."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Mask.Output("MASK"),
                io.Mask.Output("MASK (inverted)"),
            ],
            is_output_node=True,
            has_intermediate_output=True,
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
        )

    # ── Cache control ─────────────────────────────────────────────────────

    @classmethod
    def fingerprint_inputs(
        cls,
        image=None,
        mask=None,
        latch_version="0",
        block_image=True,
        block_mask=True,
        **kwargs,
    ):
        unique_id = str(cls.hidden.unique_id)
        img_mtime = _backup_mtime(unique_id, "image")
        mask_mtime = _backup_mtime(unique_id, "mask")
        fp = f"{latch_version}_{block_image}_{block_mask}_{img_mtime}_{mask_mtime}"
        return fp

    # ── Lazy evaluation ───────────────────────────────────────────────────

    @classmethod
    def check_lazy_status(
        cls,
        image=None,
        mask=None,
        image_widget="",
        latch_version="0",
        block_image=True,
        block_mask=True,
        **kwargs,
    ):
        unique_id = str(cls.hidden.unique_id)
        prompt = getattr(cls.hidden, "prompt", None)
        mask_connected = False
        if prompt is not None:
            node_data = prompt.get(unique_id, {})
            mask_connected = "mask" in node_data.get("inputs", {})
        else:
            mask_connected = mask is not None or "mask" in kwargs

        needed: list[str] = []

        # ── Force-clear: wipe everything, don't request any inputs ────────
        if unique_id in _force_clear_nodes:
            _force_clear_nodes.discard(unique_id)

        # ── Force-refresh image ───────────────────────────────────────────
        force_img = unique_id in _force_refresh_image_nodes
        if force_img:
            _force_refresh_image_nodes.discard(unique_id)
            if image is None:
                needed.append("image")

        # ── Force-refresh mask ────────────────────────────────────────────
        force_mask = unique_id in _force_refresh_mask_nodes
        if force_mask:
            _force_refresh_mask_nodes.discard(unique_id)
            if mask is None and mask_connected:
                needed.append("mask")

        # If any force flag fired, return early with just those.
        if force_img or force_mask:
            return needed

        # ── Normal evaluation logic ───────────────────────────────────────
        # Image: need upstream if not blocked or no backup on disk.
        if not block_image or not _has_backup_image(unique_id):
            if image is None:
                needed.append("image")

        # Mask: need upstream if not blocked or no backup on disk.
        if not block_mask or not _has_backup_mask(unique_id):
            if mask is None and mask_connected:
                needed.append("mask")

        return needed

    # ── Execution ─────────────────────────────────────────────────────────

    @classmethod
    def execute(
        cls,
        image=None,
        mask=None,
        image_widget="",
        latch_version="0",
        block_image=True,
        block_mask=True,
    ) -> io.NodeOutput:
        unique_id = str(cls.hidden.unique_id)

        force_use_image = unique_id in _pending_execute_image
        if force_use_image:
            _pending_execute_image.discard(unique_id)

        force_use_mask = unique_id in _pending_execute_mask
        if force_use_mask:
            _pending_execute_mask.discard(unique_id)

        # ── Resolve background image ─────────────────────────────────────
        use_upstream_image = False
        if image is not None:
            if not block_image or force_use_image or not _has_backup_image(unique_id):
                use_upstream_image = True

        if use_upstream_image:
            # Fresh upstream image — save to disk.
            _save_backup_image(unique_id, image)
            image_tensor = image
        else:
            # Load from disk backup.
            image_tensor = _load_backup_image(unique_id)
            if image_tensor is None:
                raise RuntimeError(
                    "Mask Painter Latch: no image available. Connect an "
                    "upstream image source and run again."
                )

        H, W = int(image_tensor.shape[1]), int(image_tensor.shape[2])

        # ── Resolve mask alpha ────────────────────────────────────────────
        alpha_uint8: np.ndarray | None = None

        use_upstream_mask = False
        if mask is not None:
            if not block_mask or force_use_mask or not _has_backup_mask(unique_id):
                use_upstream_mask = True

        mask_dirty = False

        # 1) If upstream mask was provided, use it (replace semantics).
        if use_upstream_mask:
            alpha_uint8 = _alpha_from_input_mask(mask, H, W)
            mask_dirty = True
            # Drop stale pb_id registrations.
            for k in [k for k in _pb_id_map if k.startswith(f"${unique_id}-")]:
                _pb_id_map.pop(k, None)
                _user_edited_pb_ids.discard(k)
            for k in [k for k in _pb_name_map if k[0] == unique_id]:
                _pb_name_map.pop(k, None)

        # 2) Fall back to disk backup (this includes masks drawn in the UI and saved via /bridge/set)
        if alpha_uint8 is None:
            backup = _load_backup_mask(unique_id)
            if backup is not None:
                if backup.shape != (H, W):
                    backup = np.array(
                        PILImage.fromarray(backup, "L").resize(
                            (W, H), PILImage.LANCZOS
                        ),
                        dtype=np.uint8,
                    )
                    mask_dirty = True
                alpha_uint8 = (255 - backup).astype(np.uint8)

        # ── Build editor PNG & register pb_id ─────────────────────────────
        path, item, clean_item, _, _ = _build_editor_png(
            image_tensor, alpha_uint8
        )
        pb_id = _set_pb_image(unique_id, path, item, clean_item)
        _pb_cache[unique_id] = (id(image_tensor), pb_id)

        # ── Persist mask backup ───────────────────────────────────────────
        if mask_dirty and alpha_uint8 is not None and (alpha_uint8 < 255).any():
            _save_backup_mask(unique_id, (255 - alpha_uint8).astype(np.uint8))

        # ── Compute output tensors ────────────────────────────────────────
        if alpha_uint8 is None:
            mask_out = torch.zeros((1, H, W), dtype=torch.float32)
        else:
            mask_out = _mask_tensor_from_alpha(alpha_uint8)

        has_mask = bool(mask_out.max().item() > 0)
        latched = _has_backup_image(unique_id)

        return io.NodeOutput(
            image_tensor,
            mask_out,
            1.0 - mask_out,
            ui=_MaskPainterLatchUI(item, pb_id, has_mask, latched),
        )
