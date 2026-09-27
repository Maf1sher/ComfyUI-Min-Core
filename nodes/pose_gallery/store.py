"""Persistence helpers for Pose Gallery records and collections."""

import json
import os
import re
import shutil
import time
import uuid
from typing import TypedDict

import numpy as np
import torch
from PIL import Image as PILImage

import folder_paths
from ..openpose_studio import count_pose_people, render_pose_image


__all__ = [
    "Collection",
    "RecordManifest",
    "RecordSummary",
    "collections_path",
    "delete_collection",
    "ensure_record_thumbnail",
    "find_collection",
    "is_valid_image",
    "is_valid_mask",
    "list_records",
    "load_record",
    "manifest_preview_array",
    "move_record",
    "read_collections",
    "read_manifest",
    "record_dir",
    "save_record",
    "write_json",
]

_RECORD_ID = re.compile(r"^[0-9a-f]{32}$")
_COLLECTION_ID = re.compile(r"^(default|[0-9a-f]{32})$")


class Collection(TypedDict):
    id: str
    name: str


class RecordManifest(TypedDict, total=False):
    id: str
    name: str
    collection_id: str
    created: str
    pose_json: str
    pose_person_count: int | None
    general_tags: str
    person_tags: list[str]
    mask_count: int
    has_image: bool
    image_shape: list[int]
    assets: dict[str, str | list[str] | None]


class RecordSummary(TypedDict):
    id: str
    name: str
    collection_id: str
    general_tags: str
    person_tags: list[str]
    mask_count: int
    has_image: bool
    created: str


def _gallery_root() -> str:
    return os.path.join(folder_paths.get_input_directory(), "mincore", "pose_gallery")


def _entries_root() -> str:
    return os.path.join(_gallery_root(), "entries")


def collections_path() -> str:
    return os.path.join(_gallery_root(), "collections.json")


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.replace(temporary_path, path)


def read_collections() -> list[Collection]:
    os.makedirs(_gallery_root(), exist_ok=True)
    path = collections_path()
    if not os.path.isfile(path):
        write_json(path, {"collections": [{"id": "default", "name": "Default"}]})
    with open(path, "r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, dict):
        raise ValueError("Invalid gallery collection index")
    collections = data.get("collections", [])
    if not isinstance(collections, list):
        raise ValueError("Invalid gallery collection index")

    validated = []
    seen_ids = set()
    for item in collections:
        if not isinstance(item, dict):
            continue
        collection_id = item.get("id")
        if collection_id == "default":
            if collection_id not in seen_ids:
                validated.append({"id": "default", "name": "Default"})
                seen_ids.add(collection_id)
            continue
        name = item.get("name")
        if (
            not isinstance(collection_id, str)
            or not _COLLECTION_ID.fullmatch(collection_id)
            or collection_id in seen_ids
            or not isinstance(name, str)
        ):
            continue
        name = name.strip()[:100]
        if not name:
            continue
        validated.append({"id": collection_id, "name": name})
        seen_ids.add(collection_id)

    if "default" not in seen_ids:
        validated.insert(0, {"id": "default", "name": "Default"})
    if validated != collections:
        write_json(path, {"collections": validated})
    return validated


def find_collection(collection_id: str) -> Collection | None:
    if not isinstance(collection_id, str) or not _COLLECTION_ID.fullmatch(collection_id):
        return None
    return next((item for item in read_collections() if isinstance(item, dict) and item.get("id") == collection_id), None)


def delete_collection(collection_id: str) -> tuple[Collection, list[str]] | None:
    if not isinstance(collection_id, str) or not _COLLECTION_ID.fullmatch(collection_id):
        raise ValueError("Invalid gallery collection ID")
    if collection_id == "default":
        raise ValueError("The Default collection cannot be deleted")

    collections = read_collections()
    collection = next((item for item in collections if item["id"] == collection_id), None)
    if collection is None:
        return None

    record_ids = []
    if os.path.isdir(_entries_root()):
        for entry in os.scandir(_entries_root()):
            if not entry.is_dir() or not _RECORD_ID.fullmatch(entry.name):
                continue
            try:
                manifest = read_manifest(entry.name)
            except (OSError, ValueError):
                continue
            if manifest is not None and manifest.get("collection_id") == collection_id:
                record_ids.append(entry.name)

    staging_directory = None
    moved_record_ids = []
    if record_ids:
        os.makedirs(_entries_root(), exist_ok=True)
        staging_directory = os.path.join(_entries_root(), f".delete-{uuid.uuid4().hex}")
        os.mkdir(staging_directory)

    try:
        for record_id in record_ids:
            os.replace(record_dir(record_id), os.path.join(staging_directory, record_id))
            moved_record_ids.append(record_id)

        remaining = [item for item in collections if item["id"] != collection_id]
        write_json(collections_path(), {"collections": remaining})
    except Exception:
        if staging_directory is not None:
            rollback_complete = True
            for record_id in reversed(moved_record_ids):
                try:
                    os.replace(
                        os.path.join(staging_directory, record_id),
                        record_dir(record_id),
                    )
                except OSError:
                    rollback_complete = False
            if rollback_complete:
                shutil.rmtree(staging_directory, ignore_errors=True)
        raise

    if staging_directory is not None:
        shutil.rmtree(staging_directory, ignore_errors=True)
    return collection, record_ids


def record_dir(record_id: str) -> str:
    if not isinstance(record_id, str) or not _RECORD_ID.fullmatch(record_id):
        raise ValueError("Invalid gallery record ID")
    root = os.path.realpath(_entries_root())
    path = os.path.realpath(os.path.join(root, record_id))
    if not folder_paths.is_within_directory(root, path):
        raise ValueError("Invalid gallery record path")
    return path


def ensure_record_thumbnail(record_id: str, asset_name: str) -> str | None:
    if asset_name not in ("image.png", "pose.png") and not re.fullmatch(r"mask_\d{4}\.png", asset_name):
        raise ValueError("Invalid gallery asset name")
    directory = record_dir(record_id)
    source_path = os.path.join(directory, asset_name)
    thumbnail_path = os.path.join(directory, f"thumb_{asset_name}")
    if (
        not folder_paths.is_within_directory(directory, source_path)
        or not folder_paths.is_within_directory(directory, thumbnail_path)
        or not os.path.isfile(source_path)
    ):
        return None
    if os.path.isfile(thumbnail_path):
        return thumbnail_path

    temporary_path = f"{thumbnail_path}.{uuid.uuid4().hex}.tmp"
    mode = "L" if asset_name.startswith("mask_") else "RGB"
    try:
        with PILImage.open(source_path) as source:
            thumbnail = source.convert(mode)
            thumbnail.thumbnail((360, 270), getattr(PILImage, "Resampling", PILImage).LANCZOS)
            thumbnail.save(temporary_path, format="PNG")
        os.replace(temporary_path, thumbnail_path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
    return thumbnail_path


def read_manifest(record_id: str) -> RecordManifest | None:
    path = os.path.join(record_dir(record_id), "record.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as file:
        manifest = json.load(file)
    if not isinstance(manifest, dict) or manifest.get("id") != record_id:
        return None
    return manifest


def move_record(record_id: str, collection_id: str) -> RecordManifest | None:
    if not isinstance(collection_id, str) or not _COLLECTION_ID.fullmatch(collection_id):
        raise ValueError("Invalid gallery collection ID")
    if find_collection(collection_id) is None:
        raise ValueError("Unknown gallery collection")

    manifest = read_manifest(record_id)
    if manifest is None:
        return None
    if manifest.get("collection_id") != collection_id:
        manifest["collection_id"] = collection_id
        write_json(os.path.join(record_dir(record_id), "record.json"), manifest)
    return manifest


def list_records(collection_id: str | None = None) -> list[RecordSummary]:
    if collection_id is not None and find_collection(collection_id) is None:
        raise ValueError("Unknown gallery collection")
    records: list[RecordSummary] = []
    if not os.path.isdir(_entries_root()):
        return records
    for entry in os.scandir(_entries_root()):
        if not entry.is_dir() or not _RECORD_ID.fullmatch(entry.name):
            continue
        try:
            manifest = read_manifest(entry.name)
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


def manifest_preview_array(array: np.ndarray, channels: int | None = None) -> np.ndarray:
    if array.ndim == 4:
        array = array[0]
    elif array.ndim == 3 and channels is None:
        array = array[0]
    if channels is not None:
        array = array[..., :channels]
    return np.clip(array * 255.0, 0, 255).astype(np.uint8)


def is_valid_image(image: torch.Tensor | None) -> bool:
    return (
        torch.is_tensor(image)
        and image.ndim == 4
        and all(size > 0 for size in image.shape[:3])
        and image.shape[-1] >= 3
    )


def is_valid_mask(mask: torch.Tensor | None) -> bool:
    return (
        torch.is_tensor(mask)
        and mask.ndim in (2, 3, 4)
        and all(size > 0 for size in mask.shape)
    )


def save_record(
    collection_id: str,
    name: str,
    image: torch.Tensor | None,
    pose_json: str,
    masks: list[torch.Tensor],
    general_tags: str,
    person_tags: list[str],
) -> RecordManifest:
    collection = find_collection(collection_id)
    if collection is None:
        raise ValueError("Unknown gallery collection")
    if image is not None and not is_valid_image(image):
        raise ValueError("Pose Gallery: IMAGE input must be a valid IMAGE tensor.")
    if not isinstance(masks, list) or any(not is_valid_mask(mask) for mask in masks):
        raise ValueError("Pose Gallery: MASK inputs must be non-empty 2D, 3D, or 4D tensors.")

    record_id = uuid.uuid4().hex
    directory = record_dir(record_id)
    os.makedirs(directory, exist_ok=False)
    try:
        arrays = {}
        if image is not None:
            arrays["image"] = _as_float_array(image)
        for index, mask in enumerate(masks):
            arrays[f"mask_{index:04d}"] = _as_float_array(mask)
        np.savez_compressed(os.path.join(directory, "data.npz"), **arrays)

        if image is not None:
            image_preview = manifest_preview_array(arrays["image"], channels=3)
            PILImage.fromarray(image_preview, "RGB").save(os.path.join(directory, "image.png"))

        pose_array = render_pose_image(pose_json)
        PILImage.fromarray(manifest_preview_array(pose_array, channels=3), "RGB").save(
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

        manifest: RecordManifest = {
            "id": record_id,
            "name": name.strip()[:120] or time.strftime("Record %Y-%m-%d %H:%M:%S"),
            "collection_id": collection_id,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "pose_json": pose_json,
            "pose_person_count": count_pose_people(pose_json),
            "general_tags": general_tags,
            "person_tags": person_tags,
            "mask_count": len(masks),
            "has_image": image is not None,
            "image_shape": list(arrays["image"].shape) if image is not None else [],
        }
        write_json(os.path.join(directory, "record.json"), manifest)
        return manifest
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def load_record(record_id: str) -> tuple[RecordManifest, torch.Tensor | None, list[torch.Tensor]]:
    manifest = read_manifest(record_id)
    if manifest is None:
        raise FileNotFoundError("Pose Gallery: the selected record no longer exists.")
    data_path = os.path.join(record_dir(record_id), "data.npz")
    with np.load(data_path, allow_pickle=False) as data:
        image = (
            torch.from_numpy(np.array(data["image"], dtype=np.float32, copy=True))
            if "image" in data.files else None
        )
        masks = [
            torch.from_numpy(np.array(data[f"mask_{index:04d}"], dtype=np.float32, copy=True))
            for index in range(int(manifest.get("mask_count", 0)))
        ]
    if image is not None and not is_valid_image(image):
        raise ValueError("Pose Gallery: the selected record contains invalid IMAGE data.")
    if any(not is_valid_mask(mask) for mask in masks):
        raise ValueError("Pose Gallery: the selected record contains invalid MASK data.")
    if not isinstance(manifest.get("pose_person_count"), int):
        manifest["pose_person_count"] = count_pose_people(str(manifest.get("pose_json", "")))
    return manifest, image, masks
