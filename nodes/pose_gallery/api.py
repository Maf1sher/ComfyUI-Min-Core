"""HTTP endpoints and capture requests for Pose Gallery."""

import asyncio
import json
import math
import os
import re
import uuid
from io import BytesIO
from typing import Literal, TypedDict

from aiohttp import web
from PIL import Image as PILImage
from server import PromptServer

import folder_paths
from ..openpose_studio import count_pose_people, is_pose_json_size_valid, render_pose_image
from . import store as gallery_store


__all__ = [
    "CaptureRequest",
    "consume_pending_capture",
    "get_last_capture_token",
    "get_pending_capture",
    "has_pending_capture",
]


class CaptureRequest(TypedDict):
    token: str
    action: Literal["save", "preview"]
    collection_id: str
    name: str


_pending_captures: dict[str, CaptureRequest] = {}
_last_capture_tokens: dict[str, str] = {}


def get_pending_capture(node_id: str) -> CaptureRequest | None:
    return _pending_captures.get(node_id)


def has_pending_capture(node_id: str) -> bool:
    return node_id in _pending_captures


def consume_pending_capture(node_id: str) -> CaptureRequest | None:
    capture = _pending_captures.pop(node_id, None)
    if capture:
        _last_capture_tokens[node_id] = capture["token"]
    return capture


def get_last_capture_token(node_id: str) -> str:
    return _last_capture_tokens.get(node_id, "")


routes = PromptServer.instance.routes


def _record_ids(payload: object) -> list[str]:
    if not isinstance(payload, dict):
        raise ValueError("Invalid payload")
    raw_ids = payload.get("record_ids")
    if not isinstance(raw_ids, list) or not raw_ids or any(not isinstance(record_id, str) for record_id in raw_ids):
        raise ValueError("Record IDs must be a non-empty list of strings")
    return list(dict.fromkeys(raw_ids))


@routes.post("/mincore/pose_gallery/preview_pose")
async def _render_pose_preview(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Invalid payload"}, status=400)

    pose_json = payload.get("pose_json")
    if not is_pose_json_size_valid(pose_json):
        return web.json_response({"error": "Invalid pose data"}, status=400)
    try:
        line_width_scale = float(payload.get("line_width_scale", 1.0))
    except (TypeError, ValueError, OverflowError):
        return web.json_response({"error": "Invalid line width scale"}, status=400)
    if not math.isfinite(line_width_scale) or not 0.5 <= line_width_scale <= 2.5:
        return web.json_response({"error": "Line width scale must be between 0.5 and 2.5"}, status=400)

    try:
        pose_array = render_pose_image(pose_json, line_width_scale=line_width_scale)
        png = gallery_store.manifest_preview_array(pose_array, channels=3)
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
    return web.json_response({"collections": gallery_store.read_collections()})


@routes.post("/mincore/pose_gallery/collections")
async def _create_collection(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    raw_name = payload.get("name", "") if isinstance(payload, dict) else ""
    if not isinstance(raw_name, str):
        return web.json_response({"error": "Collection name must be text"}, status=400)
    name = raw_name.strip()[:100]
    if not name:
        return web.json_response({"error": "Collection name is required"}, status=400)
    collections = gallery_store.read_collections()
    if any(item.get("name", "").casefold() == name.casefold() for item in collections):
        return web.json_response({"error": "A collection with that name already exists"}, status=409)
    collection = {"id": uuid.uuid4().hex, "name": name}
    collections.append(collection)
    gallery_store.write_json(gallery_store.collections_path(), {"collections": collections})
    return web.json_response(collection)


@routes.delete("/mincore/pose_gallery/collections/{collection_id}")
async def _delete_collection(request: web.Request) -> web.Response:
    collection_id = request.match_info.get("collection_id", "")
    try:
        deleted = gallery_store.delete_collection(collection_id)
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read the gallery collection index"}, status=500)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError:
        return web.json_response({"error": "Could not delete the gallery collection"}, status=500)
    if deleted is None:
        return web.json_response({"error": "Collection not found"}, status=404)

    collection, record_ids = deleted
    active_record_id = request.rel_url.query.get("record_id", "")
    return web.json_response({
        "ok": True,
        "id": collection_id,
        "name": collection["name"],
        "deleted_records": len(record_ids),
        "active_record_deleted": active_record_id in record_ids,
    })


@routes.get("/mincore/pose_gallery/records")
async def _get_records(request: web.Request) -> web.Response:
    collection_id = request.rel_url.query.get("collection_id", "default")
    try:
        return web.json_response({"records": gallery_store.list_records(collection_id)})
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=404)


@routes.post("/mincore/pose_gallery/records/batch/delete")
async def _delete_records(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    try:
        record_ids = _record_ids(payload)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)

    try:
        deleted_ids = gallery_store.delete_records(record_ids)
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read a gallery record"}, status=500)
    except FileNotFoundError:
        return web.json_response({"error": "A selected record no longer exists"}, status=404)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError:
        return web.json_response({"error": "Could not delete the selected records"}, status=500)
    return web.json_response({"ok": True, "ids": deleted_ids})


@routes.post("/mincore/pose_gallery/records/batch/move")
async def _move_records(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Invalid payload"}, status=400)
    try:
        record_ids = _record_ids(payload)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    collection_id = payload.get("collection_id")
    if not isinstance(collection_id, str):
        return web.json_response({"error": "Invalid collection ID"}, status=400)

    try:
        moved_ids = gallery_store.move_records(record_ids, collection_id)
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read a gallery record or collection index"}, status=500)
    except FileNotFoundError:
        return web.json_response({"error": "A selected record no longer exists"}, status=404)
    except ValueError as error:
        status = 404 if str(error) == "Unknown gallery collection" else 400
        return web.json_response({"error": str(error)}, status=status)
    except OSError:
        return web.json_response({"error": "Could not move the selected records"}, status=500)
    return web.json_response({"ok": True, "ids": moved_ids, "collection_id": collection_id})


@routes.get("/mincore/pose_gallery/records/{record_id}")
async def _get_record(request: web.Request) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    try:
        manifest = gallery_store.read_manifest(record_id)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    if manifest is None:
        return web.json_response({"error": "Record not found"}, status=404)
    if not isinstance(manifest.get("pose_person_count"), int):
        manifest["pose_person_count"] = count_pose_people(str(manifest.get("pose_json", "")))
    image_path = os.path.join(gallery_store.record_dir(record_id), "image.png")
    has_image = bool(manifest.get("has_image", os.path.isfile(image_path))) and os.path.isfile(image_path)
    manifest["has_image"] = has_image
    manifest["assets"] = {
        "image": (
            f"/mincore/pose_gallery/records/{record_id}/assets/image.png"
            if has_image
            else None
        ),
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
        gallery_store.delete_records([record_id])
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read the gallery record"}, status=500)
    except FileNotFoundError:
        return web.json_response({"error": "Record not found"}, status=404)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError:
        return web.json_response({"error": "Could not delete the gallery record"}, status=500)
    return web.json_response({"ok": True, "id": record_id})


@routes.patch("/mincore/pose_gallery/records/{record_id}")
async def _move_record(request: web.Request) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Invalid payload"}, status=400)
    collection_id = payload.get("collection_id")
    if not isinstance(collection_id, str):
        return web.json_response({"error": "Invalid collection ID"}, status=400)

    try:
        manifest = gallery_store.move_record(record_id, collection_id)
    except json.JSONDecodeError:
        return web.json_response({"error": "Could not read the gallery record or collection index"}, status=500)
    except ValueError as error:
        status = 404 if str(error) == "Unknown gallery collection" else 400
        return web.json_response({"error": str(error)}, status=status)
    except OSError:
        return web.json_response({"error": "Could not move the gallery record"}, status=500)
    if manifest is None:
        return web.json_response({"error": "Record not found"}, status=404)
    return web.json_response({
        "ok": True,
        "id": record_id,
        "collection_id": manifest["collection_id"],
    })


@routes.get("/mincore/pose_gallery/records/{record_id}/assets/{filename}")
async def _get_record_asset(request: web.Request) -> web.StreamResponse:
    record_id = request.match_info.get("record_id", "")
    filename = request.match_info.get("filename", "")
    try:
        manifest = gallery_store.read_manifest(record_id)
    except ValueError as error:
        return web.Response(status=400, text=str(error))
    if manifest is None:
        return web.Response(status=404)
    mask_files = {
        f"mask_{index:04d}.png" for index in range(int(manifest.get("mask_count", 0)))
    }
    allowed = {"image.png", "pose.png", "thumb_image.png", "thumb_pose.png"}
    allowed.update(mask_files)
    allowed.update(f"thumb_{filename}" for filename in mask_files)
    if filename not in allowed:
        return web.Response(status=404)
    record_dir = gallery_store.record_dir(record_id)
    source_name = filename.removeprefix("thumb_")
    source_path = os.path.join(record_dir, source_name)
    if not os.path.isfile(source_path):
        return web.Response(status=404)
    path = (
        await asyncio.to_thread(gallery_store.ensure_record_thumbnail, record_id, source_name)
        if filename.startswith("thumb_")
        else source_path
    )
    if path is None:
        return web.Response(status=404)
    if not os.path.isfile(path) or not folder_paths.is_within_directory(record_dir, path):
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
    action = payload.get("action", "save")
    collection_id = payload.get("collection_id", "default")
    if not re.fullmatch(r"\d{1,12}", node_id):
        return web.json_response({"error": "Invalid node ID"}, status=400)
    if not isinstance(action, str) or action not in ("save", "preview"):
        return web.json_response({"error": "Invalid capture action"}, status=400)
    if not isinstance(collection_id, str):
        return web.json_response({"error": "Invalid collection ID"}, status=400)
    name = payload.get("name", "")
    if not isinstance(name, str):
        return web.json_response({"error": "Record name must be text"}, status=400)
    if action == "save" and gallery_store.find_collection(collection_id) is None:
        return web.json_response({"error": "Unknown collection"}, status=404)
    token = uuid.uuid4().hex
    capture: CaptureRequest = {
        "token": token,
        "action": action,
        "collection_id": collection_id,
        "name": name[:120],
    }
    _pending_captures[node_id] = capture
    return web.json_response({"ok": True, "token": token})
