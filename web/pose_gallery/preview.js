import { api } from "/scripts/api.js";
import { blobRequest, fileItemUrl } from "./api.js";

const MASK_COLORS = [
    [255, 80, 80], [70, 170, 255], [100, 230, 120],
    [255, 190, 60], [210, 100, 255], [50, 220, 210],
];
const PREVIEW_LINE_WIDTH_KEY = "mincore.poseGallery.previewLineWidth";
const THUMBNAIL_CACHE_LIMIT = 96;
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

function loadThumbnailImage(url, cache) {
    if (cache.has(url)) {
        const cached = cache.get(url);
        cache.delete(url);
        cache.set(url, cached);
        return cached;
    }
    const promise = new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth && image.naturalHeight ? image : null);
        image.onerror = () => resolve(null);
        image.src = api.apiURL(url);
    });
    cache.set(url, promise);
    while (cache.size > THUMBNAIL_CACHE_LIMIT) {
        cache.delete(cache.keys().next().value);
    }
    return promise;
}

function drawUnavailableThumbnail(canvas, context) {
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
}

function thumbnailLayerRect(canvas, image) {
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height };
}

function drawPoseThumbnail(context, scratch, image, rect) {
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    if (!scratchContext) return;
    scratchContext.clearRect(0, 0, scratch.width, scratch.height);
    scratchContext.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
    for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
        const intensity = Math.max(pixels.data[pixel], pixels.data[pixel + 1], pixels.data[pixel + 2]);
        if (!intensity) {
            pixels.data[pixel + 3] = 0;
            continue;
        }
        const colorScale = 255 / intensity;
        pixels.data[pixel] = Math.round(pixels.data[pixel] * colorScale);
        pixels.data[pixel + 1] = Math.round(pixels.data[pixel + 1] * colorScale);
        pixels.data[pixel + 2] = Math.round(pixels.data[pixel + 2] * colorScale);
        pixels.data[pixel + 3] = Math.min(255, Math.round(intensity / 0.6));
    }
    scratchContext.putImageData(pixels, 0, 0);
    context.drawImage(scratch, 0, 0);
}

function drawMaskThumbnail(context, scratch, image, rect, color) {
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    if (!scratchContext) return;
    scratchContext.clearRect(0, 0, scratch.width, scratch.height);
    scratchContext.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
    for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
        const intensity = pixels.data[pixel];
        pixels.data[pixel] = color[0];
        pixels.data[pixel + 1] = color[1];
        pixels.data[pixel + 2] = color[2];
        pixels.data[pixel + 3] = Math.round(intensity * 0.52);
    }
    scratchContext.putImageData(pixels, 0, 0);
    context.drawImage(scratch, 0, 0);
}

export function drawRecordThumbnail(canvas, record, visibility, cache) {
    const requestId = (canvas.thumbnailRequestId || 0) + 1;
    canvas.thumbnailRequestId = requestId;
    const recordId = encodeURIComponent(record.id);
    const assetUrl = (filename) => `/mincore/pose_gallery/records/${recordId}/assets/thumb_${filename}`;
    const layers = [];
    if (record.has_image && (visibility.image || visibility.pose || visibility.masks)) {
        layers.push({
            type: "image",
            visible: visibility.image,
            url: assetUrl("image.png"),
        });
    }
    if (visibility.pose) layers.push({ type: "pose", url: assetUrl("pose.png") });
    if (visibility.masks) {
        for (let index = 0; index < record.mask_count; index += 1) {
            layers.push({
                type: "mask",
                color: MASK_COLORS[index % MASK_COLORS.length],
                url: assetUrl(`mask_${String(index).padStart(4, "0")}.png`),
            });
        }
    }

    const context = canvas.getContext("2d");
    if (!context) return;
    const gallery = canvas.closest(".mcore-pg-gallery");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = getComputedStyle(gallery || canvas).getPropertyValue("--mcore-pg-canvas-bg").trim() || "#222";
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (!layers.length) {
        context.fillStyle = getComputedStyle(gallery || canvas).getPropertyValue("--openpose-text-muted").trim() || "#999";
        context.font = "500 12px Inter, Segoe UI, Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("No layers selected", canvas.width / 2, canvas.height / 2, canvas.width - 20);
        return;
    }

    Promise.all(layers.map(async (layer) => ({ ...layer, image: await loadThumbnailImage(layer.url, cache) })))
        .then((loadedLayers) => {
            if (canvas.thumbnailRequestId !== requestId || !canvas.isConnected) return;
            const available = loadedLayers.filter((layer) => layer.image);
            if (!available.length) {
                drawUnavailableThumbnail(canvas, context);
                return;
            }
            const reference = available.find((layer) => layer.type === "image")
                || available.find((layer) => layer.type === "pose")
                || available[0];
            const rect = thumbnailLayerRect(canvas, reference.image);
            const scratch = document.createElement("canvas");
            scratch.width = canvas.width;
            scratch.height = canvas.height;
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";

            for (const layer of available) {
                if (layer.type === "image") {
                    if (layer.visible) context.drawImage(layer.image, rect.x, rect.y, rect.width, rect.height);
                } else if (layer.type === "pose") {
                    drawPoseThumbnail(context, scratch, layer.image, rect);
                } else {
                    drawMaskThumbnail(context, scratch, layer.image, rect, layer.color);
                }
            }
        })
        .catch(() => {
            if (canvas.thumbnailRequestId === requestId && canvas.isConnected) {
                drawUnavailableThumbnail(canvas, context);
            }
        });
}

function isFiniteCoordinate(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value));
}

function hasOpenPose(poseJson) {
    if (typeof poseJson !== "string" || !poseJson.trim()) return false;

    let pose;
    try {
        pose = JSON.parse(poseJson);
    } catch (_error) {
        return false;
    }
    if (Array.isArray(pose)) {
        if (pose.length !== 1 || !pose[0] || typeof pose[0] !== "object" || Array.isArray(pose[0])) return false;
        [pose] = pose;
    }
    if (!pose || typeof pose !== "object" || Array.isArray(pose)) return false;

    if (Array.isArray(pose.people) || Array.isArray(pose.pose_keypoints_2d)) {
        const people = Array.isArray(pose.people) ? pose.people : [pose];
        return people.some((person) => {
            const keypoints = person?.pose_keypoints_2d;
            if (!Array.isArray(keypoints)) return false;
            const step = keypoints.length % 3 === 0 ? 3 : keypoints.length % 2 === 0 ? 2 : 0;
            const count = step ? keypoints.length / step : 0;
            if (![17, 18].includes(count)) return false;
            for (let index = 0; index < keypoints.length; index += step) {
                if (!isFiniteCoordinate(keypoints[index]) || !isFiniteCoordinate(keypoints[index + 1])) continue;
                if (step === 2 || (isFiniteCoordinate(keypoints[index + 2]) && Number(keypoints[index + 2]) > 0)) {
                    return true;
                }
            }
            return false;
        });
    }

    if (!Array.isArray(pose.keypoints) || !pose.keypoints.length) return false;
    const first = pose.keypoints[0];
    const groups = Array.isArray(first) && first.length > 0 && (Array.isArray(first[0]) || first[0] === null)
        ? pose.keypoints
        : [pose.keypoints];
    return groups.some((keypoints) => (
        Array.isArray(keypoints)
        && [17, 18].includes(keypoints.length)
        && keypoints.some((point) => {
            const coordinates = Array.isArray(point) ? point : [point?.x, point?.y];
            return isFiniteCoordinate(coordinates[0]) && isFiniteCoordinate(coordinates[1]);
        })
    ));
}

export function setPreviewSource(state, preview) {
    state.previewRevision = (state.previewRevision || 0) + 1;
    const revision = state.previewRevision;
    clearPosePreviewTimer(state);
    state.posePreviewRequestId = (state.posePreviewRequestId || 0) + 1;
    state.previewLayers.forEach((layer) => disposeGeneratedPosePreview(state, layer));
    state.maskPreviewCanvases.clear();
    state.previewImages.forEach((image) => {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
    });
    state.previewImages = [];
    const controlContainers = [
        state.root.querySelector('[data-role="layer-controls"]'),
        state.root.querySelector('[data-role="expanded-layer-controls"]'),
    ].filter(Boolean);
    controlContainers.forEach((controls) => controls.replaceChildren());

    const poseJson = typeof preview.pose_json === "string" ? preview.pose_json : "";
    const layers = [
        {
            name: "Image",
            type: "image",
            url: displayUrl(preview.image),
            visibilityKey: "image",
            visible: state.previewLayerVisibility.image ?? true,
        },
        ...(hasOpenPose(poseJson) ? [{
            name: "Pose",
            type: "pose",
            url: displayUrl(preview.pose),
            poseJson,
            visibilityKey: "pose",
            visible: state.previewLayerVisibility.pose ?? true,
        }] : []),
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
                if (layer.type === "mask") state.maskPreviewCanvases.clear();
                if (layer.visible) loadPreviewLayer(state, layer, revision);
                renderPreview(state);
            });
            const text = document.createElement("span");
            text.textContent = layer.name;
            label.append(checkbox, text);
            controls.appendChild(label);
            layer.visibilityInputs.push(checkbox);
        }

        if (layer.visible || layer.type === "image") loadPreviewLayer(state, layer, revision);
    }

    resizePreviewCanvas(state);
    renderPreview(state);
    updateRecordDetails(state, preview.record || null);
    const actionsBusy = state.selectionPending || state.deletingRecordId != null || state.usingRecord;
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord || actionsBusy;
    state.root.querySelector('[data-action="delete-record"]').disabled = !state.selectedRecord || actionsBusy;
}

function loadPreviewLayer(state, layer, revision) {
    if (layer.image || layer.loading || layer.loadFailed) return;
    const image = new Image();
    layer.loading = true;
    state.previewImages.push(image);
    image.onload = () => {
        if (state.previewRevision !== revision || state.closing) return;
        layer.loading = false;
        layer.image = image;
        state.maskPreviewCanvases.clear();
        if (layer.type === "pose") {
            layer.basePreviewImage = makePosePreviewImage(image);
            layer.previewImage = layer.basePreviewImage;
            if (state.previewLineWidth !== 1 && layer.poseJson) {
                setPreviewLineWidth(state, state.previewLineWidth);
            }
        }
        renderPreview(state);
    };
    image.onerror = () => {
        if (state.previewRevision !== revision || state.closing) return;
        layer.loading = false;
        layer.loadFailed = true;
        renderPreview(state);
    };
    image.src = layer.url;
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

function getMaskPreviewCanvas(state, canvas, rect) {
    const key = `${canvas.width}x${canvas.height}`;
    const cache = state.maskPreviewCanvases;
    if (cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }

    const masks = state.previewLayers.filter((layer) => layer.type === "mask" && layer.visible && layer.image);
    if (!masks.length) return null;
    const overlay = document.createElement("canvas");
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const overlayContext = overlay.getContext("2d");
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    if (!overlayContext || !scratchContext) return null;

    for (const layer of masks) {
        scratchContext.clearRect(0, 0, scratch.width, scratch.height);
        scratchContext.drawImage(layer.image, rect.x, rect.y, rect.width, rect.height);
        const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
            const alpha = pixels.data[pixel];
            pixels.data[pixel] = layer.color[0];
            pixels.data[pixel + 1] = layer.color[1];
            pixels.data[pixel + 2] = layer.color[2];
            pixels.data[pixel + 3] = Math.round(alpha * 0.52);
        }
        scratchContext.putImageData(pixels, 0, 0);
        overlayContext.drawImage(scratch, 0, 0);
    }
    cache.set(key, overlay);
    while (cache.size > 2) cache.delete(cache.keys().next().value);
    return overlay;
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
    const maskCanvas = getMaskPreviewCanvas(state, canvas, rect);
    if (maskCanvas) context.drawImage(maskCanvas, 0, 0);
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
        if (element) element.textContent = value == null || String(value).trim() === "" ? "-" : value;
    };
    const currentInputs = record.source === "current_inputs";
    const kicker = state.root.querySelector(".mcore-pg-details-kicker");
    if (kicker) kicker.textContent = currentInputs ? "Current inputs" : "Record details";
    const imageShape = Array.isArray(record.image_shape) ? record.image_shape : [];
    const imageDimensions = imageShape.length >= 4 ? imageShape.slice(-3, -1) : imageShape.slice(0, 2);
    const [height, width] = imageDimensions.map(Number);
    setDetail("name", currentInputs ? "Current inputs" : record.name || "Untitled record");
    setDetail("collection", currentInputs
        ? "-"
        : state.collections.find((item) => item.id === record.collection_id)?.name || "-");
    setDetail("created", currentInputs || !record.created ? "-" : new Date(record.created).toLocaleString());
    setDetail("resolution", Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
        ? `${width} × ${height} px`
        : "-");
    setDetail("masks", String(record.mask_count || 0));
    setDetail("general-tags", record.general_tags);
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
        value.textContent = tag == null || String(tag).trim() === "" ? "-" : String(tag);

        row.append(label, value);
        personTagsContainer.appendChild(row);
    });
    personTagsContainer.hidden = !personTags.length;
}
