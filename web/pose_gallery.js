import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import "./openpose_studio/comfy-theme-colors.js";
import { setupGalleryOverlayStyles } from "./openpose_studio/modules/gallery.js";
import { jsonRequest, queueNode, toast } from "./pose_gallery/api.js";
import { resizePreviewCanvas, setPreviewSource } from "./pose_gallery/preview.js";
import {
    buildGalleryHtml,
    createThumbnailObserver,
    getStoredViewMode,
    GALLERY_VIEW_MODES,
    renderRecords,
    setGalleryViewMode,
} from "./pose_gallery/view.js";

const NODE_TYPE = "MinCore_PoseGallery";
const STYLE_ID = "mincore-pose-gallery-stylesheet";
const SHELL_STYLESHEET_ID = "mincore-pose-gallery-shell-stylesheet";

function installStyles() {
    if (!document.getElementById(SHELL_STYLESHEET_ID)) {
        const existing = document.querySelector('link[href*="openpose_editor.css"]');
        if (!existing) {
            const link = document.createElement("link");
            link.id = SHELL_STYLESHEET_ID;
            link.rel = "stylesheet";
            link.href = "/mincore/openpose/assets/openpose_editor.css";
            document.head.appendChild(link);
        }
    }
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = new URL("./pose_gallery/pose_gallery.css", import.meta.url).href;
    document.head.appendChild(link);
}

function isLightThemeColor(color) {
    const value = String(color || "").trim();
    let rgb = null;
    if (/^#[\da-f]{3}$/i.test(value)) {
        rgb = value.slice(1).split("").map((channel) => parseInt(channel + channel, 16));
    } else if (/^#[\da-f]{6}$/i.test(value)) {
        rgb = [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
    } else {
        const match = value.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/i);
        if (match) rgb = match.slice(1, 4).map(Number);
    }
    return rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.58 : false;
}

function applyGalleryTheme(root, theme = null) {
    const resolved = theme
        || window.getComfyTheme?.()
        || window.ComfyTheme?.getTheme?.()
        || {
            isLight: false,
            background: "#202020",
            text: "#eee",
            menuBg: "#303030",
            menuBgSecondary: "#383838",
            inputBg: "#222",
            inputText: "#ddd",
            border: "#555",
            error: "#ef4444",
            contentHover: "#454545",
            primaryBg: "#2f8cff",
            primaryHover: "#579cff",
        };
    const panel = resolved.menuBg || resolved.background || "#202020";
    const secondary = resolved.menuBgSecondary || panel;
    const input = resolved.inputBg || secondary;
    const text = resolved.text || "#eee";
    const muted = resolved.inputText || resolved.text || text;
    const border = resolved.border || "#555";
    const primary = resolved.primaryBg || resolved.contentHover || border;
    const tokens = {
        "--openpose-panel-bg": panel,
        "--openpose-panel-bg-secondary": secondary,
        "--openpose-input-bg": input,
        "--openpose-input-text": muted,
        "--openpose-text": text,
        "--openpose-text-muted": muted,
        "--openpose-border": border,
        "--openpose-hover-bg": resolved.contentHover || secondary,
        "--openpose-btn-bg": secondary,
        "--openpose-btn-hover-bg": resolved.contentHover || secondary,
        "--openpose-btn-disabled-bg": panel,
        "--openpose-btn-primary-bg": secondary,
        "--openpose-btn-primary-hover-bg": resolved.contentHover || secondary,
        "--openpose-primary-bg": primary,
        "--openpose-primary-hover-bg": resolved.primaryHover || primary,
        "--openpose-primary-text": isLightThemeColor(primary) ? "#171717" : "#fff",
        "--openpose-gallery-selection-bg": `color-mix(in srgb, ${primary} 16%, ${input})`,
        "--openpose-link": primary,
        "--openpose-error": resolved.error || "#ef4444",
        "--openpose-status-info": primary,
        "--openpose-status-success": resolved.isLight ? "#15803d" : "#86efac",
        "--openpose-status-warn": resolved.isLight ? "#b45309" : "#facc15",
        "--openpose-status-error": resolved.error || "#fca5a5",
        "--openpose-status-neutral": muted,
        "--openpose-card-radius": "12px",
        "--openpose-canvas-bg": input,
        "--openpose-canvas-border": border,
        "--openpose-canvas-shadow": resolved.isLight
            ? "0 6px 18px rgba(15,23,42,.10)"
            : "0 6px 18px rgba(0,0,0,.24)",
    };
    const panelElement = root.closest(".ope-openpose-shell-panel");
    for (const element of [root, panelElement].filter(Boolean)) {
        for (const [name, value] of Object.entries(tokens)) element.style.setProperty(name, value);
    }
}

function readWidget(node, name, fallback = "") {
    return node.widgets?.find((widget) => widget.name === name)?.value ?? fallback;
}

function setWidget(node, name, value) {
    const widget = node.widgets?.find((item) => item.name === name);
    if (!widget) return;
    widget.value = value;
    widget.callback?.(value);
    node.setDirtyCanvas?.(true, true);
}

function renderGalleryRecords(state) {
    renderRecords(state, {
        onSelect: (recordId) => selectRecord(state, recordId),
        onRetry: () => state.retryCollections ? refreshCollections(state) : loadRecords(state),
    });
}

function applyPanelLayout(panel) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const margin = viewportWidth <= 900 ? 12 : 28;
    const width = Math.max(0, Math.min(viewportWidth - margin * 2, 1600));
    const height = Math.max(0, viewportHeight - margin * 2);
    const left = Math.max(0, Math.floor((viewportWidth - width) / 2));
    // Match the OpenPose Studio shell: LiteGraph/ComfyUI styles can otherwise
    // place the dialog below the backdrop despite its inline z-index.
    panel.style.setProperty("position", "fixed", "important");
    panel.style.setProperty("width", `${Math.floor(width)}px`, "important");
    panel.style.setProperty("height", `${Math.floor(height)}px`, "important");
    panel.style.setProperty("left", `${left}px`, "important");
    panel.style.setProperty("top", `${margin}px`, "important");
    panel.style.setProperty("z-index", "1000", "important");
    panel.style.setProperty("margin", "0", "important");
    panel.style.boxSizing = "border-box";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.overflow = "hidden";
    panel.style.background = "var(--p-dialog-background, var(--openpose-panel-bg, #202020))";
    panel.style.color = "var(--openpose-text, #eee)";
    panel.style.border = "1px solid var(--p-dialog-border-color, var(--openpose-border, #555))";
    panel.style.borderRadius = "var(--p-dialog-border-radius, 12px)";
    panel.style.boxShadow = "var(--p-dialog-shadow, 0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1))";
    const header = panel.querySelector(".ope-openpose-native-header");
    if (header) header.style.display = "none";
    const footer = panel.querySelector(".ope-openpose-native-footer");
    if (footer) footer.style.display = "none";
    const content = panel.querySelector(".dialog-content");
    if (content) {
        content.classList.add("ope-openpose-dialog-content");
        content.style.height = "100%";
        content.style.display = "flex";
        content.style.flex = "1 1 auto";
        content.style.minHeight = "0";
        content.style.overflow = "hidden";
        content.style.padding = "0";
    }
}


function openGallery(node) {
    if (node._poseGalleryPanel) {
        node._poseGalleryPanel.panel.focus?.();
        return;
    }
    installStyles();
    const graphCanvas = LiteGraph.LGraphCanvas.active_canvas;
    if (!graphCanvas) return;
    const restoreFocus = document.activeElement;
    const headingId = `mcore-pg-heading-${node.id}`;

    const backdrop = document.createElement("div");
    backdrop.className = "openpose-backdrop ope-openpose-shell-backdrop ope-openpose-modal-backdrop";
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.setProperty("z-index", "999", "important");
    backdrop.style.background = "rgba(0,0,0,.6)";
    backdrop.style.opacity = "0";
    backdrop.style.pointerEvents = "none";
    backdrop.style.transition = "opacity 150ms cubic-bezier(0,0,.2,1)";
    document.body.appendChild(backdrop);
    const panel = graphCanvas.createPanel("Pose Gallery Min", { closable: true });
    panel.classList.add("openpose-editor", "ope-openpose-modal", "ope-openpose-shell-panel", "ope-openpose-modal-shell");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", headingId);
    panel.tabIndex = -1;
    panel.style.opacity = "0";
    panel.style.pointerEvents = "none";
    panel.style.transition = "opacity 150ms cubic-bezier(0,0,.2,1), transform 150ms cubic-bezier(0,0,.2,1)";
    const header = panel.header || panel.querySelector(".dialog-header");
    header?.classList.add("ope-openpose-native-header");
    const closeButton = header?.querySelector(".close");
    closeButton?.classList.add("ope-openpose-native-close");
    const footer = panel.footer || panel.querySelector(".dialog-footer");
    footer?.classList.add("ope-openpose-native-footer");
    const root = panel.addHTML(buildGalleryHtml(headingId), "openpose-container");
    root.classList.add("ope-openpose-modal");
    root.style.setProperty("--ope-openpose-sidebar-width", "300px");
    root.style.setProperty("--ope-openpose-sidebar-min-width", "230px");
    root.style.display = "flex";
    root.style.flex = "1 1 auto";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.minWidth = "0";
    root.style.minHeight = "0";
    applyGalleryTheme(root);
    const themeCleanup = typeof window.watchThemeChanges === "function"
        ? window.watchThemeChanges((theme) => applyGalleryTheme(root, theme))
        : null;
    setupGalleryOverlayStyles(root);
    const galleryOverlay = root.querySelector(".mcore-pg-gallery");
    if (galleryOverlay) {
        galleryOverlay.style.position = "relative";
        galleryOverlay.style.display = "flex";
        galleryOverlay.style.flex = "1 1 auto";
        galleryOverlay.style.width = "100%";
        galleryOverlay.style.height = "100%";
        galleryOverlay.style.minWidth = "0";
        galleryOverlay.style.minHeight = "0";
    }
    applyPanelLayout(panel);
    document.body.appendChild(panel);

    const state = {
        node,
        panel,
        backdrop,
        root,
        collections: [],
        records: [],
        recordsStatus: "loading",
        recordsError: null,
        recordsRequestId: 0,
        collectionsRequestId: 0,
        selectionRequestId: 0,
        retryCollections: false,
        selectedRecord: null,
        selectedCollection: String(readWidget(node, "gallery_collection_id", "default")),
        viewMode: getStoredViewMode(),
        previewImages: [],
        previewLayers: [],
        thumbnailObserver: null,
        themeCleanup,
        restoreFocus,
        resizeHandler: null,
        keydownHandler: null,
        closing: false,
    };
    node._poseGalleryPanel = state;
    state.thumbnailObserver = createThumbnailObserver(root);
    setGalleryViewMode(state, state.viewMode);

    const originalClose = panel.close.bind(panel);
    let closeTimer = null;
    let closeTransitionHandler = null;
    const cleanup = () => {
        window.removeEventListener("resize", state.resizeHandler);
        window.removeEventListener("keydown", state.keydownHandler);
        state.themeCleanup?.();
        state.thumbnailObserver?.disconnect();
        backdrop.remove();
        state.previewImages.forEach((image) => { image.onload = null; image.onerror = null; });
        if (node._poseGalleryPanel === state) node._poseGalleryPanel = null;
        if (state.restoreFocus?.isConnected) state.restoreFocus.focus({ preventScroll: true });
    };
    const finishClose = () => {
        if (!state.closing) return;
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        if (closeTransitionHandler) panel.removeEventListener("transitionend", closeTransitionHandler);
        cleanup();
        originalClose();
    };
    panel.close = () => {
        if (state.closing) return;
        state.closing = true;
        panel.classList.add("ope-is-closing", "ope-openpose-modal-closing");
        backdrop.classList.add("ope-is-closing", "ope-openpose-modal-closing");
        panel.classList.remove("ope-is-open", "ope-openpose-modal-open");
        backdrop.classList.remove("ope-is-open", "ope-openpose-modal-open");
        panel.style.opacity = "0";
        panel.style.pointerEvents = "none";
        backdrop.style.opacity = "0";
        backdrop.style.pointerEvents = "none";
        closeTransitionHandler = (event) => {
            if (event.target === panel && event.propertyName === "opacity") finishClose();
        };
        panel.addEventListener("transitionend", closeTransitionHandler);
        closeTimer = window.setTimeout(finishClose, 260);
    };
    backdrop.addEventListener("click", (event) => {
        if (event.target !== backdrop) return;

        // If another stylesheet interferes with stacking or hit-testing, a
        // click inside the visible dialog can still land on the backdrop.
        // Never treat coordinates inside the panel as an outside click.
        const bounds = panel.getBoundingClientRect();
        const clickedInsidePanel = event.clientX >= bounds.left
            && event.clientX <= bounds.right
            && event.clientY >= bounds.top
            && event.clientY <= bounds.bottom;
        if (!clickedInsidePanel) panel.close();
    });
    root.querySelector('[data-action="close"]').addEventListener("click", () => panel.close());
    root.querySelector('[data-action="new-collection"]').addEventListener("click", () => createCollection(state));
    root.querySelector('[data-action="save-current"]').addEventListener("click", () => saveCurrent(state));
    root.querySelector('[data-action="use-record"]').addEventListener("click", () => useSelectedRecord(state));
    root.querySelector('[data-action="view-mode"]').addEventListener("click", () => {
        const index = GALLERY_VIEW_MODES.indexOf(state.viewMode);
        setGalleryViewMode(state, GALLERY_VIEW_MODES[(index + 1) % GALLERY_VIEW_MODES.length]);
        renderGalleryRecords(state);
    });
    root.querySelector('[data-role="collection"]').addEventListener("change", (event) => {
        state.selectedCollection = event.target.value;
        state.selectionRequestId += 1;
        state.selectedRecord = null;
        root.querySelector('[data-action="use-record"]').disabled = true;
        setWidget(node, "gallery_collection_id", state.selectedCollection);
        if (node._poseGalleryState) showCurrentState(state, node._poseGalleryState);
        else showCurrentState(state, {});
        loadRecords(state);
    });
    root.querySelector('[data-role="search"]').addEventListener("input", () => renderGalleryRecords(state));
    state.resizeHandler = () => {
        applyPanelLayout(panel);
        resizePreviewCanvas(state);
    };
    state.keydownHandler = (event) => {
        if (!panel.contains(document.activeElement) || event.defaultPrevented || state.closing) return;
        if (event.key === "Escape") {
            const search = state.root.querySelector('[data-role="search"]');
            if (event.target === search && search.value) {
                search.value = "";
                renderGalleryRecords(state);
                event.preventDefault();
                return;
            }
            event.preventDefault();
            panel.close();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(panel.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        )).filter((element) => !element.hidden && element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            panel.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (document.activeElement === panel) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    window.addEventListener("resize", state.resizeHandler);
    window.addEventListener("keydown", state.keydownHandler);
    requestAnimationFrame(() => {
        void panel.offsetWidth;
        panel.classList.add("ope-is-open", "ope-openpose-modal-open");
        backdrop.classList.add("ope-is-open", "ope-openpose-modal-open");
        panel.style.opacity = "1";
        panel.style.pointerEvents = "auto";
        backdrop.style.opacity = "1";
        backdrop.style.pointerEvents = "auto";
        state.root.querySelector('[data-role="search"]').focus({ preventScroll: true });
        resizePreviewCanvas(state);
    });
    refreshCollections(state).then(() => {
        if (node._poseGalleryState) showNodeState(state, node._poseGalleryState);
    }).catch((error) => toast("error", "Pose Gallery", String(error)));
}

async function refreshCollections(state) {
    if (state.closing) return;
    const requestId = ++state.collectionsRequestId;
    state.retryCollections = true;
    state.records = [];
    state.recordsError = null;
    state.recordsStatus = "loading";
    renderGalleryRecords(state);
    let payload;
    try {
        payload = await jsonRequest("/mincore/pose_gallery/collections");
    } catch (error) {
        if (requestId === state.collectionsRequestId && !state.closing) {
            state.recordsError = String(error);
            state.recordsStatus = "error";
            renderGalleryRecords(state);
        }
        throw error;
    }
    if (requestId !== state.collectionsRequestId || state.closing) return;
    state.retryCollections = false;
    state.collections = payload.collections || [];
    const select = state.root.querySelector('[data-role="collection"]');
    select.replaceChildren();
    for (const collection of state.collections) {
        const option = document.createElement("option");
        option.value = collection.id;
        option.textContent = collection.name;
        select.appendChild(option);
    }
    if (!state.collections.some((item) => item.id === state.selectedCollection)) {
        state.selectedCollection = "default";
    }
    select.value = state.selectedCollection;
    setWidget(state.node, "gallery_collection_id", state.selectedCollection);
    await loadRecords(state);
}

async function createCollection(state) {
    const name = window.prompt("New collection name");
    if (name == null || !name.trim()) return;
    try {
        const collection = await jsonRequest("/mincore/pose_gallery/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim() }),
        });
        state.selectedCollection = collection.id;
        state.selectionRequestId += 1;
        state.selectedRecord = null;
        state.root.querySelector('[data-action="use-record"]').disabled = true;
        if (state.node._poseGalleryState) showCurrentState(state, state.node._poseGalleryState);
        else showCurrentState(state, {});
        await refreshCollections(state);
        toast("success", "Pose Gallery", `Created collection: ${collection.name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

async function loadRecords(state) {
    if (state.closing) return false;
    state.retryCollections = false;
    const requestId = ++state.recordsRequestId;
    const collectionId = state.selectedCollection;
    state.records = [];
    state.recordsError = null;
    state.recordsStatus = "loading";
    renderGalleryRecords(state);
    try {
        const query = new URLSearchParams({ collection_id: collectionId });
        const payload = await jsonRequest(`/mincore/pose_gallery/records?${query}`);
        if (requestId !== state.recordsRequestId || collectionId !== state.selectedCollection || state.closing) return false;
        state.records = payload.records || [];
        state.recordsStatus = "ready";
        renderGalleryRecords(state);
        return true;
    } catch (error) {
        if (requestId !== state.recordsRequestId || collectionId !== state.selectedCollection || state.closing) return false;
        state.recordsError = String(error);
        state.recordsStatus = "error";
        renderGalleryRecords(state);
        toast("error", "Pose Gallery", String(error));
        return false;
    }
}

async function selectRecord(state, recordId) {
    const requestId = ++state.selectionRequestId;
    state.root.querySelector('[data-action="use-record"]').disabled = true;
    try {
        const record = await jsonRequest(`/mincore/pose_gallery/records/${recordId}`);
        if (requestId !== state.selectionRequestId || state.closing) return;
        state.selectedRecord = record;
        state.root.querySelectorAll(".openpose-gallery-item").forEach((item) => {
            const isSelected = String(item.dataset.recordId) === String(recordId);
            item.classList.toggle("is-selected", isSelected);
            item.setAttribute("aria-pressed", String(isSelected));
        });
        showRecord(state, record);
    } catch (error) {
        if (requestId !== state.selectionRequestId || state.closing) return;
        state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord;
        toast("error", "Pose Gallery", String(error));
    }
}

function showCurrentState(state, preview) {
    state.selectionRequestId += 1;
    state.selectedRecord = null;
    state.root.querySelector('[data-action="use-record"]').disabled = true;
    state.root.querySelectorAll(".openpose-gallery-item.is-selected").forEach((item) => {
        item.classList.remove("is-selected");
        item.setAttribute("aria-pressed", "false");
    });
    setPreviewSource(state, {
        image: preview.image,
        pose: preview.pose,
        masks: preview.masks || [],
        general_tags: preview.general_tags || "",
        person_tags: preview.person_tags || [],
    });
}

function showRecord(state, record) {
    setPreviewSource(state, {
        image: record.assets.image,
        pose: record.assets.pose,
        masks: record.assets.masks || [],
        general_tags: record.general_tags,
        person_tags: record.person_tags || [],
        record,
    });
}

function showNodeState(panelState, nodeState) {
    if (nodeState?.source === "gallery" && nodeState.record_id) {
        selectRecord(panelState, nodeState.record_id);
        return;
    }
    showCurrentState(panelState, nodeState);
}

async function saveCurrent(state) {
    const name = window.prompt("Record name (leave blank for an automatic name)", "");
    if (name == null) return;
    try {
        await jsonRequest("/mincore/pose_gallery/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node_id: String(state.node.id),
                collection_id: state.selectedCollection,
                name,
            }),
        });
        await queueNode(state.node);
        toast("info", "Pose Gallery", "Queued current inputs for saving.");
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

async function useSelectedRecord(state) {
    if (!state.selectedRecord) return;
    const selectedRecord = state.selectedRecord;
    const button = state.root.querySelector('[data-action="use-record"]');
    button.disabled = true;
    try {
        setWidget(state.node, "gallery_record_id", selectedRecord.id);
        setWidget(state.node, "output_source", "gallery");
        await queueNode(state.node);
        toast("success", "Pose Gallery", `Selected: ${selectedRecord.name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        button.disabled = !state.selectedRecord;
    }
}

function hideTrackingWidgets(node) {
    for (const name of ["gallery_collection_id", "gallery_record_id"]) {
        const widget = node.widgets?.find((item) => item.name === name);
        if (!widget) continue;
        widget.type = "hidden";
        widget.hidden = true;
        widget.computeSize = () => [0, -4];
    }
}

function setupNode(node) {
    installStyles();
    hideTrackingWidgets(node);
    node.serialize_widgets = true;
    const button = document.createElement("button");
    button.className = "mcore-pg-node-button";
    button.textContent = "Open Pose Gallery";
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        openGallery(node);
    });
    node.addDOMWidget("pose_gallery_open", "div", button, {
        computeSize: () => [Math.max(220, node.size?.[0] || 220), 40],
        serialize: false,
    });
    const size = node.computeSize();
    node.setSize([Math.max(280, size[0]), Math.max(210, size[1])]);
}

api.addEventListener("executed", ({ detail }) => {
    if (!detail?.output) return;
    const node = app.graph?.getNodeById?.(detail.node);
    if (!node || node.comfyClass !== NODE_TYPE) return;
    const output = detail.output;
    const state = Array.isArray(output.pose_gallery_state) ? output.pose_gallery_state[0] : null;
    if (state) {
        node._poseGalleryState = state;
        if (node._poseGalleryPanel) showNodeState(node._poseGalleryPanel, state);
    }
    const capture = Array.isArray(output.pose_gallery_capture) ? output.pose_gallery_capture[0] : null;
    if (capture?.id) {
        setWidget(node, "gallery_record_id", capture.id);
        if (node._poseGalleryPanel) {
            const panelState = node._poseGalleryPanel;
            loadRecords(panelState).then((loaded) => {
                if (loaded) return selectRecord(panelState, capture.id);
            });
        }
        toast("success", "Pose Gallery", `Saved: ${capture.name}`);
    }
});

app.registerExtension({
    name: "MinCore.PoseGallery",
    async nodeCreated(node) {
        if (node.comfyClass === NODE_TYPE) setupNode(node);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        const original = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function () {
            const result = original ? original.apply(this, arguments) : undefined;
            const options = arguments[1];
            options?.push({ content: "Open Pose Gallery", callback: () => openGallery(this) });
            return result;
        };
    },
});
