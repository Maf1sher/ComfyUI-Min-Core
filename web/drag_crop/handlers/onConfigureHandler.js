import { commitState } from "../core/commitState.js";
import { syncCropWidgetsFromProperties } from "../core/cropModel.js";

export function handleOnConfigure(node) {
  delete node.properties.box_color;
  delete node.properties.infoDisplayEnabled;

  node.forceUpdate();

  syncCropWidgetsFromProperties(node);

  commitState(node);
}
