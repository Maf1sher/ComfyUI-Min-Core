"""Pose Gallery Min: persist and browse complete image/pose/mask/tag records."""

import json
import math
import os
import re
import shutil
import time
import uuid
from io import BytesIO

import numpy as np
import torch
from aiohttp import web
from PIL import Image as PILImage
from comfy_api.latest import io
from comfy_api.latest._io import _UIOutput
from server import PromptServer

import folder_paths
from .openpose_studio import get_runtime_render_style_fingerprint, render_pose_image


_RECORD_ID = re.compile(r"^[0-9a-f]{32}$")
_COLLECTION_ID = re.compile(r"^(default|[0-9a-f]{32})$")
_pending_captures: dict[str, dict] = {}
_last_capture_tokens: dict[str, str] = {}


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
            "created": str(manifest.get("created", "")),
        })
    return sorted(records, key=lambda record: record["created"], reverse=True)


def _as_float_array(value: torch.Tensor) -> np.ndarray:
    return value.detach().to(device="cpu", dtype=torch.float32).numpy().copy()


def _is_valid_image(image: torch.Tensor | None) -> bool:
    return torch.is_tensor(image) and image.ndim == 4 and image.shape[-1] >= 3


def _ordered_values(values, prefix: str, include_empty: bool = True) -> list:
    if not isinstance(values, dict):
        return []
    indexed = {}
    for key, value in values.items():
        leaf = str(key).split(".")[-1]
        match = re.fullmatch(re.escape(prefix) + r"(\d+)", leaf)
        if match:
            indexed[int(match.group(1))] = value
    if not indexed:
        return []
    result = []
    for index in range(max(indexed) + 1):
        value = indexed.get(index)
        if include_empty or value is not None:
            result.append(value)
    return result


def _manifest_preview_array(array: np.ndarray, channels: int | None = None) -> np.ndarray:
    if array.ndim == 4:
        array = array[0]
    elif array.ndim == 3 and channels is None:
        array = array[0]
    if channels is not None:
        array = array[..., :channels]
    return np.clip(array * 255.0, 0, 255).astype(np.uint8)


def _save_record(
    collection_id: str,
    name: str,
    image: torch.Tensor,
    pose_json: str,
    masks: list[torch.Tensor],
    general_tags: str,
    person_tags: list[str],
) -> dict:
    collection = _find_collection(collection_id)
    if collection is None:
        raise ValueError("Unknown gallery collection")
    if not _is_valid_image(image):
        raise ValueError("Pose Gallery: connect a valid IMAGE before saving.")

    record_id = uuid.uuid4().hex
    directory = _record_dir(record_id)
    os.makedirs(directory, exist_ok=False)
    try:
        arrays = {"image": _as_float_array(image)}
        for index, mask in enumerate(masks):
            arrays[f"mask_{index:04d}"] = _as_float_array(mask)
        np.savez_compressed(os.path.join(directory, "data.npz"), **arrays)

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
            "image_shape": list(arrays["image"].shape),
        }
        _write_json(os.path.join(directory, "record.json"), manifest)
        return manifest
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def _load_record(record_id: str) -> tuple[dict, torch.Tensor, list[torch.Tensor]]:
    manifest = _read_manifest(record_id)
    if manifest is None:
        raise FileNotFoundError("Pose Gallery: the selected record no longer exists.")
    data_path = os.path.join(_record_dir(record_id), "data.npz")
    with np.load(data_path, allow_pickle=False) as data:
        image = torch.from_numpy(np.array(data["image"], dtype=np.float32, copy=True))
        masks = [
            torch.from_numpy(np.array(data[f"mask_{index:04d}"], dtype=np.float32, copy=True))
            for index in range(int(manifest.get("mask_count", 0)))
        ]
    return manifest, image, masks


def _save_temp_preview(
    node_id: str,
    image: torch.Tensor | None,
    pose_image: torch.Tensor,
    masks: list[torch.Tensor],
    scope: str = "output",
) -> dict:
    safe_node_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(node_id))
    subfolder = os.path.join("MinCorePoseGallery", safe_node_id).replace("\\", "/")
    if scope != "output":
        subfolder = f"{subfolder}/{scope}"
    directory = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(directory, exist_ok=True)

    def save_tensor(tensor: torch.Tensor, filename: str, mask: bool = False) -> dict:
        array = tensor.detach().to(device="cpu", dtype=torch.float32).numpy()
        if mask:
            if array.ndim == 4:
                array = array[0, 0]
            elif array.ndim == 3:
                array = array[0]
            array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
            PILImage.fromarray(array, "L").save(os.path.join(directory, filename))
        else:
            if array.ndim == 4:
                array = array[0]
            array = np.clip(array[..., :3] * 255.0, 0, 255).astype(np.uint8)
            PILImage.fromarray(array, "RGB").save(os.path.join(directory, filename))
        return {"filename": filename, "subfolder": subfolder, "type": "temp"}

    return {
        "image": save_tensor(image, "image.png") if image is not None else None,
        "pose": save_tensor(pose_image, "pose.png"),
        "masks": [save_tensor(mask, f"mask_{index:04d}.png", mask=True) for index, mask in enumerate(masks)],
    }


class _PoseGalleryUI(_UIOutput):
    def __init__(
        self,
        preview: dict,
        state: dict,
        capture: dict | None,
        current_inputs: dict | None = None,
    ):
        super().__init__()
        self.preview = preview
        self.state = state
        self.capture = capture
        self.current_inputs = current_inputs

    def as_dict(self) -> dict:
        result = {
            "pose_gallery_state": [self.state],
            "pose_gallery_capture": [self.capture] if self.capture else [],
            "pose_gallery_current_inputs": [self.current_inputs] if self.current_inputs else [],
        }
        if self.preview.get("image") is not None:
            result["images"] = [self.preview["image"]]
        return result


routes = PromptServer.instance.routes


@routes.post("/mincore/pose_gallery/preview_pose")
async def _render_pose_preview(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Invalid payload"}, status=400)

    pose_json = payload.get("pose_json")
    if not isinstance(pose_json, str) or len(pose_json) > 5_000_000:
        return web.json_response({"error": "Invalid pose data"}, status=400)
    try:
        line_width_scale = float(payload.get("line_width_scale", 1.0))
    except (TypeError, ValueError, OverflowError):
        return web.json_response({"error": "Invalid line width scale"}, status=400)
    if not math.isfinite(line_width_scale) or not 0.5 <= line_width_scale <= 2.5:
        return web.json_response({"error": "Line width scale must be between 0.5 and 2.5"}, status=400)

    try:
        pose_array = render_pose_image(pose_json, line_width_scale=line_width_scale)
        png = _manifest_preview_array(pose_array, channels=3)
        buffer = BytesIO()
        PILImage.fromarray(png, "RGB").save(buffer, format="PNG")
    except Exception:
        return web.json_response({"error": "Could not render the OpenPose preview"}, status=400)
    return web.Response(
        body=buffer.getvalue(),
        content_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@routes.get("/mincore/pose_gallery/collections")
async def _get_collections(_request: web.Request) -> web.Response:
    return web.json_response({"collections": _read_collections()})


@routes.post("/mincore/pose_gallery/collections")
async def _create_collection(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    name = str(payload.get("name", "")).strip()[:100] if isinstance(payload, dict) else ""
    if not name:
        return web.json_response({"error": "Collection name is required"}, status=400)
    collections = _read_collections()
    if any(item.get("name", "").casefold() == name.casefold() for item in collections):
        return web.json_response({"error": "A collection with that name already exists"}, status=409)
    collection = {"id": uuid.uuid4().hex, "name": name}
    collections.append(collection)
    _write_json(_collections_path(), {"collections": collections})
    return web.json_response(collection)


@routes.get("/mincore/pose_gallery/records")
async def _get_records(request: web.Request) -> web.Response:
    collection_id = request.rel_url.query.get("collection_id", "default")
    try:
        return web.json_response({"records": _list_records(collection_id)})
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=404)


@routes.get("/mincore/pose_gallery/records/{record_id}")
async def _get_record(request: web.Request) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    try:
        manifest = _read_manifest(record_id)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    if manifest is None:
        return web.json_response({"error": "Record not found"}, status=404)
    manifest["assets"] = {
        "image": f"/mincore/pose_gallery/records/{record_id}/assets/image.png",
        "pose": f"/mincore/pose_gallery/records/{record_id}/assets/pose.png",
        "masks": [
            f"/mincore/pose_gallery/records/{record_id}/assets/mask_{index:04d}.png"
            for index in range(int(manifest.get("mask_count", 0)))
        ],
    }
    return web.json_response(manifest)


@routes.delete("/mincore/pose_gallery/records/{record_id}")
async def _delete_record(request: web.Request) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    try:
        directory = _record_dir(record_id)
        manifest = _read_manifest(record_id)
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read the gallery record"}, status=500)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError:
        return web.json_response({"error": "Could not read the gallery record"}, status=500)
    if manifest is None:
        return web.json_response({"error": "Record not found"}, status=404)
    try:
        shutil.rmtree(directory)
    except OSError:
        return web.json_response({"error": "Could not delete the gallery record"}, status=500)
    return web.json_response({"ok": True, "id": record_id})


@routes.get("/mincore/pose_gallery/records/{record_id}/assets/{filename}")
async def _get_record_asset(request: web.Request) -> web.StreamResponse:
    record_id = request.match_info.get("record_id", "")
    filename = request.match_info.get("filename", "")
    try:
        manifest = _read_manifest(record_id)
    except ValueError as error:
        return web.Response(status=400, text=str(error))
    if manifest is None:
        return web.Response(status=404)
    allowed = {"image.png", "pose.png"}
    allowed.update(
        f"mask_{index:04d}.png" for index in range(int(manifest.get("mask_count", 0)))
    )
    if filename not in allowed:
        return web.Response(status=404)
    path = os.path.join(_record_dir(record_id), filename)
    if not os.path.isfile(path) or not folder_paths.is_within_directory(_record_dir(record_id), path):
        return web.Response(status=404)
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@routes.post("/mincore/pose_gallery/capture")
async def _request_capture(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Invalid payload"}, status=400)
    node_id = str(payload.get("node_id", ""))
    action = str(payload.get("action", "save"))
    collection_id = str(payload.get("collection_id", "default"))
    if not re.fullmatch(r"\d{1,12}", node_id):
        return web.json_response({"error": "Invalid node ID"}, status=400)
    if action not in ("save", "preview"):
        return web.json_response({"error": "Invalid capture action"}, status=400)
    if action == "save" and _find_collection(collection_id) is None:
        return web.json_response({"error": "Unknown collection"}, status=404)
    token = uuid.uuid4().hex
    _pending_captures[node_id] = {
        "token": token,
        "action": action,
        "collection_id": collection_id,
        "name": str(payload.get("name", ""))[:120],
    }
    return web.json_response({"ok": True, "token": token})


def _connected_prompt_inputs(cls, node_id: str) -> dict:
    prompt = getattr(cls.hidden, "prompt", None)
    node_prompt = prompt.get(node_id, {}) if isinstance(prompt, dict) else {}
    inputs = node_prompt.get("inputs", {}) if isinstance(node_prompt, dict) else {}
    return {
        name: value
        for name, value in inputs.items()
        if isinstance(value, (list, tuple)) and len(value) == 2
        and isinstance(value[0], (str, int))
    }


def _dynamic_value(values, input_name: str):
    if input_name in ("image", "pose_json", "general_tags"):
        return values.get(input_name)
    parts = input_name.split(".")
    value = values.get(parts[0])
    for part in parts[1:]:
        value = value.get(part) if isinstance(value, dict) else None
    if isinstance(value, tuple) and len(value) == 2:
        value = value[0]
    return value


def _lazy_inputs_to_request(cls, node_id: str, values: dict) -> list[str]:
    return [
        name for name in _connected_prompt_inputs(cls, node_id)
        if _dynamic_value(values, name) is None
    ]


class MinCore_PoseGallery(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        mask_template = io.Autogrow.TemplatePrefix(
            io.Mask.Input("mask", optional=True, lazy=True),
            prefix="mask_",
            min=0,
            max=100,
        )
        person_tag_template = io.Autogrow.TemplatePrefix(
            io.String.Input("person_tag", optional=True, lazy=True),
            prefix="person_tag_",
            min=0,
            max=100,
        )
        return io.Schema(
            node_id="MinCore_PoseGallery",
            display_name="Pose Gallery Min",
            category="Min-Core",
            is_output_node=True,
            has_intermediate_output=True,
            description=(
                "Browse and save image, pose JSON, masks, and tags as gallery records. "
                "Outputs either the connected inputs or a selected record."
            ),
            search_aliases=["pose gallery", "image pose collection", "pose dataset"],
            inputs=[
                io.Image.Input("image", optional=True, lazy=True, tooltip="Source image."),
                io.String.Input("pose_json", default="", optional=True, lazy=True, force_input=True,
                                tooltip="Pose JSON. The OpenPose preview is generated from this value."),
                io.Autogrow.Input("masks", template=mask_template, optional=True,
                                  tooltip="One optional MASK input per person/layer."),
                io.String.Input("general_tags", default="", optional=True, lazy=True, force_input=True,
                                tooltip="Tags describing the complete image/pose record."),
                io.Autogrow.Input("person_tags", template=person_tag_template, optional=True,
                                  tooltip="Dynamic tags for each person, in pose JSON order."),
                io.Combo.Input("output_source", options=["inputs", "gallery"], default="inputs",
                               tooltip="Choose the connected inputs or the selected gallery record."),
                io.String.Input("gallery_collection_id", default="default", socketless=True),
                io.String.Input("gallery_record_id", default="", socketless=True),
            ],
            outputs=[
                io.Image.Output(
                    "IMAGE",
                    tooltip="Original image, or a black placeholder when no image is connected.",
                ),
                io.Image.Output("OPENPOSE", tooltip="OpenPose image rendered from pose_json."),
                io.String.Output("POSE_JSON", tooltip="Pose JSON."),
                io.Mask.Output(
                    "MASKS",
                    tooltip="Masks as a list, or one zero-valued placeholder mask when none are available.",
                    is_output_list=True,
                ),
                io.String.Output("GENERAL_TAGS", tooltip="General tags."),
                io.String.Output(
                    "PERSON_TAGS",
                    tooltip="Per-person tags, or one empty placeholder when none are configured.",
                    is_output_list=True,
                ),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, output_source="inputs", gallery_record_id="", **_kwargs):
        node_id = str(cls.hidden.unique_id)
        capture = _pending_captures.get(node_id)
        parts = [str(output_source), str(gallery_record_id)]
        parts.append(capture["token"] if capture else _last_capture_tokens.get(node_id, ""))
        if output_source == "gallery" and gallery_record_id:
            try:
                stat = os.stat(os.path.join(_record_dir(gallery_record_id), "data.npz"))
                parts.append(f"{stat.st_mtime_ns}:{stat.st_size}")
            except (OSError, ValueError):
                parts.append("missing")
        parts.append(get_runtime_render_style_fingerprint())
        return "_".join(parts)

    @classmethod
    def check_lazy_status(
        cls,
        image=None,
        pose_json=None,
        masks=None,
        general_tags=None,
        person_tags=None,
        output_source="inputs",
        **kwargs,
    ):
        node_id = str(cls.hidden.unique_id)
        if output_source == "gallery" and node_id not in _pending_captures:
            return []
        values = {
            "image": image,
            "pose_json": pose_json,
            "masks": masks,
            "general_tags": general_tags,
            "person_tags": person_tags,
            **kwargs,
        }
        return _lazy_inputs_to_request(cls, node_id, values)

    @classmethod
    def execute(
        cls,
        image=None,
        pose_json="",
        masks=None,
        general_tags="",
        person_tags=None,
        output_source="inputs",
        gallery_collection_id="default",
        gallery_record_id="",
        **_kwargs,
    ) -> io.NodeOutput:
        node_id = str(cls.hidden.unique_id)
        capture_request = _pending_captures.pop(node_id, None)
        if capture_request:
            _last_capture_tokens[node_id] = capture_request["token"]
        input_image = image
        input_pose_json = pose_json
        input_masks = masks
        input_general_tags = general_tags
        input_person_tags = person_tags

        if output_source == "gallery" and not gallery_record_id and capture_request is not None:
            output_source = "inputs"

        if output_source == "gallery":
            if not gallery_record_id:
                raise RuntimeError("Pose Gallery: select a gallery record or switch output_source to inputs.")
            manifest, image, masks_out = _load_record(gallery_record_id)
            pose_json = str(manifest.get("pose_json", ""))
            general_tags = str(manifest.get("general_tags", ""))
            person_tags_out = [str(tag) for tag in manifest.get("person_tags", [])]
        else:
            if not isinstance(pose_json, str):
                pose_json = str(pose_json or "")
            general_tags = general_tags if isinstance(general_tags, str) else str(general_tags or "")
            masks_out = [
                value for value in _ordered_values(masks, "mask_")
                if torch.is_tensor(value)
            ]
            person_tags_out = [
                str(value or "") for value in _ordered_values(person_tags, "person_tag_")
            ]

        pose_image = torch.from_numpy(render_pose_image(pose_json)).unsqueeze(0)
        # Optional inputs still need consumable values on typed output sockets.
        if image is None:
            image_output = torch.zeros_like(pose_image)
        elif _is_valid_image(image):
            image_output = image
        else:
            raise RuntimeError("Pose Gallery: IMAGE input must be a valid IMAGE tensor.")
        if masks_out:
            masks_output = masks_out
        else:
            # Match the fallback mask to IMAGE's batch and spatial dimensions.
            masks_output = [
                image_output.new_zeros(
                    (image_output.shape[0], image_output.shape[1], image_output.shape[2])
                )
            ]
        person_tags_output = person_tags_out if person_tags_out else [""]

        saved_record = None
        current_inputs_preview = None
        if capture_request is not None and capture_request["action"] == "save":
            saved_record = _save_record(
                capture_request["collection_id"],
                capture_request["name"],
                input_image,
                input_pose_json if isinstance(input_pose_json, str) else str(input_pose_json or ""),
                [
                    value for value in _ordered_values(input_masks, "mask_")
                    if torch.is_tensor(value)
                ],
                input_general_tags if isinstance(input_general_tags, str) else str(input_general_tags or ""),
                [
                    str(value or "") for value in _ordered_values(input_person_tags, "person_tag_")
                ],
            )
            saved_record = {
                "id": saved_record["id"],
                "name": saved_record["name"],
                "collection_id": saved_record["collection_id"],
            }
        elif capture_request is not None and capture_request["action"] == "preview":
            if input_image is not None and not _is_valid_image(input_image):
                raise RuntimeError("Pose Gallery: connect a valid IMAGE to preview current inputs.")
            current_pose_json = input_pose_json if isinstance(input_pose_json, str) else str(input_pose_json or "")
            current_masks = [
                value for value in _ordered_values(input_masks, "mask_")
                if torch.is_tensor(value)
            ]
            current_person_tags = [
                str(value or "") for value in _ordered_values(input_person_tags, "person_tag_")
            ]
            current_general_tags = (
                input_general_tags if isinstance(input_general_tags, str) else str(input_general_tags or "")
            )
            current_pose_image = torch.from_numpy(render_pose_image(current_pose_json)).unsqueeze(0)
            current_preview = _save_temp_preview(
                node_id,
                input_image,
                current_pose_image,
                current_masks,
                scope="current_inputs",
            )
            current_inputs_preview = {
                **current_preview,
                "pose_json": current_pose_json,
                "general_tags": current_general_tags,
                "person_tags": current_person_tags,
                "image_shape": list(input_image.shape) if input_image is not None else [],
                "mask_count": len(current_masks),
            }

        preview = _save_temp_preview(node_id, image, pose_image, masks_out)
        state = {
            "source": output_source,
            "record_id": gallery_record_id if output_source == "gallery" else "",
            "image": preview["image"],
            "pose": preview["pose"],
            "masks": preview["masks"],
            "pose_json": pose_json,
            "general_tags": general_tags,
            "person_tags": person_tags_out,
            "image_shape": list(image.shape) if torch.is_tensor(image) else [],
            "mask_count": len(masks_out),
        }
        return io.NodeOutput(
            image_output,
            pose_image,
            pose_json,
            masks_output,
            general_tags,
            person_tags_output,
            ui=_PoseGalleryUI(preview, state, saved_record, current_inputs_preview),
        )
