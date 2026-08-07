# OpenPose Studio Min

## Overview

OpenPose Studio Min is a pose editor + renderer node for ComfyUI, ported from the
[ComfyUI-OpenPose-Studio](https://github.com/andreszs/comfyui-openpose-studio)
pack by andreszs. It provides a full in-browser pose editor (canvas, presets,
gallery, merger, render style, localization) and converts the edited pose into:

- a rendered **IMAGE** (body skeleton / hands / face)
- the filtered **JSON** that was edited
- a **POSE_KEYPOINT** output compatible with `comfyui_controlnet_aux` (DWPose)

## Nodes

- **OpenPose Studio Min** (`MinCore_OpenPoseStudio`) — the main pose editor + renderer.
- **Show String** (`MinCore_ShowString`) — a helper output node that displays a
  text value in the UI (input-list aware).

## OpenPose Studio Min — How it works

1. **Editor:** Right-click the node → *Open in Editor* (or click the preview
   widget) to open the full pose editor panel. Drag keypoints, load bundled
   presets, import JSON files, and adjust the canvas size. Right-click a
   keypoint to delete it instantly (equivalent to dragging it into the trash
   target in the top-right corner); the browser context menu is suppressed only
   when a keypoint is hit.
2. **Rendering:** On execution, the `pose_json` widget value is parsed and drawn
   onto a black canvas using the runtime render style (configurable in the
   editor's Render Style tab and synced to the backend via REST).
3. **Outputs:** The rendered image is emitted as IMAGE, the (possibly filtered)
   pose JSON as JSON, and the converted pose as KPS for controlnet nodes.
4. **DWPose passthrough:** If a `POSE_KEYPOINT` is connected to the `pose_keypoint`
   input, it is serialized to JSON and used instead of the `pose_json` widget value.

### Inputs

- **pose_json** (STRING, default: "") — Pose JSON from the editor. Editor format:
  `{"width": W, "height": H, "keypoints": [[[x1,y1], ...], ...]}`.
  Also accepts the standard `{"canvas_width", "canvas_height", "people": [...]}`
  (DWPose) format.
- **render_body** (Boolean, default: True) — Whether to draw the body skeleton.
- **render_hand** (Boolean, default: True) — Whether to draw hands.
- **render_face** (Boolean, default: True) — Whether to draw face keypoints.
- **pose_keypoint** (POSE_KEYPOINT, optional) — When connected, overrides the
  widget value.
- **areas** (CONDITIONING_AREAS, optional) — Conditioning area data shown as an
  overlay in the editor canvas (used with Conditioning Pipeline nodes).
- **background_image** (IMAGE, optional) — When connected, the image is shown as
  the background of the editor canvas (like the local file-picker background).
  The canvas automatically resizes to the image dimensions and existing
  keypoints are scaled proportionally. The image is only used as an editor
  reference; it is not composited into the IMAGE output. Connected inputs
  (`background_image`, `pose_keypoint`) are picked up when the node is queued:
  clicking **Apply** in the editor queues just this node (and its upstream
  dependencies), and the editor toolbar's **Refresh inputs** button re-queues
  it without closing the panel so the background refreshes in place.

The node is registered as an output node, so it can be queued on its own (e.g.
via the editor's **Apply** / **Refresh inputs** buttons) to fetch its inputs
without running downstream nodes.

### Outputs

- **IMAGE** — Rendered pose image (batch of 1, RGB 0-1).
- **JSON** — Filtered pose JSON (components stripped according to the render flags).
- **KPS** — Pose in POSE_KEYPOINT format (`{canvas_width, canvas_height, people}`)
  with flattened `[x, y, conf]` triplets in pixel space.

## Format support

Both **COCO-17** (Ultralytics/TF.js, 17 keypoints, no neck) and **COCO-18**
(OpenPose, 18 keypoints with neck) are detected automatically from the flat
keypoint count and rendered with the appropriate skeleton colors and topology.

## Show String — How it works

A simple output node. Any `text` input received (as a list) is echoed back to
the UI as a read-only multiline display widget.

### Inputs

- **text** (STRING, forceInput) — Text to display.

### Outputs

None (output node).

## Pose library

The bundled `poses/` directory ships with ~40 preset JSON files organized into
categories (`misc/`, `dev/`). Additional pose libraries can be added to ComfyUI
via the `mincore_openpose_poses` model folder key. The editor's Gallery and
preset dropdown load from these files through the `/mincore/openpose/poses` REST
endpoint.

## Render style

Render settings (line width, keypoint radius, colors for body/hands/face) are
stored in the browser's localStorage and synced to the backend via
`POST /mincore/openpose/render_style`. The backend includes a fingerprint of the
current style in the node's cache key (`fingerprint_inputs`), so changing the
style in the editor correctly invalidates ComfyUI's cache and re-renders.

## Localization

The editor UI is localized (11 languages). Language dictionaries live in
`locales/<lang>/ui.json` and are served through
`GET /mincore/openpose/locales/{lang}/ui.json`.
