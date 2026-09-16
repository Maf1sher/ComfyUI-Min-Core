import json
import os

import numpy as np
import torch
from comfy_api.latest import io
from PIL import Image

import folder_paths


DEBUG_MODE = False

def debug_print(*args, **kwargs):
    if DEBUG_MODE:
        print(*args, **kwargs)


class DragCrop(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_DragCrop",
            display_name="Drag Crop Min",
            category="Min-Core",
            has_intermediate_output=True,
            inputs=[
                io.String.Input("drawing_version", default="init", socketless=True),
                io.String.Input("aspect_ratio", default="", socketless=True),
                io.Image.Input("image"),
                io.Int.Input("crop_left", default=0, min=0, max=8192, socketless=True),
                io.Int.Input("crop_right", default=0, min=0, max=8192, socketless=True),
                io.Int.Input("crop_top", default=0, min=0, max=8192, socketless=True),
                io.Int.Input("crop_bottom", default=0, min=0, max=8192, socketless=True),
                io.Int.Input("crop_width", default=512, min=1, max=8192, socketless=True),
                io.Int.Input("crop_height", default=512, min=1, max=8192, socketless=True),
                io.Int.Input("last_width", default=0, socketless=True),
                io.Int.Input("last_height", default=0, socketless=True),
                io.Mask.Input("mask", optional=True),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Mask.Output("MASK"),
                io.String.Output("CROP_JSON"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        drawing_version: str,
        aspect_ratio: str,
        image: torch.Tensor,
        crop_left: int,
        crop_right: int,
        crop_top: int,
        crop_bottom: int,
        crop_width: int,
        crop_height: int,
        last_width: int,
        last_height: int,
        mask: torch.Tensor = None,
    ) -> io.NodeOutput:
        node_id = cls.hidden.unique_id
        
        debug_print("=" * 60)
        print(f"[DragCropMin] Node {node_id} executed (Backend)")

        batch_size, current_height, current_width, channels = image.shape

        debug_print("\n[DragCropMin] [Input Image Info]")
        debug_print(f"[DragCropMin] - Current image size: {current_width}x{current_height}")
        debug_print(f"[DragCropMin] - Last image size:    {last_width}x{last_height}")
        debug_print(f"[DragCropMin] - Batch size: {batch_size}, Channels: {channels}")

        resolution_changed = (current_width != last_width or current_height != last_height)
        reset_frontend_crop = False

        if resolution_changed:
            debug_print("\n[DragCropMin] [Resolution Change Detected]")
            debug_print("[DragCropMin] → Forcing full image crop and signaling frontend reset.")
            crop_left = 0
            crop_top = 0
            crop_right = 0
            crop_bottom = 0
            crop_width = current_width
            crop_height = current_height
            reset_frontend_crop = True

        debug_print("\n[DragCropMin] [Crop Inputs]")
        debug_print(f"[DragCropMin] - crop_left:            {crop_left}")
        debug_print(f"[DragCropMin] - crop_right:           {crop_right}")
        debug_print(f"[DragCropMin] - crop_top:             {crop_top}")
        debug_print(f"[DragCropMin] - crop_bottom:          {crop_bottom}")
        debug_print(f"[DragCropMin] - crop_width:           {crop_width}")
        debug_print(f"[DragCropMin] - crop_height:          {crop_height}")
        debug_print(f"[DragCropMin] - Computed crop_right:  {crop_right}")
        debug_print(f"[DragCropMin] - Computed crop_bottom: {crop_bottom}")

        computed_crop_right = crop_left + crop_width
        computed_crop_bottom = crop_top + crop_height

        if (crop_left < 0 or crop_top < 0 or
            computed_crop_right > current_width or computed_crop_bottom > current_height or
            crop_width <= 0 or crop_height <= 0):
            print("\n[DragCropMin] Error invalid crop area → Resetting to full image.")
            crop_left = 0
            crop_top = 0
            crop_right = 0
            crop_bottom = 0
            crop_width = current_width
            crop_height = current_height
            computed_crop_right = crop_left + crop_width
            computed_crop_bottom = crop_top + crop_height
            reset_frontend_crop = True

        cropped_image = image[:, crop_top:computed_crop_bottom, crop_left:computed_crop_right, :]

        def _make_zero_mask(bs, h, w, device):
            return torch.zeros((bs, h, w), dtype=torch.float32, device=device)

        cropped_mask = None
        if mask is None or not torch.is_tensor(mask) or mask.numel() == 0:
            cropped_mask = _make_zero_mask(batch_size, crop_height, crop_width, image.device)
        else:
            m = mask

            if m.dim() == 4 and m.shape[1] == 1:
                m = m.squeeze(1)
            elif m.dim() == 2:
                m = m.unsqueeze(0)

            if m.dim() != 3:
                cropped_mask = _make_zero_mask(batch_size, crop_height, crop_width, image.device)
            else:
                if m.shape[0] != batch_size:
                    if m.shape[0] == 1 and batch_size > 1:
                        m = m.repeat(batch_size, 1, 1)
                    else:
                        if m.shape[0] > batch_size:
                            m = m[:batch_size]
                        else:
                            m = m.repeat(int(np.ceil(batch_size / m.shape[0])), 1, 1)[:batch_size]

                mh, mw = m.shape[1], m.shape[2]

                cl = max(0, min(crop_left, mw))
                cr = max(0, min(computed_crop_right, mw))
                ct = max(0, min(crop_top, mh))
                cb = max(0, min(computed_crop_bottom, mh))

                if cr <= cl or cb <= ct:
                    cropped_mask = _make_zero_mask(batch_size, crop_height, crop_width, image.device)
                else:
                    region = m[:, ct:cb, cl:cr]
                    cropped_mask = _make_zero_mask(batch_size, crop_height, crop_width, image.device)
                    rh, rw = region.shape[1], region.shape[2]
                    cropped_mask[:, :rh, :rw] = region.to(torch.float32)

        debug_print(f"[DragCropMin] - Computed crop_right:  {computed_crop_right}")
        debug_print(f"[DragCropMin] - Computed crop_bottom: {computed_crop_bottom}")

        output_width = crop_width
        output_height = crop_height

        debug_print("\n[DragCropMin] [Output Crop Info]")
        debug_print(f"[DragCropMin] - Output size: {output_width}x{output_height}")
        debug_print(f"[DragCropMin] - Reset frontend crop UI: {reset_frontend_crop}")
        debug_print("=" * 60)

        original_filename = None
        if batch_size > 0:
            img_array = (image[0].cpu().numpy() * 255).astype(np.uint8)
            pil_image = Image.fromarray(img_array)
            temp_dir = folder_paths.get_temp_directory()
            filename_hash = hash(f"{node_id}_{current_width}x{current_height}")
            original_filename = f"dragcrop_original_{filename_hash}.png"
            filepath = os.path.join(temp_dir, original_filename)
            os.makedirs(temp_dir, exist_ok=True)
            try:
                pil_image.save(filepath)
            except Exception as e:
                print(f"[DragCropMin] Error saving preview image: {e}")
                original_filename = None

        crop_payload = {
            "left": crop_left,
            "top": crop_top,
            "right": crop_right,
            "bottom": crop_bottom,
            "width": crop_width,
            "height": crop_height,
            "original_size": [current_width, current_height],
            "cropped_size": [crop_width, crop_height],
            "reset_crop_ui": reset_frontend_crop
        }

        crop_json = json.dumps(crop_payload)

        ui_data = {
            "images_custom": [{
                "filename": original_filename,
                "subfolder": "",
                "type": "temp"
            }] if original_filename else [],
            "crop_info": [crop_payload]
        }

        return io.NodeOutput(cropped_image, cropped_mask, crop_json, ui=ui_data)


class CropInfoInterpreter(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MinCore_CropInfoInterpreter",
            display_name="Crop Info → Values Min",
            category="Min-Core",
            inputs=[
                io.String.Input("crop_json", default=""),
            ],
            outputs=[
                io.Int.Output("left"),
                io.Int.Output("top"),
                io.Int.Output("right"),
                io.Int.Output("bottom"),
                io.Int.Output("width"),
                io.Int.Output("height"),
                io.String.Output("csv"),
                io.String.Output("pretty"),
            ],
        )

    @classmethod
    def execute(cls, crop_json: str) -> io.NodeOutput:
        try:
            data = json.loads(crop_json) if crop_json else {}
        except Exception:
            data = {}

        left   = int(data.get("left",   0))
        top    = int(data.get("top",    0))
        right  = int(data.get("right",  left))
        bottom = int(data.get("bottom", top))
        width  = int(data.get("width",  max(0, right - left)))
        height = int(data.get("height", max(0, bottom - top)))

        csv = f"{left},{top},{right},{bottom},{width},{height}"
        pretty = f"left={left}, top={top}, right={right}, bottom={bottom}, width={width}, height={height}"

        return io.NodeOutput(left, top, right, bottom, width, height, csv, pretty)

