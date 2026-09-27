# Pose Gallery Min

## Overview

Pose Gallery Min stores pose records locally: an optional source image, pose
JSON, any number of masks, general tags, and tags for each person. Open the
gallery from the node button or its context menu. It starts with an empty
`Default` collection; additional collections can be created with an in-gallery
dialog. Non-default collections can also be deleted; deleting one permanently
deletes all records and files stored in that collection after confirmation.
The `Default` collection cannot be deleted.
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
  to use the selected saved record. If no record is selected, the node falls
  back to the connected inputs.

Inputs are evaluated lazily. In gallery mode the node can load a selected
record without running its upstream inputs. The preview panel's **Save as
record** button opens an in-gallery dialog for an optional record name, then
queues the node to capture connected data in the selected collection. Choose the
destination collection in the gallery toolbar. Leave the name blank to use an
automatic name. The **image** is optional; pose JSON, masks, and tags can be
saved without one. Any connected image must be a valid IMAGE tensor.
Pose JSON is limited to 5 MB, and rendered canvases are limited to 16,384 pixels
per side and 20 megapixels. Masks must be non-empty 2D, 3D, or 4D tensors. When
person-tag slots are configured but their count differs from the people found in
the pose JSON, the gallery shows a warning; execution is not blocked.

Use **Preview inputs** in the side panel to run the connected inputs and
preview available layers (the image if connected, pose, and masks) and tags
without saving a record or changing the selected gallery output. When the latest
node output already uses inputs, the button reads **Refresh preview**.
Both paths display the same details. **Show node output** returns to the current
output preview.

## Node preview

The node preview combines the image, rendered OpenPose, and masks. Use the
**Show Image**, **Show OpenPose**, and **Show Masks** Boolean widgets to choose
which layers appear; image and OpenPose are enabled by default, while masks are
hidden. **Show Masks** toggles all masks together. These settings only affect
the node preview, not its output sockets or saved gallery records. Run the node
again after changing a setting to refresh the preview. The composite preview is
capped at 1024 pixels on its longest side, and temporary
gallery layers at 2048 pixels. Output sockets and saved record data retain
their original dimensions.

## Gallery preview

The detail preview layers the source image, rendered pose, and each mask. Image
and available pose are visible by default; masks start hidden. The pose layer
control is omitted when a record has no pose keypoints. The pose is brightened
and its line thickness can be adjusted in the **Preview** section of Settings;
`1.0×` keeps the original thickness. This only affects the preview, not the
node's `OPENPOSE` output, and the setting is saved locally. Use the checkboxes
beside the preview or in the expanded overlay to toggle layers; both sets stay
synchronized, and their visibility settings remain in effect when switching the
preview to another image or record while the gallery is open. The side-panel
preview uses a square frame. Its layer controls remain fully visible while
long record details scroll independently. Use its expand button to inspect the
image in a larger overlay without changing the record list layout. The layer
controls sit below the expanded image so they do not cover it.
The side panel separates actions for the selected saved record from actions for
connected inputs. Use **Use selected record** to make the previewed record the
node output; preview or save connected inputs in their own section. Saving adds
a new record to the collection selected in the toolbar. Record management
actions are in the gallery toolbar. Each card has a separate checkbox, so
selecting records for group actions does not change the record shown in the
preview.
General tags are shown separately from per-person tags. Each person's tags are
shown in their own detail row, using the same right-aligned tag styling as the
other record details. The record details also show the source image resolution
in width × height pixels. Missing detail values are shown as a hyphen (-).

Saved records are shown as image cards with their name, save date, mask count,
and tags. Use the **Card layers** controls to show or hide image, pose, and mask
layers on every list thumbnail; image and pose are enabled by default, and masks
are hidden. These preferences are saved locally and do not affect the detail
preview. The gallery offers medium, large, and compact tile layouts; selecting a
card opens its layered preview and record details in the side panel. The gallery
follows the active ComfyUI color theme. When a collection has fewer records than
fit across the gallery, its cards expand to use the available width.
Record thumbnails load as they approach the visible area. The gallery renders
up to 48 cards per page, and reuses generated 360 × 270 thumbnails instead of
downloading full-resolution layers for every card. Collection loading shows
progress and offers a retry if the request fails.
Use **Select page** to select all records currently shown on the page, or toggle
individual card checkboxes. Page selection follows the current search results;
selected records remain selected while changing pages or search terms, and are
cleared when changing collections. **Clear selection** removes all checks. When
one or more records are checked, **Move selected** and **Delete selected** apply
to those records; with no checked records, the actions apply to the record shown
in the preview. Deletion requires confirmation and permanently removes the
selected records and their files. If a deleted record is currently used as the
node output, the node switches back to its connected inputs.

Choose a destination in the move dialog to move one or more records without
deleting or copying their data. The gallery opens the destination collection
with one of the moved records selected for preview. Record IDs and current node
outputs stay unchanged.

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
synthetic values and may affect downstream results. A saved record may omit its
source image; its gallery thumbnail then uses the rendered pose preview. In
`gallery` mode, a selected record is used; if none is selected, outputs follow
the connected inputs instead.

ComfyUI's current node API does not provide dynamic output sockets. Masks and
per-person tags therefore use one list-valued output socket each, not one
physical socket per mask/person. Downstream nodes receive ComfyUI list behavior.

## Collections and records

Each saved record contains the original tensor data in a NumPy archive, plus
PNG previews for browsing. Small card thumbnails are generated on demand and
stored alongside those previews. Pose images are regenerated from the stored
JSON on execution. Records are written to the collection selected in the gallery.
Moving a record updates its collection assignment while retaining the record and
all stored files. Use **Delete collection** to permanently remove a non-default
collection and all of its saved records; the confirmation shows how many records
will be deleted.
The `Default` collection is protected from deletion.
