import { commitState } from "../core/commitState.js";
import { syncCropWidgetsFromProperties } from "../core/cropModel.js";
import { removeNodeInputs } from "../utils/nodeUtils.js";

export function handleOnConfigure(node) {
  delete node.properties.box_color;
  delete node.properties.infoDisplayEnabled;

  removeNodeInputs(node);

  node.forceUpdate();

  syncCropWidgetsFromProperties(node);

  commitState(node);
}
