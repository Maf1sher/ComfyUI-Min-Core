# Pose Gallery Min

## Overview

Pose Gallery Min stores complete image/pose records locally: a source image,
pose JSON, any number of masks, general tags, and tags for each person. Open the
gallery from the node button or its context menu. It starts with an empty
`Default` collection; additional collections can be created in the gallery.
The node's **Open Pose Gallery** button stays compact and centered, regardless
of the node's image preview size.

Records are stored under ComfyUI's `input/mincore/pose_gallery/` directory and
survive restarts and custom-node updates. They are not embedded in workflow
files, so workflows that select saved records require the same gallery data on
the machine where they are opened.

## Inputs

- **image** (IMAGE) — source image.
- **pose_json** (STRING socket) — optional pose data. The OpenPose image is
  generated from this JSON using the OpenPose Studio renderer; there is no
  separate pose-image input to become inconsistent with the JSON.
- **masks** — dynamic `MASK` inputs (`mask_0`, `mask_1`, …).
- **general_tags** (STRING socket) — optional tags for the full record.
- **person_tags** — dynamic STRING inputs (`person_tag_0`, `person_tag_1`, …),
  ordered to correspond to people in the pose JSON.
- **output_source** — `inputs` (default) to use connected values, or `gallery`
  to use the selected saved record.

Inputs are evaluated lazily. In gallery mode the node can load a selected
record without running its upstream inputs. The gallery's **Save current
inputs** button opens an in-gallery dialog for an optional record name, then
queues the node to capture connected data in the selected collection. Leave the
name blank to use an automatic name. Saving a record requires a valid **image**;
the other inputs may be omitted.

Use **Show current inputs** in the side panel to run the connected inputs and
preview available layers (the image if connected, pose, and masks) and tags
without saving a record or changing the selected gallery output. When the latest
node output already uses inputs, the button reads **Refresh current inputs**.
Both paths display the same details. **Show node output** returns to the current
output preview.

## Gallery preview

The detail preview layers the source image, rendered pose, and each mask. Image
and pose are visible by default; masks start hidden. The pose is brightened and
its line thickness can be adjusted in the **Preview** section of Settings;
`1.0×` keeps the original thickness. This only affects the preview, not the
node's `OPENPOSE` output, and the setting is saved locally. Use the checkboxes
beside the preview or in the expanded overlay to toggle layers; both sets stay
synchronized, and their visibility settings remain in effect when switching the
preview to another image or record while the gallery is open. The side-panel
preview uses a square frame. Its layer controls remain fully visible while
long record details scroll independently. Use its expand button to inspect the
image in a larger overlay without changing the record list layout. The layer
controls sit below the expanded image so they do not cover it.
General tags are shown separately from per-person tags. Each person's tags are
shown in their own detail row, using the same right-aligned tag styling as the
other record details. The record details also show the source image resolution
in width × height pixels.

Saved records are shown as image cards with their name, save date, mask count,
and tags. The gallery offers medium, large, and compact tile layouts; selecting a
card opens its layered preview and record details in the side panel. The gallery
follows the active ComfyUI color theme. When a collection has fewer records than
fit across the gallery, its cards expand to use the available width.
Record thumbnails load as they approach the visible area. Collection loading
shows progress and offers a retry if the request fails.
Select a record and use **Delete record** in the side panel to permanently remove
it and its stored files. A confirmation dialog opens inside the gallery. If the
deleted record is currently selected as the node output, the node switches back
to its connected inputs.

## Outputs

- **IMAGE** — source image from the selected source.
- **OPENPOSE** — pose image rendered from `pose_json`.
- **POSE_JSON** — pose JSON.
- **MASKS** — list output containing each mask in input order.
- **GENERAL_TAGS** — general tags.
- **PERSON_TAGS** — list output of per-person tags in person order.

In `inputs` mode, missing values do not prevent the other outputs from being
returned. If no image is connected, `IMAGE` is a black placeholder matching the
rendered pose size (512 × 512 when the pose is empty). If no masks are available,
`MASKS` contains one zero-valued placeholder mask matching the output image size;
this also applies to gallery records without masks. If there are no person tags,
`PERSON_TAGS` contains one empty string; configured blank slots remain empty
strings to preserve person order. `POSE_JSON` and `GENERAL_TAGS` are empty
strings when omitted, and `OPENPOSE` is still rendered from `pose_json`. These
placeholders keep downstream IMAGE and MASK inputs type-valid, but they are
synthetic values and may affect downstream results. Saving a record still
requires an actual connected image. In `gallery` mode, a record must be selected.

ComfyUI's current node API does not provide dynamic output sockets. Masks and
per-person tags therefore use one list-valued output socket each, not one
physical socket per mask/person. Downstream nodes receive ComfyUI list behavior.

## Collections and records

Each saved record contains the original tensor data in a NumPy archive, plus
PNG previews for browsing. Pose images are regenerated from the stored JSON on
execution. Records are written to the collection selected in the gallery.
