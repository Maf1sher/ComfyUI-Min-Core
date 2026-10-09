export const DEFAULT_SIZE = 512;
export const MIN_CROP_DIMENSION = 1;
export const DEFAULT_SNAP_VALUE = "none";
export const WIDGET_ROW_H = 25;

export const LAYOUT = {
  PADDING_X: 40,
  PADDING_Y: 10,
  CROPINFO_OFFSET: 70,
  HEADER_H: 105,
  INSTRUCTIONS_H: 20,
  WIDGET_ROW_H: 25,
  PREVIEW_MIN_W: 160,
  PREVIEW_MAX_W: 1024,
  DEFAULT_PREVIEW_W: 320,
  DEFAULT_PREVIEW_SCALE: 0.33,
};

export const GRAPHICS = {
  handleSize: 4,
  handleLineWidth: 1,
  cropBox: "#d5ff6b",
  cropHandleFill: "#85af1b",
  border: "#555",
  borderLineWidth: 1,
  colorDim: "#777",
  colorDimFill: "#333",
  croppedDarken: "rgba(0, 0, 0, 0.65)",
  cropLineWidth: 1,
};

export const TEXT = {
  cropBoxFont: "12px Arial",
  fontSmall: "10px Arial",
  colorFontSmall: "#aaa",
  fontMedium: "12px Arial",
  colorDimText: "#666",
  fontMessage: "14px Arial",
};

export const TEXTCONTENT = {
  imageAreaInfoMsgRow1: "Out of sync, run Graph to get preview",
  imageAreaInfoMsgRow2: "Crop values reset on sync; run the graph before editing.",
  usageInstructionMsg: "Drag in the preview to select a crop area.",
  snapToWidget: "Snap to",
  aspectRatioWidget: "aspect_ratio",
  aspectRatioLockWidget: "Aspect Ratio Lock",
};
