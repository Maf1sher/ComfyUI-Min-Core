# Image Compositor Min

Image Compositor Min places a source image over a background image. Open the
editor from the node button or its context menu to reposition and scale the
background. The source image stays fixed and defines the output dimensions.

The editor shows the source over the background. **Show guides** toggles the
outline around the source frame and the dimming outside it. A separate checkbox
controls whether background outside the frame is shown. These editor aids are
not part of the output. Drag anywhere in the preview to move the background;
use the mouse wheel over the source frame to scale it around the pointer, or
enter the current transform values in the editor.
Click **Refresh Images** to run the node and reload the source and background
previews; connected inputs, including the optional source mask, are resolved by
the normal node execution. The node is also an execution target, so a normal
workflow run evaluates it even when its output is not connected downstream.
Click **Apply** to update the node output. Transform values are stored with the
workflow; the guide-visibility and outside-background preferences are local to
the browser.

## Inputs

- **source** (IMAGE) — foreground image. Its width and height define the output
  frame; it is not scaled or repositioned.
- **background** (IMAGE) — image shown below the source. It is initially scaled
  to cover the source frame and centered.
- **source_mask** (MASK, optional) — transparency mask for the source. A value of
  1 means transparent, matching the alpha mask from ComfyUI's **Load Image**.
  If the source IMAGE already has an alpha channel, the mask is applied in
  addition to it.

The background position is expressed as an offset in source-frame pixels from
its centered cover position. Scale is a percentage relative to the minimum size
that covers the frame; 100% is the default. The background is constrained to
cover the full frame, so moving or scaling it does not expose empty areas.

## Outputs

- **IMAGE** — source composited over the positioned background, with the same
  batch size, width, and height as `source`.

When processing a batch, the editor previews its first image pair; the same
background transform is applied to every item in the batch.

The editor stores its transform in an internal workflow field. It is not a
visible node control and should not be edited manually.
