import { api } from "/scripts/api.js";
import { blobRequest, fileItemUrl } from "./api.js";

const MASK_COLORS = [
    [255, 80, 80], [70, 170, 255], [100, 230, 120],
    [255, 190, 60], [210, 100, 255], [50, 220, 210],
];
const PREVIEW_LINE_WIDTH_KEY = "mincore.poseGallery.previewLineWidth";
export const PREVIEW_LINE_WIDTH_MIN = 0.5;
export const PREVIEW_LINE_WIDTH_MAX = 2.5;
export const PREVIEW_LINE_WIDTH_STEP = 0.1;

function normalizePreviewLineWidth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    const clamped = Math.max(PREVIEW_LINE_WIDTH_MIN, Math.min(PREVIEW_LINE_WIDTH_MAX, number));
    return Number((Math.round(clamped / PREVIEW_LINE_WIDTH_STEP) * PREVIEW_LINE_WIDTH_STEP).toFixed(1));
}

export function getStoredPreviewLineWidth() {
    try {
        return normalizePreviewLineWidth(localStorage.getItem(PREVIEW_LINE_WIDTH_KEY) || 1);
    } catch (_error) {
        return 1;
    }
}

function makePosePreviewImage(image) {
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;

    try {
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
            const red = pixels.data[pixel];
            const green = pixels.data[pixel + 1];
            const blue = pixels.data[pixel + 2];
            const intensity = Math.max(red, green, blue);
            if (!intensity) {
                pixels.data[pixel + 3] = 0;
                continue;
            }

            const colorScale = 255 / intensity;
            pixels.data[pixel] = Math.round(red * colorScale);
            pixels.data[pixel + 1] = Math.round(green * colorScale);
            pixels.data[pixel + 2] = Math.round(blue * colorScale);
            // The renderer dims body limb colors to 60%; restore that contrast
            // in the gallery preview without changing the node's output image.
            pixels.data[pixel + 3] = Math.min(255, Math.round(intensity / 0.6));
        }
        context.putImageData(pixels, 0, 0);
        return canvas;
    } catch (_error) {
        return null;
    }
}

function clearPosePreviewTimer(state) {
    if (state.posePreviewTimer == null) return;
    window.clearTimeout(state.posePreviewTimer);
    state.posePreviewTimer = null;
}

function disposeGeneratedPosePreview(state, layer) {
    if (layer.previewObjectUrl) {
        URL.revokeObjectURL(layer.previewObjectUrl);
        layer.previewObjectUrl = null;
    }
    if (layer.previewGeneratedImage) {
        layer.previewGeneratedImage.onload = null;
        layer.previewGeneratedImage.onerror = null;
        const imageIndex = state.previewImages.indexOf(layer.previewGeneratedImage);
        if (imageIndex !== -1) state.previewImages.splice(imageIndex, 1);
        layer.previewGeneratedImage = null;
    }
}

async function loadScaledPosePreview(state, layer, previewRevision, requestId) {
    try {
        const blob = await blobRequest("/mincore/pose_gallery/preview_pose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                pose_json: layer.poseJson,
                line_width_scale: state.previewLineWidth,
            }),
        });
        if (
            previewRevision !== state.previewRevision
            || requestId !== state.posePreviewRequestId
            || state.closing
        ) return;

        disposeGeneratedPosePreview(state, layer);
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        layer.previewObjectUrl = objectUrl;
        layer.previewGeneratedImage = image;
        state.previewImages.push(image);
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            if (layer.previewObjectUrl === objectUrl) layer.previewObjectUrl = null;
            if (
                previewRevision !== state.previewRevision
                || requestId !== state.posePreviewRequestId
                || state.closing
            ) return;
            layer.previewImage = makePosePreviewImage(image);
            renderPreview(state);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            if (layer.previewObjectUrl === objectUrl) layer.previewObjectUrl = null;
            if (previewRevision !== state.previewRevision || requestId !== state.posePreviewRequestId || state.closing) return;
            disposeGeneratedPosePreview(state, layer);
            layer.previewImage = layer.basePreviewImage;
            renderPreview(state);
        };
        image.src = objectUrl;
    } catch (_error) {
        if (previewRevision !== state.previewRevision || requestId !== state.posePreviewRequestId || state.closing) return;
        layer.previewImage = layer.basePreviewImage;
        renderPreview(state);
    }
}

export function setPreviewLineWidth(state, value) {
    state.previewLineWidth = normalizePreviewLineWidth(value);
    try {
        localStorage.setItem(PREVIEW_LINE_WIDTH_KEY, String(state.previewLineWidth));
    } catch (_error) {
        // The setting still applies to the current gallery if storage is unavailable.
    }

    const slider = state.root.querySelector('[data-role="preview-line-width"]');
    if (slider) slider.value = String(Math.round(state.previewLineWidth * 100));
    const output = state.root.querySelector('[data-role="preview-line-width-value"]');
    if (output) output.textContent = `${state.previewLineWidth.toFixed(1)}×`;

    clearPosePreviewTimer(state);
    const requestId = (state.posePreviewRequestId || 0) + 1;
    state.posePreviewRequestId = requestId;
    const layer = state.previewLayers.find((item) => item.type === "pose");
    if (!layer || !layer.basePreviewImage) return;

    if (state.previewLineWidth === 1 || !layer.poseJson) {
        disposeGeneratedPosePreview(state, layer);
        layer.previewImage = layer.basePreviewImage;
        renderPreview(state);
        return;
    }

    const previewRevision = state.previewRevision;
    state.posePreviewTimer = window.setTimeout(() => {
        state.posePreviewTimer = null;
        void loadScaledPosePreview(state, layer, previewRevision, requestId);
    }, 120);
}

export function displayUrl(urlOrItem) {
    return typeof urlOrItem === "string" ? api.apiURL(urlOrItem) : fileItemUrl(urlOrItem);
}

export function drawRecordThumbnail(canvas, recordId) {
    const image = new Image();
    const drawUnavailable = () => {
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        const color = getComputedStyle(canvas.closest(".mcore-pg-gallery") || canvas)
            .getPropertyValue("--openpose-text-muted").trim() || "#999";
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        context.strokeStyle = color;
        context.globalAlpha = 0.72;
        context.lineWidth = 2;
        context.strokeRect(centerX - 17, centerY - 23, 34, 34);
        context.beginPath();
        context.moveTo(centerX - 12, centerY + 5);
        context.lineTo(centerX - 3, centerY - 4);
        context.lineTo(centerX + 3, centerY + 2);
        context.lineTo(centerX + 8, centerY - 3);
        context.lineTo(centerX + 13, centerY + 4);
        context.stroke();
        context.globalAlpha = 1;
        context.fillStyle = color;
        context.font = "500 12px Inter, Segoe UI, Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillText("Preview unavailable", centerX, centerY + 23, canvas.width - 20);
    };
    image.onload = () => {
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (!image.naturalWidth || !image.naturalHeight) {
            drawUnavailable();
            return;
        }
        const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    };
    image.onerror = drawUnavailable;
    image.src = api.apiURL(`/mincore/pose_gallery/records/${recordId}/assets/image.png`);
}

export function setPreviewSource(state, preview) {
    state.previewRevision = (state.previewRevision || 0) + 1;
    const revision = state.previewRevision;
    clearPosePreviewTimer(state);
    state.posePreviewRequestId = (state.posePreviewRequestId || 0) + 1;
    state.previewLayers.forEach((layer) => disposeGeneratedPosePreview(state, layer));
    state.previewImages.forEach((image) => { image.onload = null; image.onerror = null; });
    state.previewImages = [];
    const controlContainers = [
        state.root.querySelector('[data-role="layer-controls"]'),
        state.root.querySelector('[data-role="expanded-layer-controls"]'),
    ].filter(Boolean);
    controlContainers.forEach((controls) => controls.replaceChildren());

    const layers = [
        {
            name: "Image",
            type: "image",
            url: displayUrl(preview.image),
            visibilityKey: "image",
            visible: state.previewLayerVisibility.image ?? true,
        },
        {
            name: "Pose",
            type: "pose",
            url: displayUrl(preview.pose),
            poseJson: typeof preview.pose_json === "string" ? preview.pose_json : "",
            visibilityKey: "pose",
            visible: state.previewLayerVisibility.pose ?? true,
        },
        ...(preview.masks || []).map((mask, index) => ({
            name: `Mask ${index + 1}`,
            type: "mask",
            url: displayUrl(mask),
            visibilityKey: `mask:${index}`,
            visible: state.previewLayerVisibility[`mask:${index}`] ?? false,
            color: MASK_COLORS[index % MASK_COLORS.length],
        })),
    ].filter((layer) => layer.url);
    state.previewLayers = layers;

    for (const layer of layers) {
        layer.visibilityInputs = [];
        for (const controls of controlContainers) {
            const label = document.createElement("label");
            label.className = "mcore-pg-layer-option";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = layer.visible;
            checkbox.addEventListener("change", () => {
                layer.visible = checkbox.checked;
                state.previewLayerVisibility[layer.visibilityKey] = layer.visible;
                layer.visibilityInputs.forEach((input) => { input.checked = layer.visible; });
                renderPreview(state);
            });
            const text = document.createElement("span");
            text.textContent = layer.name;
            label.append(checkbox, text);
            controls.appendChild(label);
            layer.visibilityInputs.push(checkbox);
        }

        const image = new Image();
        state.previewImages.push(image);
        image.onload = () => {
            if (state.previewRevision === revision) {
                layer.image = image;
                if (layer.type === "pose") {
                    layer.basePreviewImage = makePosePreviewImage(image);
                    layer.previewImage = layer.basePreviewImage;
                    if (state.previewLineWidth !== 1 && layer.poseJson) {
                        setPreviewLineWidth(state, state.previewLineWidth);
                    }
                }
                renderPreview(state);
            }
        };
        image.onerror = () => {
            if (state.previewRevision === revision) renderPreview(state);
        };
        image.src = layer.url;
    }

    resizePreviewCanvas(state);
    renderPreview(state);
    updateRecordDetails(state, preview.record || null);
    const actionsBusy = state.selectionPending || state.deletingRecordId != null || state.usingRecord;
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord || actionsBusy;
    state.root.querySelector('[data-action="delete-record"]').disabled = !state.selectedRecord || actionsBusy;
}

export function resizePreviewCanvas(state) {
    const canvas = state.root.querySelector('[data-role="preview"]');
    const frame = canvas?.closest(".mcore-pg-preview-wrap");
    if (!canvas || !frame) return;
    const width = Math.max(1, Math.round(frame.clientWidth || 240));
    const height = Math.max(1, Math.round(frame.clientHeight || 220));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    if (state.previewExpanded) {
        const expanded = state.root.querySelector('[data-role="expanded-preview"]');
        if (expanded) {
            const expandedWidth = Math.max(1, Math.round(expanded.clientWidth || 1));
            const expandedHeight = Math.max(1, Math.round(expanded.clientHeight || 1));
            if (expanded.width !== expandedWidth || expanded.height !== expandedHeight) {
                expanded.width = expandedWidth;
                expanded.height = expandedHeight;
            }
        }
    }
    renderPreview(state);
}

function containRect(canvas, image) {
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height };
}

function renderPreview(state) {
    const canvases = [state.root.querySelector('[data-role="preview"]')];
    if (state.previewExpanded) {
        canvases.push(state.root.querySelector('[data-role="expanded-preview"]'));
    }
    for (const canvas of canvases) renderPreviewToCanvas(state, canvas);
}

function renderPreviewToCanvas(state, canvas) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, canvas.width, canvas.height);
    const imageLayer = state.previewLayers.find((layer) => layer.type === "image" && layer.image);
    const poseLayer = state.previewLayers.find((layer) => layer.type === "pose" && layer.image);
    const reference = imageLayer?.image || poseLayer?.image || state.previewLayers.find((layer) => layer.image)?.image;
    if (!reference) return;
    const rect = containRect(canvas, reference);

    if (imageLayer?.visible) {
        context.drawImage(imageLayer.image, rect.x, rect.y, rect.width, rect.height);
    }
    if (poseLayer?.visible) {
        if (poseLayer.previewImage) {
            context.drawImage(poseLayer.previewImage, rect.x, rect.y, rect.width, rect.height);
        } else {
            context.save();
            context.globalCompositeOperation = "screen";
            context.globalAlpha = 0.92;
            context.drawImage(poseLayer.image, rect.x, rect.y, rect.width, rect.height);
            context.restore();
        }
    }
    for (const [index, layer] of state.previewLayers.entries()) {
        if (layer.type !== "mask" || !layer.visible || !layer.image) continue;
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
        if (!maskContext) continue;
        maskContext.drawImage(layer.image, rect.x, rect.y, rect.width, rect.height);
        const pixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        const color = layer.color || MASK_COLORS[index % MASK_COLORS.length];
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
            const alpha = pixels.data[pixel];
            pixels.data[pixel] = color[0];
            pixels.data[pixel + 1] = color[1];
            pixels.data[pixel + 2] = color[2];
            pixels.data[pixel + 3] = Math.round(alpha * 0.52);
        }
        maskContext.putImageData(pixels, 0, 0);
        context.drawImage(maskCanvas, 0, 0);
    }
}

export function updateRecordDetails(state, record) {
    const empty = state.root.querySelector('[data-role="details-empty"]');
    const details = state.root.querySelector('[data-role="details"]');
    empty.hidden = !!record;
    details.hidden = !record;
    if (!record) {
        empty.textContent = "Showing the latest node output. Select a saved record to inspect its details.";
        return;
    }
    const setDetail = (name, value) => {
        const element = state.root.querySelector(`[data-detail="${name}"]`);
        if (element) element.textContent = value || "-";
    };
    const currentInputs = record.source === "current_inputs";
    const kicker = state.root.querySelector(".mcore-pg-details-kicker");
    if (kicker) kicker.textContent = currentInputs ? "Current inputs" : "Record details";
    const imageShape = Array.isArray(record.image_shape) ? record.image_shape : [];
    const imageDimensions = imageShape.length >= 4 ? imageShape.slice(-3, -1) : imageShape.slice(0, 2);
    const [height, width] = imageDimensions.map(Number);
    setDetail("name", currentInputs ? "Current inputs" : record.name || "Untitled record");
    setDetail("collection", currentInputs
        ? "—"
        : state.collections.find((item) => item.id === record.collection_id)?.name || "-");
    setDetail("created", currentInputs || !record.created ? "—" : new Date(record.created).toLocaleString());
    setDetail("resolution", Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
        ? `${width} × ${height} px`
        : "-");
    setDetail("masks", String(record.mask_count || 0));
    setDetail("general-tags", record.general_tags || "—");
    const personTags = Array.isArray(record.person_tags) ? record.person_tags : [];
    const personTagsContainer = state.root.querySelector('[data-role="person-tags-row"]');
    personTagsContainer.replaceChildren();
    personTags.forEach((tag, index) => {
        const row = document.createElement("div");
        row.className = "mcore-pg-gallery-details-row mcore-pg-person-tag-row";

        const label = document.createElement("span");
        label.textContent = `Person ${index + 1} tags`;

        const value = document.createElement("strong");
        value.className = "mcore-pg-details-tags";
        value.textContent = tag == null || String(tag).trim() === "" ? "—" : String(tag);

        row.append(label, value);
        personTagsContainer.appendChild(row);
    });
    personTagsContainer.hidden = !personTags.length;
}
