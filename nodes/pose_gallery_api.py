"""HTTP endpoints and capture requests for Pose Gallery."""

import json
import math
import os
import re
import shutil
import uuid
from io import BytesIO

from aiohttp import web
from PIL import Image as PILImage
from server import PromptServer

import folder_paths
from . import pose_gallery_store as gallery_store
from .openpose_studio import render_pose_image


_pending_captures: dict[str, dict] = {}
_last_capture_tokens: dict[str, str] = {}


def get_pending_capture(node_id: str) -> dict | None:
    return _pending_captures.get(node_id)


def has_pending_capture(node_id: str) -> bool:
    return node_id in _pending_captures


def consume_pending_capture(node_id: str) -> dict | None:
    capture = _pending_captures.pop(node_id, None)
    if capture:
        _last_capture_tokens[node_id] = capture["token"]
    return capture


def get_last_capture_token(node_id: str) -> str:
    return _last_capture_tokens.get(node_id, "")


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
        png = gallery_store._manifest_preview_array(pose_array, channels=3)
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
    return web.json_response({"collections": gallery_store._read_collections()})


@routes.post("/mincore/pose_gallery/collections")
async def _create_collection(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    name = str(payload.get("name", "")).strip()[:100] if isinstance(payload, dict) else ""
    if not name:
        return web.json_response({"error": "Collection name is required"}, status=400)
    collections = gallery_store._read_collections()
    if any(item.get("name", "").casefold() == name.casefold() for item in collections):
        return web.json_response({"error": "A collection with that name already exists"}, status=409)
    collection = {"id": uuid.uuid4().hex, "name": name}
    collections.append(collection)
    gallery_store._write_json(gallery_store._collections_path(), {"collections": collections})
    return web.json_response(collection)


@routes.get("/mincore/pose_gallery/records")
async def _get_records(request: web.Request) -> web.Response:
    collection_id = request.rel_url.query.get("collection_id", "default")
    try:
        return web.json_response({"records": gallery_store._list_records(collection_id)})
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=404)


@routes.get("/mincore/pose_gallery/records/{record_id}")
async def _get_record(request: web.Request) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    try:
        manifest = gallery_store._read_manifest(record_id)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    if manifest is None:
        return web.json_response({"error": "Record not found"}, status=404)
    image_path = os.path.join(gallery_store._record_dir(record_id), "image.png")
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
        directory = gallery_store._record_dir(record_id)
        manifest = gallery_store._read_manifest(record_id)
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
        manifest = gallery_store._read_manifest(record_id)
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
    record_dir = gallery_store._record_dir(record_id)
    path = os.path.join(record_dir, filename)
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
    action = str(payload.get("action", "save"))
    collection_id = str(payload.get("collection_id", "default"))
    if not re.fullmatch(r"\d{1,12}", node_id):
        return web.json_response({"error": "Invalid node ID"}, status=400)
    if action not in ("save", "preview"):
        return web.json_response({"error": "Invalid capture action"}, status=400)
    if action == "save" and gallery_store._find_collection(collection_id) is None:
        return web.json_response({"error": "Unknown collection"}, status=404)
    token = uuid.uuid4().hex
    _pending_captures[node_id] = {
        "token": token,
        "action": action,
        "collection_id": collection_id,
        "name": str(payload.get("name", ""))[:120],
    }
    return web.json_response({"ok": True, "token": token})
