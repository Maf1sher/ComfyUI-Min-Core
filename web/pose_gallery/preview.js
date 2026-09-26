import { api } from "/scripts/api.js";
import { fileItemUrl } from "./api.js";

const MASK_COLORS = [
    [255, 80, 80], [70, 170, 255], [100, 230, 120],
    [255, 190, 60], [210, 100, 255], [50, 220, 210],
];

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
    state.previewImages.forEach((image) => { image.onload = null; image.onerror = null; });
    state.previewImages = [];
    const controls = state.root.querySelector('[data-role="layer-controls"]');
    controls.replaceChildren();

    const layers = [
        { name: "Image", type: "image", url: displayUrl(preview.image), visible: true },
        { name: "Pose", type: "pose", url: displayUrl(preview.pose), visible: true },
        ...(preview.masks || []).map((mask, index) => ({
            name: `Mask ${index + 1}`,
            type: "mask",
            url: displayUrl(mask),
            visible: false,
            color: MASK_COLORS[index % MASK_COLORS.length],
        })),
    ].filter((layer) => layer.url);
    state.previewLayers = layers;

    for (const layer of layers) {
        const label = document.createElement("label");
        label.className = "mcore-pg-layer-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = layer.visible;
        checkbox.addEventListener("change", () => {
            layer.visible = checkbox.checked;
            renderPreview(state);
        });
        const text = document.createElement("span");
        text.textContent = layer.name;
        label.append(checkbox, text);
        controls.appendChild(label);

        const image = new Image();
        state.previewImages.push(image);
        image.onload = () => {
            if (state.previewRevision === revision) {
                layer.image = image;
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
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord;
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
    renderPreview(state);
}

function containRect(canvas, image) {
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height };
}

function renderPreview(state) {
    const canvas = state.root.querySelector('[data-role="preview"]');
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
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
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = 0.92;
        context.drawImage(poseLayer.image, rect.x, rect.y, rect.width, rect.height);
        context.restore();
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
        if (element) element.textContent = value || "—";
    };
    setDetail("name", record.name || "Untitled record");
    setDetail("collection", state.collections.find((item) => item.id === record.collection_id)?.name || "—");
    setDetail("created", record.created ? new Date(record.created).toLocaleString() : "—");
    setDetail("masks", String(record.mask_count || 0));
    setDetail("general-tags", record.general_tags || "—");
    const personTags = (record.person_tags || []).map((tag, index) => `Person ${index + 1}: ${tag || "—"}`).join("\n");
    setDetail("person-tags", personTags || "—");
    state.root.querySelector('[data-role="person-tags-row"]').hidden = !personTags;
}
