"""Pose Gallery Min: persist and browse complete image/pose/mask/tag records."""

import os
import re

import torch
from comfy_api.latest import io
from comfy_api.latest._io import _UIOutput

from ..openpose_studio import get_runtime_render_style_fingerprint, render_pose_image
from . import api as gallery_api
from . import preview as gallery_preview
from . import store as gallery_store


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
        if self.preview.get("node_preview") is not None:
            result["images"] = [self.preview["node_preview"]]
        return result


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
                "Browse and save pose JSON, masks, and tags with an optional image as gallery records. "
                "Outputs either the connected inputs or a selected record."
            ),
            search_aliases=["pose gallery", "image pose collection", "pose dataset"],
            inputs=[
                io.Image.Input(
                    "image", optional=True, lazy=True,
                    tooltip="Optional source image; records can be saved without one.",
                ),
                io.String.Input("pose_json", default="", optional=True, lazy=True, force_input=True,
                                tooltip="Pose JSON. The OpenPose preview is generated from this value."),
                io.Autogrow.Input("masks", template=mask_template, optional=True,
                                  tooltip="One optional MASK input per person/layer."),
                io.String.Input("general_tags", default="", optional=True, lazy=True, force_input=True,
                                tooltip="Tags describing the complete image/pose record."),
                io.Autogrow.Input("person_tags", template=person_tag_template, optional=True,
                                  tooltip="Dynamic tags for each person, in pose JSON order."),
                io.Boolean.Input(
                    "show_image",
                    display_name="Show Image",
                    default=True,
                    socketless=True,
                    tooltip="Show or hide the source image in the node preview.",
                ),
                io.Boolean.Input(
                    "show_openpose",
                    display_name="Show OpenPose",
                    default=True,
                    socketless=True,
                    tooltip="Show or hide the rendered pose in the node preview.",
                ),
                io.Boolean.Input(
                    "show_masks",
                    display_name="Show Masks",
                    default=False,
                    socketless=True,
                    tooltip="Show or hide all masks in the node preview.",
                ),
                io.Combo.Input("output_source", options=["inputs", "gallery"], default="inputs",
                               tooltip=(
                                   "Choose connected inputs or a selected gallery record. "
                                   "If no record is selected, connected inputs are used."
                               )),
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
    def fingerprint_inputs(
        cls,
        output_source="inputs",
        gallery_record_id="",
        show_image=True,
        show_openpose=True,
        show_masks=False,
        **_kwargs,
    ):
        node_id = str(cls.hidden.unique_id)
        capture = gallery_api.get_pending_capture(node_id)
        parts = [
            str(output_source),
            str(gallery_record_id),
            str(bool(show_image)),
            str(bool(show_openpose)),
            str(bool(show_masks)),
        ]
        parts.append(capture["token"] if capture else gallery_api.get_last_capture_token(node_id))
        if output_source == "gallery" and gallery_record_id:
            try:
                stat = os.stat(os.path.join(gallery_store.record_dir(gallery_record_id), "data.npz"))
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
        gallery_record_id="",
        **kwargs,
    ):
        node_id = str(cls.hidden.unique_id)
        if output_source == "gallery" and gallery_record_id and not gallery_api.has_pending_capture(node_id):
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
        show_image=True,
        show_openpose=True,
        show_masks=False,
        output_source="inputs",
        gallery_collection_id="default",
        gallery_record_id="",
        **_kwargs,
    ) -> io.NodeOutput:
        node_id = str(cls.hidden.unique_id)
        capture_request = gallery_api.consume_pending_capture(node_id)
        input_image = image
        input_pose_json = pose_json
        input_masks = masks
        input_general_tags = general_tags
        input_person_tags = person_tags

        if output_source == "gallery" and not gallery_record_id:
            output_source = "inputs"

        if output_source == "gallery":
            manifest, image, masks_out = gallery_store.load_record(gallery_record_id)
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
        elif gallery_store.is_valid_image(image):
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
            saved_record = gallery_store.save_record(
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
            if input_image is not None and not gallery_store.is_valid_image(input_image):
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
            current_preview = gallery_preview.save_temp_preview(
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

        preview = gallery_preview.save_temp_preview(
            node_id,
            image,
            pose_image,
            masks_out,
            show_image=bool(show_image),
            show_openpose=bool(show_openpose),
            show_masks=bool(show_masks),
        )
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
