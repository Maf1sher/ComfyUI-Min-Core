"""Image conversion and temporary previews for Pose Gallery."""

import os
import re

import numpy as np
import torch
from PIL import Image as PILImage

import folder_paths


__all__ = ["save_temp_preview"]

_MAX_NODE_PREVIEW_SIDE = 1024
_MAX_TEMP_LAYER_SIDE = 2048


def _preview_rgb_array(tensor: torch.Tensor | None) -> np.ndarray | None:
    if not torch.is_tensor(tensor):
        return None
    array = tensor.detach().to(device="cpu", dtype=torch.float32).numpy()
    if array.ndim == 4:
        array = array[0]
    if array.ndim == 2:
        array = np.repeat(array[..., None], 3, axis=-1)
    if array.ndim != 3 or array.shape[-1] < 3:
        return None
    return np.clip(array[..., :3] * 255.0, 0, 255).astype(np.uint8)


def _preview_mask_array(tensor: torch.Tensor) -> np.ndarray | None:
    if not torch.is_tensor(tensor):
        return None
    array = tensor.detach().to(device="cpu", dtype=torch.float32).numpy()
    if array.ndim == 4:
        array = array[0, 0]
    elif array.ndim == 3:
        array = array[0]
    if array.ndim != 2:
        return None
    return np.clip(array * 255.0, 0, 255).astype(np.uint8)


def _compose_node_preview(
    image_array: np.ndarray | None,
    pose_array: np.ndarray | None,
    mask_arrays: list[np.ndarray | None],
    show_image: bool,
    show_openpose: bool,
    show_masks: bool,
) -> np.ndarray:
    reference_shape = next(
        (array.shape[:2] for array in (image_array, pose_array, *mask_arrays) if array is not None),
        (512, 512),
    )
    height, width = reference_shape
    scale = min(1.0, _MAX_NODE_PREVIEW_SIDE / max(height, width))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    width, height = size
    resampling = getattr(PILImage, "Resampling", PILImage).LANCZOS
    canvas = PILImage.new("RGBA", size, (0, 0, 0, 255))

    if show_image and image_array is not None:
        layer = PILImage.fromarray(image_array, "RGB")
        if layer.size != size:
            layer = layer.resize(size, resampling)
        canvas.alpha_composite(layer.convert("RGBA"))

    if show_openpose and pose_array is not None:
        intensity = np.max(pose_array, axis=-1)
        divisor = np.maximum(intensity, 1)[..., None]
        rgb = np.clip(pose_array.astype(np.float32) * (255.0 / divisor), 0, 255).astype(np.uint8)
        alpha = np.minimum(255, np.round(intensity.astype(np.float32) / 0.6)).astype(np.uint8)
        pose_rgba = np.concatenate((rgb, alpha[..., None]), axis=-1)
        layer = PILImage.fromarray(pose_rgba, "RGBA")
        if layer.size != size:
            layer = layer.resize(size, resampling)
        canvas.alpha_composite(layer)

    if show_masks:
        mask_colors = (
            (255, 80, 80), (70, 170, 255), (100, 230, 120),
            (255, 190, 60), (210, 100, 255), (50, 220, 210),
        )
        for index, mask_array in enumerate(mask_arrays):
            if mask_array is None:
                continue
            mask_layer = PILImage.fromarray(mask_array, "L")
            if mask_layer.size != size:
                mask_layer = mask_layer.resize(size, resampling)
            intensity = np.asarray(mask_layer, dtype=np.uint8)
            rgba = np.empty((height, width, 4), dtype=np.uint8)
            rgba[..., :3] = mask_colors[index % len(mask_colors)]
            rgba[..., 3] = np.round(intensity.astype(np.float32) * 0.52).astype(np.uint8)
            canvas.alpha_composite(PILImage.fromarray(rgba, "RGBA"))

    return np.asarray(canvas.convert("RGB"))


def save_temp_preview(
    node_id: str,
    image: torch.Tensor | None,
    pose_image: torch.Tensor,
    masks: list[torch.Tensor],
    scope: str = "output",
    show_image: bool = True,
    show_openpose: bool = True,
    show_masks: bool = False,
) -> dict:
    safe_node_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(node_id))
    subfolder = os.path.join("MinCorePoseGallery", safe_node_id).replace("\\", "/")
    if scope != "output":
        subfolder = f"{subfolder}/{scope}"
    directory = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(directory, exist_ok=True)

    def save_array(array: np.ndarray, filename: str, mode: str) -> dict:
        layer = PILImage.fromarray(array, mode)
        layer.thumbnail(
            (_MAX_TEMP_LAYER_SIDE, _MAX_TEMP_LAYER_SIDE),
            getattr(PILImage, "Resampling", PILImage).LANCZOS,
        )
        layer.save(os.path.join(directory, filename))
        return {"filename": filename, "subfolder": subfolder, "type": "temp"}

    image_array = _preview_rgb_array(image) if image is not None else None
    pose_array = _preview_rgb_array(pose_image)
    mask_arrays = [_preview_mask_array(mask) for mask in masks]
    node_preview = _compose_node_preview(
        image_array,
        pose_array,
        mask_arrays,
        show_image,
        show_openpose,
        show_masks,
    )
    PILImage.fromarray(node_preview, "RGB").save(os.path.join(directory, "preview.png"))
    return {
        "image": save_array(image_array, "image.png", "RGB") if image_array is not None else None,
        "pose": save_array(pose_array, "pose.png", "RGB") if pose_array is not None else None,
        "masks": [
            save_array(array, f"mask_{index:04d}.png", "L")
            for index, array in enumerate(mask_arrays)
        ],
        "node_preview": {"filename": "preview.png", "subfolder": subfolder, "type": "temp"},
    }
