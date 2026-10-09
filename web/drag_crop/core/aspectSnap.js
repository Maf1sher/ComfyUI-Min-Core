export function _applySnapToDragBox(nodeCtx, snapValue, preview) {
  const scaleX = nodeCtx.actualImageWidth / preview.width;
  const scaleY = nodeCtx.actualImageHeight / preview.height;

  let startX = Math.min(nodeCtx.dragStart[0], nodeCtx.dragEnd[0]) * scaleX;
  let startY = Math.min(nodeCtx.dragStart[1], nodeCtx.dragEnd[1]) * scaleY;
  let width = Math.abs(nodeCtx.dragEnd[0] - nodeCtx.dragStart[0]) * scaleX;
  let height = Math.abs(nodeCtx.dragEnd[1] - nodeCtx.dragStart[1]) * scaleY;

  let snappedWidth = Math.round(width / snapValue) * snapValue;
  let snappedHeight = Math.round(height / snapValue) * snapValue;

  if (startX + snappedWidth > nodeCtx.actualImageWidth) {
    snappedWidth =
      Math.floor((nodeCtx.actualImageWidth - startX - 1) / snapValue) *
      snapValue;
  }

  if (startY + snappedHeight > nodeCtx.actualImageHeight) {
    snappedHeight =
      Math.floor((nodeCtx.actualImageHeight - startY - 1) / snapValue) *
      snapValue;
  }

  snappedWidth = Math.max(snapValue, snappedWidth);
  snappedHeight = Math.max(snapValue, snappedHeight);

  let endX = startX + snappedWidth;
  let endY = startY + snappedHeight;

  const previewDragStart = [startX / scaleX, startY / scaleY];
  const previewDragEnd = [endX / scaleX, endY / scaleY];

  return { dragStart: previewDragStart, dragEnd: previewDragEnd };
}

export function getLockedAspectRatio(aspectRatio) {
  if (
    typeof aspectRatio !== "number" ||
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    return null;
  }

  return aspectRatio;
}
