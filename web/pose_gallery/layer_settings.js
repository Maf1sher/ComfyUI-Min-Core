const PREVIEW_DEFAULTS = { image: true, pose: true };
const THUMBNAIL_DEFAULTS = { image: true, pose: true, masks: false };
const LAYER_SETTINGS_WIDGET = "gallery_layer_visibility";

function readSettings(node) {
    const raw = node.widgets?.find((widget) => widget.name === LAYER_SETTINGS_WIDGET)?.value;
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function readBooleanMap(value, defaults, allowMaskLayers = false) {
    const result = { ...defaults };
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;

    for (const [key, visible] of Object.entries(value)) {
        const validKey = Object.prototype.hasOwnProperty.call(defaults, key)
            || (allowMaskLayers && /^mask:(?:[0-9]|[1-9][0-9])$/.test(key));
        if (validKey && typeof visible === "boolean") result[key] = visible;
    }
    return result;
}

export function getNodeLayerSettings(node) {
    const stored = readSettings(node);
    return {
        previewLayerVisibility: readBooleanMap(stored.preview, PREVIEW_DEFAULTS, true),
        thumbnailLayerVisibility: readBooleanMap(stored.thumbnails, THUMBNAIL_DEFAULTS),
    };
}

export function saveNodeLayerSettings(state, setWidget) {
    setWidget(state.node, LAYER_SETTINGS_WIDGET, JSON.stringify({
        preview: state.previewLayerVisibility,
        thumbnails: state.thumbnailLayerVisibility,
    }));
}
