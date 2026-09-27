"""Persistence helpers for Pose Gallery records and collections."""

import json
import os
import re
import shutil
import time
import uuid

import numpy as np
import torch
from PIL import Image as PILImage

import folder_paths
from .openpose_studio import render_pose_image


_RECORD_ID = re.compile(r"^[0-9a-f]{32}$")
_COLLECTION_ID = re.compile(r"^(default|[0-9a-f]{32})$")


def _gallery_root() -> str:
    return os.path.join(folder_paths.get_input_directory(), "mincore", "pose_gallery")


def _entries_root() -> str:
    return os.path.join(_gallery_root(), "entries")


def _collections_path() -> str:
    return os.path.join(_gallery_root(), "collections.json")


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.replace(temporary_path, path)


def _read_collections() -> list[dict]:
    os.makedirs(_gallery_root(), exist_ok=True)
    path = _collections_path()
    if not os.path.isfile(path):
        _write_json(path, {"collections": [{"id": "default", "name": "Default"}]})
    with open(path, "r", encoding="utf-8") as file:
        data = json.load(file)
    collections = data.get("collections", [])
    if not isinstance(collections, list):
        raise ValueError("Invalid gallery collection index")
    if not any(item.get("id") == "default" for item in collections if isinstance(item, dict)):
        collections.insert(0, {"id": "default", "name": "Default"})
        _write_json(path, {"collections": collections})
    return collections


def _find_collection(collection_id: str) -> dict | None:
    if not isinstance(collection_id, str) or not _COLLECTION_ID.fullmatch(collection_id):
        return None
    return next((item for item in _read_collections() if isinstance(item, dict) and item.get("id") == collection_id), None)


def _record_dir(record_id: str) -> str:
    if not isinstance(record_id, str) or not _RECORD_ID.fullmatch(record_id):
        raise ValueError("Invalid gallery record ID")
    root = os.path.realpath(_entries_root())
    path = os.path.realpath(os.path.join(root, record_id))
    if not folder_paths.is_within_directory(root, path):
        raise ValueError("Invalid gallery record path")
    return path


def _read_manifest(record_id: str) -> dict | None:
    path = os.path.join(_record_dir(record_id), "record.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as file:
        manifest = json.load(file)
    if not isinstance(manifest, dict) or manifest.get("id") != record_id:
        return None
    return manifest


def _list_records(collection_id: str | None = None) -> list[dict]:
    if collection_id is not None and _find_collection(collection_id) is None:
        raise ValueError("Unknown gallery collection")
    records = []
    if not os.path.isdir(_entries_root()):
        return records
    for entry in os.scandir(_entries_root()):
        if not entry.is_dir() or not _RECORD_ID.fullmatch(entry.name):
            continue
        try:
            manifest = _read_manifest(entry.name)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if manifest is None or (collection_id and manifest.get("collection_id") != collection_id):
            continue
        records.append({
            "id": entry.name,
            "name": str(manifest.get("name", "")),
            "collection_id": manifest.get("collection_id", "default"),
            "general_tags": str(manifest.get("general_tags", "")),
            "person_tags": manifest.get("person_tags", []),
            "mask_count": int(manifest.get("mask_count", 0)),
            "has_image": (
                bool(manifest.get("has_image", True))
                and os.path.isfile(os.path.join(entry.path, "image.png"))
            ),
            "created": str(manifest.get("created", "")),
        })
    return sorted(records, key=lambda record: record["created"], reverse=True)


def _as_float_array(value: torch.Tensor) -> np.ndarray:
    return value.detach().to(device="cpu", dtype=torch.float32).numpy().copy()


def _manifest_preview_array(array: np.ndarray, channels: int | None = None) -> np.ndarray:
    if array.ndim == 4:
        array = array[0]
    elif array.ndim == 3 and channels is None:
        array = array[0]
    if channels is not None:
        array = array[..., :channels]
    return np.clip(array * 255.0, 0, 255).astype(np.uint8)


def _is_valid_image(image: torch.Tensor | None) -> bool:
    return torch.is_tensor(image) and image.ndim == 4 and image.shape[-1] >= 3


def _save_record(
    collection_id: str,
    name: str,
    image: torch.Tensor | None,
    pose_json: str,
    masks: list[torch.Tensor],
    general_tags: str,
    person_tags: list[str],
) -> dict:
    collection = _find_collection(collection_id)
    if collection is None:
        raise ValueError("Unknown gallery collection")
    if image is not None and not _is_valid_image(image):
        raise ValueError("Pose Gallery: IMAGE input must be a valid IMAGE tensor.")

    record_id = uuid.uuid4().hex
    directory = _record_dir(record_id)
    os.makedirs(directory, exist_ok=False)
    try:
        arrays = {}
        if image is not None:
            arrays["image"] = _as_float_array(image)
        for index, mask in enumerate(masks):
            arrays[f"mask_{index:04d}"] = _as_float_array(mask)
        np.savez_compressed(os.path.join(directory, "data.npz"), **arrays)

        if image is not None:
            image_preview = _manifest_preview_array(arrays["image"], channels=3)
            PILImage.fromarray(image_preview, "RGB").save(os.path.join(directory, "image.png"))

        pose_array = render_pose_image(pose_json)
        PILImage.fromarray(_manifest_preview_array(pose_array, channels=3), "RGB").save(
            os.path.join(directory, "pose.png")
        )
        for index, mask in enumerate(masks):
            mask_array = arrays[f"mask_{index:04d}"]
            if mask_array.ndim == 3:
                mask_array = mask_array[0]
            elif mask_array.ndim == 4:
                mask_array = mask_array[0, 0]
            mask_png = np.clip(mask_array * 255.0, 0, 255).astype(np.uint8)
            PILImage.fromarray(mask_png, "L").save(
                os.path.join(directory, f"mask_{index:04d}.png")
            )

        manifest = {
            "id": record_id,
            "name": name.strip()[:120] or time.strftime("Record %Y-%m-%d %H:%M:%S"),
            "collection_id": collection_id,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "pose_json": pose_json,
            "general_tags": general_tags,
            "person_tags": person_tags,
            "mask_count": len(masks),
            "has_image": image is not None,
            "image_shape": list(arrays["image"].shape) if image is not None else [],
        }
        _write_json(os.path.join(directory, "record.json"), manifest)
        return manifest
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def _load_record(record_id: str) -> tuple[dict, torch.Tensor | None, list[torch.Tensor]]:
    manifest = _read_manifest(record_id)
    if manifest is None:
        raise FileNotFoundError("Pose Gallery: the selected record no longer exists.")
    data_path = os.path.join(_record_dir(record_id), "data.npz")
    with np.load(data_path, allow_pickle=False) as data:
        image = (
            torch.from_numpy(np.array(data["image"], dtype=np.float32, copy=True))
            if "image" in data.files else None
        )
        masks = [
            torch.from_numpy(np.array(data[f"mask_{index:04d}"], dtype=np.float32, copy=True))
            for index in range(int(manifest.get("mask_count", 0)))
        ]
    return manifest, image, masks
