import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "MinCore_ImageCompositor";
const STYLE_ID = "mincore-image-compositor-stylesheet";
const FRAME_VISIBILITY_KEY = "mincore.imageCompositor.showFrame";
const OUTSIDE_BACKGROUND_VISIBILITY_KEY = "mincore.imageCompositor.showOutsideBackground";

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = new URL("./image_compositor.css", import.meta.url).href;
    document.head.appendChild(link);
}

function notify(severity, summary, detail = "") {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 5000 });
}

function queueNodeExecution(node) {
    if (node?.id == null || node.id < 0) {
        throw new Error("Add the node to the workflow before running it.");
    }
    const queueWasProcessing = app.processingQueue;
    return app.queuePrompt(0, 1, [String(node.id)]).then((queued) => {
        if (queued === false && !queueWasProcessing) {
            throw new Error("ComfyUI could not queue this node. Check the execution errors.");
        }
        return queued;
    });
}

function setEditorState(node, transform) {
    const widget = node.widgets?.find((item) => item.name === "editor_state");
    if (!widget) throw new Error("Image Compositor internal state widget is missing.");
    widget.value = JSON.stringify({
        x: transform.x,
        y: transform.y,
        scale: transform.scale,
    });
    widget.callback?.(widget.value);
    node.setDirtyCanvas?.(true, true);
}

function readFrameVisibility() {
    try {
        return localStorage.getItem(FRAME_VISIBILITY_KEY) !== "false";
    } catch (_error) {
        return true;
    }
}

function saveFrameVisibility(value) {
    try {
        localStorage.setItem(FRAME_VISIBILITY_KEY, String(value));
    } catch (_error) {
        // Keep the setting for this editor session if local storage is unavailable.
    }
}

function readOutsideBackgroundVisibility() {
    try {
        return localStorage.getItem(OUTSIDE_BACKGROUND_VISIBILITY_KEY) !== "false";
    } catch (_error) {
        return true;
    }
}

function saveOutsideBackgroundVisibility(value) {
    try {
        localStorage.setItem(OUTSIDE_BACKGROUND_VISIBILITY_KEY, String(value));
    } catch (_error) {
        // Keep the setting for this editor session if local storage is unavailable.
    }
}

function fileItemUrl(item) {
    if (!item?.filename) return "";
    const query = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "temp",
        t: String(Date.now()),
    });
    return api.apiURL(`/view?${query}`);
}

function loadImage(item) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load preview: ${item?.filename || "image"}`));
        image.src = fileItemUrl(item);
    });
}

function buildEditorHtml(nodeId) {
    const headingId = `mcore-ic-heading-${nodeId}`;
    return `
        <div class="mcore-ic-editor" aria-labelledby="${headingId}">
            <header class="mcore-ic-header">
                <div>
                    <p class="mcore-ic-eyebrow">MIN-CORE · IMAGE TOOLS</p>
                    <h1 id="${headingId}">Image Compositor</h1>
                    <p class="mcore-ic-subtitle" data-role="dimensions">Load the node preview to begin editing.</p>
                </div>
                <button class="mcore-ic-icon-button" data-action="close" type="button" aria-label="Close editor">×</button>
            </header>
            <main class="mcore-ic-workspace">
                <section class="mcore-ic-canvas-wrap" aria-label="Composition preview">
                    <canvas data-role="canvas" aria-label="Drag to move the background; use the wheel to scale it."></canvas>
                    <div class="mcore-ic-status" data-role="status" role="status">Waiting for image previews…</div>
                </section>
                <aside class="mcore-ic-controls">
                    <div class="mcore-ic-control-top">
                        <div class="mcore-ic-control-heading">
                            <span class="mcore-ic-eyebrow">BACKGROUND</span>
                            <p>Position and scale</p>
                        </div>
                        <button class="mcore-ic-button mcore-ic-button-secondary mcore-ic-refresh-button" data-action="refresh" type="button">Refresh Images</button>
                    </div>
                    <label class="mcore-ic-field">
                        <span>Horizontal offset <small>X · px</small></span>
                        <input data-role="offset-x" type="number" step="0.1" value="0" inputmode="decimal">
                    </label>
                    <label class="mcore-ic-field">
                        <span>Vertical offset <small>Y · px</small></span>
                        <input data-role="offset-y" type="number" step="0.1" value="0" inputmode="decimal">
                    </label>
                    <label class="mcore-ic-field">
                        <span>Scale <small>cover · %</small></span>
                        <input data-role="scale" type="number" min="100" step="0.1" value="100" inputmode="decimal">
                    </label>
                    <label class="mcore-ic-check">
                        <input data-role="show-frame" type="checkbox" checked>
                        <span>Show guides</span>
                    </label>
                    <label class="mcore-ic-check">
                        <input data-role="show-outside-background" type="checkbox" checked>
                        <span>Show background outside frame</span>
                    </label>
                    <p class="mcore-ic-help">Drag in the preview to move the background. Use the mouse wheel to zoom around the pointer.</p>
                    <div class="mcore-ic-actions">
                        <button class="mcore-ic-button mcore-ic-button-secondary" data-action="reset" type="button">Reset</button>
                        <button class="mcore-ic-button mcore-ic-button-primary" data-action="apply" type="button">Apply</button>
                    </div>
                    <p class="mcore-ic-apply-status" data-role="apply-status" aria-live="polite"></p>
                </aside>
            </main>
        </div>
    `;
}

function applyPanelLayout(panel) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const margin = viewportWidth <= 760 ? 10 : 28;
    const width = Math.max(0, Math.min(viewportWidth - margin * 2, 1500));
    const height = Math.max(0, Math.min(viewportHeight - margin * 2, 1000));
    panel.style.setProperty("width", `${Math.floor(width)}px`, "important");
    panel.style.setProperty("height", `${Math.floor(height)}px`, "important");
    panel.style.setProperty("left", `${Math.floor((viewportWidth - width) / 2)}px`, "important");
    panel.style.setProperty("top", `${Math.floor((viewportHeight - height) / 2)}px`, "important");
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function coverScale(state) {
    return Math.max(
        state.sourceWidth / state.backgroundWidth,
        state.sourceHeight / state.backgroundHeight,
    );
}

function normalizeTransform(state) {
    const transform = state.transform;
    transform.scale = Math.max(1, Number.isFinite(Number(transform.scale)) ? Number(transform.scale) : 1);
    transform.x = Number.isFinite(Number(transform.x)) ? Number(transform.x) : 0;
    transform.y = Number.isFinite(Number(transform.y)) ? Number(transform.y) : 0;
    if (!state.sourceWidth || !state.sourceHeight || !state.backgroundWidth || !state.backgroundHeight) return;
    const scale = coverScale(state) * transform.scale;
    const maxX = Math.max(0, (state.backgroundWidth * scale - state.sourceWidth) / 2);
    const maxY = Math.max(0, (state.backgroundHeight * scale - state.sourceHeight) / 2);
    transform.x = clamp(Number.isFinite(Number(transform.x)) ? Number(transform.x) : 0, -maxX, maxX);
    transform.y = clamp(Number.isFinite(Number(transform.y)) ? Number(transform.y) : 0, -maxY, maxY);
}

function syncControls(state) {
    if (!state.root) return;
    state.root.querySelector('[data-role="offset-x"]').value = Number(state.transform.x.toFixed(1)).toString();
    state.root.querySelector('[data-role="offset-y"]').value = Number(state.transform.y.toFixed(1)).toString();
    state.root.querySelector('[data-role="scale"]').value = Number((state.transform.scale * 100).toFixed(1)).toString();
}

function drawCheckerboard(context, x, y, width, height, tileSize = 16) {
    context.save();
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    context.fillStyle = "#dedede";
    context.fillRect(x, y, width, height);
    context.fillStyle = "#b8b8b8";
    const startX = Math.floor(x / tileSize) * tileSize;
    const startY = Math.floor(y / tileSize) * tileSize;
    for (let row = startY; row < y + height; row += tileSize) {
        for (let column = startX; column < x + width; column += tileSize) {
            if (((Math.floor((column - startX) / tileSize) + Math.floor((row - startY) / tileSize)) % 2) === 0) {
                context.fillRect(column, row, tileSize, tileSize);
            }
        }
    }
    context.restore();
}

function drawPreview(state) {
    if (!state.canvas || !state.sourceImage || !state.backgroundImage) return;
    const canvas = state.canvas;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(bounds.width * dpr));
    const pixelHeight = Math.max(1, Math.round(bounds.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }

    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    context.fillStyle = "#17191d";
    context.fillRect(0, 0, bounds.width, bounds.height);

    const padding = 32;
    const fitScale = Math.min(
        (bounds.width - padding * 2) / state.sourceWidth,
        (bounds.height - padding * 2) / state.sourceHeight,
    );
    if (!Number.isFinite(fitScale) || fitScale <= 0) return;

    const frameWidth = state.sourceWidth * fitScale;
    const frameHeight = state.sourceHeight * fitScale;
    const frameX = (bounds.width - frameWidth) / 2;
    const frameY = (bounds.height - frameHeight) / 2;
    state.frame = { x: frameX, y: frameY, width: frameWidth, height: frameHeight, scale: fitScale };

    drawCheckerboard(context, frameX, frameY, frameWidth, frameHeight);

    const imageScale = coverScale(state) * state.transform.scale;
    const backgroundX = (state.sourceWidth - state.backgroundWidth * imageScale) / 2 + state.transform.x;
    const backgroundY = (state.sourceHeight - state.backgroundHeight * imageScale) / 2 + state.transform.y;
    context.save();
    if (!state.showOutsideBackground) {
        context.beginPath();
        context.rect(frameX, frameY, frameWidth, frameHeight);
        context.clip();
    }
    context.drawImage(
        state.backgroundImage,
        frameX + backgroundX * fitScale,
        frameY + backgroundY * fitScale,
        state.backgroundWidth * imageScale * fitScale,
        state.backgroundHeight * imageScale * fitScale,
    );
    context.restore();

    if (state.showOutsideBackground && state.showFrame) {
        context.save();
        context.fillStyle = "rgba(0, 0, 0, 0.5)";
        context.fillRect(0, 0, bounds.width, frameY);
        context.fillRect(0, frameY + frameHeight, bounds.width, bounds.height - frameY - frameHeight);
        context.fillRect(0, frameY, frameX, frameHeight);
        context.fillRect(frameX + frameWidth, frameY, bounds.width - frameX - frameWidth, frameHeight);
        context.restore();
    }

    context.drawImage(state.sourceImage, frameX, frameY, frameWidth, frameHeight);

    if (state.showFrame) {
        context.strokeStyle = "#e9eef7";
        context.lineWidth = 1.5;
        context.strokeRect(frameX + 0.75, frameY + 0.75, frameWidth - 1.5, frameHeight - 1.5);
    }
}

function setStatus(state, message, visible = true) {
    const status = state.root.querySelector('[data-role="status"]');
    status.textContent = message;
    status.hidden = !visible;
}

function setEditorEnabled(state, enabled) {
    for (const selector of ['[data-role="offset-x"]', '[data-role="offset-y"]', '[data-role="scale"]', '[data-action="reset"]', '[data-action="apply"]']) {
        state.root.querySelector(selector).disabled = !enabled;
    }
}

function finishRefresh(state, message = "") {
    if (!state.refreshing) return;
    state.refreshing = false;
    const button = state.root.querySelector('[data-action="refresh"]');
    button.disabled = false;
    button.textContent = "Refresh Images";
    if (message) state.root.querySelector('[data-role="apply-status"]').textContent = message;
}

async function applyPreviewState(state, payload) {
    const requestId = ++state.previewRequestId;
    state.sourceImage = null;
    state.backgroundImage = null;
    setStatus(state, "Loading image previews…");
    try {
        const [sourceImage, backgroundImage] = await Promise.all([
            loadImage(payload.source),
            loadImage(payload.background),
        ]);
        if (state.closing || requestId !== state.previewRequestId) return;
        state.sourceImage = sourceImage;
        state.backgroundImage = backgroundImage;
        state.sourceWidth = Number(payload.source_width);
        state.sourceHeight = Number(payload.source_height);
        state.backgroundWidth = Number(payload.background_width);
        state.backgroundHeight = Number(payload.background_height);
        state.transform = {
            x: Number(payload.x) || 0,
            y: Number(payload.y) || 0,
            scale: Math.max(1, Number(payload.scale) || 1),
        };
        normalizeTransform(state);
        setEditorEnabled(state, true);
        state.root.querySelector('[data-role="dimensions"]').textContent =
            `Output frame ${state.sourceWidth} × ${state.sourceHeight} px · background ${state.backgroundWidth} × ${state.backgroundHeight} px`;
        const applyStatus = state.root.querySelector('[data-role="apply-status"]');
        if (applyStatus.textContent.startsWith("Queued") || applyStatus.textContent.startsWith("Updating")) {
            applyStatus.textContent = "Output updated.";
        } else if (state.refreshing) {
            applyStatus.textContent = "Images refreshed.";
        }
        finishRefresh(state);
        syncControls(state);
        setStatus(state, "", false);
        drawPreview(state);
    } catch (error) {
        if (state.closing || requestId !== state.previewRequestId) return;
        setStatus(state, String(error));
        finishRefresh(state, String(error));
    }
}

function updateTransform(state, nextTransform, sync = true) {
    state.transform = { ...state.transform, ...nextTransform };
    normalizeTransform(state);
    if (sync) syncControls(state);
    drawPreview(state);
}

function pointerInFrame(state, event) {
    const bounds = state.canvas.getBoundingClientRect();
    const frame = state.frame;
    if (!frame) return null;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height) return null;
    return {
        x: (x - frame.x) / frame.scale,
        y: (y - frame.y) / frame.scale,
    };
}

function zoomAtPointer(state, factor, pointer) {
    const oldZoom = state.transform.scale;
    const newZoom = Math.max(1, oldZoom * factor);
    const base = coverScale(state);
    const oldScale = base * oldZoom;
    const newScale = base * newZoom;
    const oldLeft = (state.sourceWidth - state.backgroundWidth * oldScale) / 2 + state.transform.x;
    const oldTop = (state.sourceHeight - state.backgroundHeight * oldScale) / 2 + state.transform.y;
    const backgroundX = (pointer.x - oldLeft) / oldScale;
    const backgroundY = (pointer.y - oldTop) / oldScale;
    const newLeft = pointer.x - backgroundX * newScale;
    const newTop = pointer.y - backgroundY * newScale;
    const centeredLeft = (state.sourceWidth - state.backgroundWidth * newScale) / 2;
    const centeredTop = (state.sourceHeight - state.backgroundHeight * newScale) / 2;
    updateTransform(state, {
        scale: newZoom,
        x: newLeft - centeredLeft,
        y: newTop - centeredTop,
    });
}

function bindEditorEvents(state) {
    const { root, canvas, panel, backdrop } = state;
    root.querySelector('[data-action="close"]').addEventListener("click", () => panel.close());
    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) panel.close();
    });

    const offsetX = root.querySelector('[data-role="offset-x"]');
    const offsetY = root.querySelector('[data-role="offset-y"]');
    const scale = root.querySelector('[data-role="scale"]');
    offsetX.addEventListener("input", () => {
        const value = Number(offsetX.value);
        if (Number.isFinite(value)) {
            updateTransform(state, { x: value }, false);
            offsetX.value = Number(state.transform.x.toFixed(1)).toString();
        }
    });
    offsetY.addEventListener("input", () => {
        const value = Number(offsetY.value);
        if (Number.isFinite(value)) {
            updateTransform(state, { y: value }, false);
            offsetY.value = Number(state.transform.y.toFixed(1)).toString();
        }
    });
    scale.addEventListener("input", () => {
        const value = Number(scale.value);
        if (Number.isFinite(value)) {
            updateTransform(state, { scale: value / 100 }, false);
            scale.value = Number((state.transform.scale * 100).toFixed(1)).toString();
        }
    });
    root.querySelector('[data-role="show-frame"]').checked = state.showFrame;
    root.querySelector('[data-role="show-frame"]').addEventListener("change", (event) => {
        state.showFrame = event.target.checked;
        saveFrameVisibility(state.showFrame);
        drawPreview(state);
    });
    root.querySelector('[data-role="show-outside-background"]').checked = state.showOutsideBackground;
    root.querySelector('[data-role="show-outside-background"]').addEventListener("change", (event) => {
        state.showOutsideBackground = event.target.checked;
        saveOutsideBackgroundVisibility(state.showOutsideBackground);
        drawPreview(state);
    });
    root.querySelector('[data-action="reset"]').addEventListener("click", () => {
        updateTransform(state, { x: 0, y: 0, scale: 1 });
        root.querySelector('[data-role="apply-status"]').textContent = "Transform reset. Apply to update the node output.";
    });
    root.querySelector('[data-action="refresh"]').addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const status = root.querySelector('[data-role="apply-status"]');
        if (state.refreshing) return;
        try {
            state.refreshing = true;
            button.disabled = true;
            button.textContent = "Refreshing…";
            status.textContent = "Refreshing source, background, and mask…";
            setStatus(state, "Running Image Compositor Min…");
            await queueNodeExecution(state.node);
        } catch (error) {
            setStatus(state, String(error));
            finishRefresh(state, String(error));
            notify("error", "Image Compositor", String(error));
        }
    });
    root.querySelector('[data-action="apply"]').addEventListener("click", async () => {
        const button = root.querySelector('[data-action="apply"]');
        const status = root.querySelector('[data-role="apply-status"]');
        try {
            if (!state.sourceImage || !state.backgroundImage) {
                throw new Error("Wait for the source and background previews to load.");
            }
            setEditorState(state.node, state.transform);
            button.disabled = true;
            button.textContent = "Queuing…";
            status.textContent = "Updating the node output…";
            await queueNodeExecution(state.node);
            status.textContent = "Queued. The editor preview updates when execution finishes.";
        } catch (error) {
            status.textContent = String(error);
            notify("error", "Image Compositor", String(error));
        } finally {
            button.disabled = false;
            button.textContent = "Apply";
        }
    });

    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !pointerInFrame(state, event)) return;
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        state.drag = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            x: state.transform.x,
            y: state.transform.y,
        };
        canvas.classList.add("is-dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!state.drag || state.drag.pointerId !== event.pointerId || !state.frame) return;
        updateTransform(state, {
            x: state.drag.x + (event.clientX - state.drag.clientX) / state.frame.scale,
            y: state.drag.y + (event.clientY - state.drag.clientY) / state.frame.scale,
        });
    });
    const stopDrag = (event) => {
        if (state.drag?.pointerId !== event.pointerId) return;
        state.drag = null;
        canvas.classList.remove("is-dragging");
    };
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("wheel", (event) => {
        const pointer = pointerInFrame(state, event);
        if (!pointer) return;
        event.preventDefault();
        zoomAtPointer(state, Math.exp(-event.deltaY * 0.0015), pointer);
    }, { passive: false });

    state.resizeHandler = () => {
        applyPanelLayout(panel);
        drawPreview(state);
    };
    state.keydownHandler = (event) => {
        if (event.key === "Escape" && panel.contains(document.activeElement)) {
            event.preventDefault();
            panel.close();
        }
    };
    window.addEventListener("resize", state.resizeHandler);
    window.addEventListener("keydown", state.keydownHandler);
}

function openEditor(node) {
    if (node._imageCompositorPanel) {
        node._imageCompositorPanel.panel.focus?.();
        return;
    }
    installStyles();
    const graphCanvas = LiteGraph.LGraphCanvas.active_canvas;
    if (!graphCanvas) return;

    const restoreFocus = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "mcore-ic-backdrop";
    backdrop.style.setProperty("z-index", "9999", "important");
    document.body.appendChild(backdrop);
    const panel = graphCanvas.createPanel("Image Compositor Min", { closable: true });
    panel.classList.add("mcore-ic-panel");
    panel.style.setProperty("position", "fixed", "important");
    panel.style.setProperty("z-index", "10000", "important");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;
    const header = panel.header || panel.querySelector(".dialog-header");
    header?.classList.add("mcore-ic-native-header");
    const closeButton = header?.querySelector(".close");
    closeButton?.classList.add("mcore-ic-native-close");
    const footer = panel.footer || panel.querySelector(".dialog-footer");
    footer?.classList.add("mcore-ic-native-footer");
    const root = panel.addHTML(buildEditorHtml(node.id), "mcore-ic-content");
    document.body.appendChild(panel);
    applyPanelLayout(panel);

    const state = {
        node,
        panel,
        backdrop,
        root,
        canvas: root.querySelector('[data-role="canvas"]'),
        sourceImage: null,
        backgroundImage: null,
        sourceWidth: 0,
        sourceHeight: 0,
        backgroundWidth: 0,
        backgroundHeight: 0,
        transform: { x: 0, y: 0, scale: 1 },
        showFrame: readFrameVisibility(),
        showOutsideBackground: readOutsideBackgroundVisibility(),
        previewRequestId: 0,
        resizeHandler: null,
        keydownHandler: null,
        drag: null,
        refreshing: false,
        closing: false,
        restoreFocus,
    };
    node._imageCompositorPanel = state;
    setEditorEnabled(state, false);

    const originalClose = panel.close.bind(panel);
    panel.close = () => {
        if (state.closing) return;
        state.closing = true;
        window.removeEventListener("resize", state.resizeHandler);
        window.removeEventListener("keydown", state.keydownHandler);
        state.previewRequestId += 1;
        state.sourceImage = null;
        state.backgroundImage = null;
        backdrop.remove();
        if (node._imageCompositorPanel === state) node._imageCompositorPanel = null;
        if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
        originalClose();
    };

    bindEditorEvents(state);
    requestAnimationFrame(() => {
        panel.classList.add("mcore-ic-open");
        panel.style.setProperty("pointer-events", "auto", "important");
        const firstControl = root.querySelector('[data-role="offset-x"]');
        if (firstControl.disabled) panel.focus();
        else firstControl.focus({ preventScroll: true });
        drawPreview(state);
    });

    if (node._imageCompositorState) {
        void applyPreviewState(state, node._imageCompositorState);
    } else {
        setStatus(state, "No image previews yet. Click Refresh Images to run the node.");
    }
}

function hideInternalStateWidget(node) {
    const widget = node.widgets?.find((item) => item.name === "editor_state");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
}

function setupNode(node) {
    installStyles();
    hideInternalStateWidget(node);
    node.serialize_widgets = true;
    const button = document.createElement("button");
    button.className = "mcore-ic-node-button";
    button.textContent = "Open Image Editor";
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        openEditor(node);
    });
    node.addDOMWidget("image_compositor_open", "div", button, {
        computeSize: (width) => [Math.max(250, Number(width) || 0), 40],
        serialize: false,
    });
    const size = node.computeSize();
    node.setSize([Math.max(250, size[0]), Math.max(145, size[1])]);
}

api.addEventListener("executed", ({ detail }) => {
    if (!detail) return;
    const node = app.graph?.getNodeById?.(detail.node);
    if (!node || node.comfyClass !== NODE_TYPE) return;
    const panelState = node._imageCompositorPanel;
    if (!detail.output) {
        if (panelState?.refreshing) {
            const message = "The node did not return image previews.";
            setStatus(panelState, message);
            finishRefresh(panelState, message);
        }
        return;
    }
    const state = Array.isArray(detail.output.image_compositor_state)
        ? detail.output.image_compositor_state[0]
        : null;
    if (!state) {
        if (panelState?.refreshing) {
            const message = "The node did not return image previews.";
            setStatus(panelState, message);
            finishRefresh(panelState, message);
        }
        return;
    }
    node._imageCompositorState = state;
    if (panelState) void applyPreviewState(panelState, state);
});

function finishPendingRefreshes(message) {
    for (const node of app.graph?._nodes || []) {
        const state = node.comfyClass === NODE_TYPE ? node._imageCompositorPanel : null;
        if (state?.refreshing) {
            setStatus(state, message);
            finishRefresh(state, message);
        }
    }
}

api.addEventListener("execution_error", () => {
    finishPendingRefreshes("Node execution failed. Check ComfyUI for details.");
});
api.addEventListener("execution_interrupted", () => {
    finishPendingRefreshes("Execution interrupted.");
});

app.registerExtension({
    name: "MinCore.ImageCompositor",
    async nodeCreated(node) {
        if (node.comfyClass === NODE_TYPE) setupNode(node);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        const original = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function () {
            const result = original ? original.apply(this, arguments) : undefined;
            arguments[1]?.push({ content: "Open Image Editor", callback: () => openEditor(this) });
            return result;
        };
    },
});
