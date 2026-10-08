"""Composite a foreground image over a movable, resizable background."""

import json
import math
import os
import re

import numpy as np
import torch
import torch.nn.functional as F
from comfy_api.latest import io
from PIL import Image as PILImage

import folder_paths


_DEFAULT_EDITOR_STATE = {"x": 0.0, "y": 0.0, "scale": 1.0}
_MAX_LAYER_PREVIEW_SIDE = 2048
_MAX_NODE_PREVIEW_SIDE = 1024


def _read_editor_state(value: str) -> dict:
    try:
        payload = json.loads(value) if isinstance(value, str) else {}
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    result = {}
    for key, default in _DEFAULT_EDITOR_STATE.items():
        try:
            number = float(payload.get(key, default))
        except (TypeError, ValueError, OverflowError):
            number = default
        result[key] = number if math.isfinite(number) else default
    result["scale"] = max(1.0, result["scale"])
    return result


def _valid_image(image: torch.Tensor, name: str) -> None:
    if (
        not torch.is_tensor(image)
        or image.ndim != 4
        or any(size <= 0 for size in image.shape[:3])
        or image.shape[-1] < 3
    ):
        raise RuntimeError(
            f"Image Compositor Min: {name} must be a non-empty BHWC IMAGE tensor with at least 3 channels."
        )


def _prepare_mask(mask: torch.Tensor | None, source: torch.Tensor) -> torch.Tensor:
    batch, height, width, _channels = source.shape
    if mask is None:
        return torch.zeros((batch, height, width), device=source.device, dtype=torch.float32)
    if not torch.is_tensor(mask) or mask.numel() == 0:
        raise RuntimeError("Image Compositor Min: source_mask must be a non-empty MASK tensor.")

    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4:
        if mask.shape[1:3] == (height, width) and mask.shape[-1] == 1:
            mask = mask[..., 0]
        elif mask.shape[1] == 1 and mask.shape[-2:] == (height, width):
            mask = mask[:, 0]
        elif mask.shape[-1] == 1:
            mask = mask[..., 0]
        elif mask.shape[1] == 1:
            mask = mask[:, 0]
        else:
            raise RuntimeError("Image Compositor Min: source_mask must have one channel.")
    if mask.ndim != 3 or any(size <= 0 for size in mask.shape):
        raise RuntimeError("Image Compositor Min: source_mask must have shape [B,H,W].")
    if mask.shape[0] not in (1, batch):
        raise RuntimeError("Image Compositor Min: source_mask batch size must be 1 or match source.")

    mask = mask.to(device=source.device, dtype=torch.float32)
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.expand(batch, -1, -1)
    if mask.shape[-2:] != (height, width):
        mask = F.interpolate(
            mask.unsqueeze(1),
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        )[:, 0]
    return mask.clamp(0.0, 1.0)


def _source_alpha(source: torch.Tensor, transparency_mask: torch.Tensor) -> torch.Tensor:
    if source.shape[-1] >= 4:
        alpha = source[..., 3].to(dtype=torch.float32).clamp(0.0, 1.0)
        return alpha * (1.0 - transparency_mask)
    return 1.0 - transparency_mask


def _compose(
    source: torch.Tensor,
    background: torch.Tensor,
    source_mask: torch.Tensor | None,
    editor_state: str,
) -> tuple[torch.Tensor, dict]:
    _valid_image(source, "source")
    _valid_image(background, "background")

    batch, output_height, output_width, _channels = source.shape
    background_batch, background_height, background_width, _background_channels = background.shape
    if background_batch not in (1, batch):
        raise RuntimeError("Image Compositor Min: background batch size must be 1 or match source.")

    source_rgb = source[..., :3].to(dtype=torch.float32)
    background_rgb = background[..., :3].to(device=source.device, dtype=torch.float32)
    if background_batch == 1 and batch > 1:
        background_rgb = background_rgb.expand(batch, -1, -1, -1)

    transparency_mask = _prepare_mask(source_mask, source)
    alpha = _source_alpha(source, transparency_mask).unsqueeze(-1)
    state = _read_editor_state(editor_state)

    cover_scale = max(output_width / background_width, output_height / background_height)
    scale = cover_scale * state["scale"]
    scaled_width = background_width * scale
    scaled_height = background_height * scale
    max_offset_x = max(0.0, (scaled_width - output_width) / 2.0)
    max_offset_y = max(0.0, (scaled_height - output_height) / 2.0)
    offset_x = min(max_offset_x, max(-max_offset_x, state["x"]))
    offset_y = min(max_offset_y, max(-max_offset_y, state["y"]))
    left = (output_width - scaled_width) / 2.0 + offset_x
    top = (output_height - scaled_height) / 2.0 + offset_y

    x = torch.arange(output_width, device=source.device, dtype=torch.float32) + 0.5
    y = torch.arange(output_height, device=source.device, dtype=torch.float32) + 0.5
    grid_y, grid_x = torch.meshgrid(y, x, indexing="ij")
    grid_x = 2.0 * ((grid_x - left) / scale) / background_width - 1.0
    grid_y = 2.0 * ((grid_y - top) / scale) / background_height - 1.0
    grid = torch.stack((grid_x, grid_y), dim=-1).unsqueeze(0).expand(batch, -1, -1, -1)

    background_chw = background_rgb.permute(0, 3, 1, 2)
    sampled_background = F.grid_sample(
        background_chw,
        grid,
        mode="bilinear",
        padding_mode="border",
        align_corners=False,
    ).permute(0, 2, 3, 1)
    result = source_rgb * alpha + sampled_background * (1.0 - alpha)
    return result, {"x": offset_x, "y": offset_y, "scale": state["scale"]}


def _preview_array(tensor: torch.Tensor, channels: int) -> np.ndarray:
    array = tensor.detach().to(device="cpu", dtype=torch.float32).numpy()
    if array.ndim == 2 and channels == 1:
        return np.clip(array * 255.0, 0, 255).astype(np.uint8)
    return np.clip(array * 255.0, 0, 255).astype(np.uint8)[..., :channels]


def _save_preview(
    array: np.ndarray,
    filename: str,
    subfolder: str,
    mode: str,
    max_side: int,
) -> dict:
    image = PILImage.fromarray(array, mode)
    image.thumbnail(
        (max_side, max_side),
        getattr(PILImage, "Resampling", PILImage).LANCZOS,
    )
    image.save(os.path.join(folder_paths.get_temp_directory(), subfolder, filename))
    return {"filename": filename, "subfolder": subfolder, "type": "temp"}


def _save_previews(
    node_id: str,
    source: torch.Tensor,
    background: torch.Tensor,
    result: torch.Tensor,
    transparency_mask: torch.Tensor,
) -> tuple[dict, dict]:
    safe_node_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(node_id))
    subfolder = f"MinCoreImageCompositor/{safe_node_id}"
    directory = os.path.join(folder_paths.get_temp_directory(), *subfolder.split("/"))
    os.makedirs(directory, exist_ok=True)

    source_rgb = _preview_array(source[0, ..., :3], 3)
    source_alpha = _preview_array(_source_alpha(source, transparency_mask)[0], 1)[..., None]
    source_rgba = np.concatenate((source_rgb, source_alpha), axis=-1)
    background_rgb = _preview_array(background[0, ..., :3], 3)
    result_rgb = _preview_array(result[0], 3)

    source_item = _save_preview(
        source_rgba, "source.png", subfolder, "RGBA", _MAX_LAYER_PREVIEW_SIDE
    )
    background_item = _save_preview(
        background_rgb, "background.png", subfolder, "RGB", _MAX_LAYER_PREVIEW_SIDE
    )
    output_item = _save_preview(
        result_rgb, "composite.png", subfolder, "RGB", _MAX_NODE_PREVIEW_SIDE
    )
    state = {
        "source": source_item,
        "background": background_item,
        "source_width": int(source.shape[2]),
        "source_height": int(source.shape[1]),
        "background_width": int(background.shape[2]),
        "background_height": int(background.shape[1]),
    }
    return state, output_item


class MinCore_ImageCompositor(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_ImageCompositor",
            display_name="Image Compositor Min",
            category="Min-Core",
            description=(
                "Place a foreground image over a movable and resizable background. "
                "Edit the background position in the image editor."
            ),
            has_intermediate_output=True,
            inputs=[
                io.Image.Input("source", tooltip="Foreground image; its dimensions define the output frame."),
                io.Image.Input("background", tooltip="Background image positioned below source."),
                io.Mask.Input(
                    "source_mask",
                    optional=True,
                    tooltip="Optional transparency mask; 1 means transparent, as with Load Image alpha masks.",
                ),
                io.String.Input(
                    "editor_state",
                    default='{"x":0,"y":0,"scale":1}',
                    socketless=True,
                    tooltip="Internal editor state. Do not edit manually.",
                ),
            ],
            outputs=[io.Image.Output("IMAGE", tooltip="Source composited over the positioned background.")],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        source: torch.Tensor,
        background: torch.Tensor,
        source_mask: torch.Tensor | None = None,
        editor_state: str = "",
    ) -> io.NodeOutput:
        result, transform = _compose(source, background, source_mask, editor_state)
        transparency_mask = _prepare_mask(source_mask, source)
        preview_state, output_preview = _save_previews(
            str(cls.hidden.unique_id), source, background, result, transparency_mask
        )
        preview_state.update(transform)
        return io.NodeOutput(
            result,
            ui={
                "images": [output_preview],
                "image_compositor_state": [preview_state],
            },
        )
