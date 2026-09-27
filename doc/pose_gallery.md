# Pose Gallery Min

## Overview

Pose Gallery Min stores complete image/pose records locally: a source image,
pose JSON, any number of masks, general tags, and tags for each person. Open the
gallery from the node button or its context menu. It starts with an empty
`Default` collection; additional collections can be created in the gallery.

Records are stored under ComfyUI's `input/mincore/pose_gallery/` directory and
survive restarts and custom-node updates. They are not embedded in workflow
files, so workflows that select saved records require the same gallery data on
the machine where they are opened.

## Inputs

- **image** (IMAGE) — source image.
- **pose_json** (STRING) — pose data. The OpenPose image is generated from this
  JSON using the OpenPose Studio renderer; there is no separate pose-image
  input to become inconsistent with the JSON.
- **masks** — dynamic `MASK` inputs (`mask_0`, `mask_1`, …).
- **general_tags** (STRING) — tags for the full record.
- **person_tags** — dynamic STRING inputs (`person_tag_0`, `person_tag_1`, …),
  ordered to correspond to people in the pose JSON.
- **output_source** — `inputs` (default) to use connected values, or `gallery`
  to use the selected saved record.

Inputs are evaluated lazily. In gallery mode the node can load a selected
record without running its upstream inputs. The gallery's **Save current
inputs** button queues the node to capture connected data in the selected
collection.

## Gallery preview

The detail preview layers the source image, rendered pose, and each mask. Image
and pose are visible by default; masks start hidden. The pose is brightened and
its line thickness can be adjusted in the **Preview** section of Settings;
`1.0×` keeps the original thickness. This only affects the preview, not the
node's `OPENPOSE` output, and the setting is saved locally. Use the checkboxes
beside the preview or in the expanded overlay to toggle layers; both sets stay
synchronized, and their visibility settings remain in effect when switching the
preview to another image or record while the gallery is open. The side-panel
preview uses a square frame. Use its expand button to inspect the image in a
larger overlay without changing the record list layout. The layer controls sit
below the expanded image so they do not cover it.
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

## Outputs

- **IMAGE** — source image from the selected source.
- **OPENPOSE** — pose image rendered from `pose_json`.
- **POSE_JSON** — pose JSON.
- **MASKS** — list output containing each mask in input order.
- **GENERAL_TAGS** — general tags.
- **PERSON_TAGS** — list output of per-person tags in person order.

ComfyUI's current node API does not provide dynamic output sockets. Masks and
per-person tags therefore use one list-valued output socket each, not one
physical socket per mask/person. Downstream nodes receive ComfyUI list behavior.

## Collections and records

Each saved record contains the original tensor data in a NumPy archive, plus
PNG previews for browsing. Pose images are regenerated from the stored JSON on
execution. Records are written to the collection selected in the gallery.
