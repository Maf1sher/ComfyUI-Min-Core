import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { jsonRequest, queueNode, toast } from "./pose_gallery/api.js";
import {
    getStoredPreviewLineWidth,
    resizePreviewCanvas,
    setPreviewLineWidth,
    setPreviewSource,
} from "./pose_gallery/preview.js";
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

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = new URL("./pose_gallery/pose_gallery.css", import.meta.url).href;
    document.head.appendChild(link);
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

function openPreviewLightbox(state) {
    const lightbox = state.root.querySelector('[data-role="preview-lightbox"]');
    if (!lightbox || state.previewExpanded) return;
    state.previewReturnFocus = document.activeElement;
    state.previewExpanded = true;
    state.root.querySelector('[data-action="expand-preview"]').setAttribute("aria-expanded", "true");
    lightbox.hidden = false;
    resizePreviewCanvas(state);
    lightbox.querySelector('[data-action="close-preview"]').focus({ preventScroll: true });
}

function closePreviewLightbox(state) {
    const lightbox = state.root.querySelector('[data-role="preview-lightbox"]');
    if (!lightbox || !state.previewExpanded) return;
    state.previewExpanded = false;
    state.root.querySelector('[data-action="expand-preview"]').setAttribute("aria-expanded", "false");
    lightbox.hidden = true;
    const returnFocus = state.previewReturnFocus;
    state.previewReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function openSettings(state) {
    const settings = state.root.querySelector('[data-role="settings-dialog"]');
    if (!settings || state.settingsOpen) return;
    state.settingsReturnFocus = document.activeElement;
    state.settingsOpen = true;
    state.root.querySelector('[data-action="settings"]').setAttribute("aria-expanded", "true");
    settings.hidden = false;
    settings.querySelector('[data-action="close-settings"]').focus({ preventScroll: true });
}

function closeSettings(state) {
    const settings = state.root.querySelector('[data-role="settings-dialog"]');
    if (!settings || !state.settingsOpen) return;
    state.settingsOpen = false;
    state.root.querySelector('[data-action="settings"]').setAttribute("aria-expanded", "false");
    settings.hidden = true;
    const returnFocus = state.settingsReturnFocus;
    state.settingsReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function applyPanelLayout(panel) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const margin = viewportWidth <= 900 ? 12 : 28;
    const width = Math.max(0, Math.min(viewportWidth - margin * 2, 1700));
    const height = Math.max(0, viewportHeight - margin * 2);
    const left = Math.max(0, Math.floor((viewportWidth - width) / 2));
    panel.style.setProperty("width", `${Math.floor(width)}px`, "important");
    panel.style.setProperty("height", `${Math.floor(height)}px`, "important");
    panel.style.setProperty("left", `${left}px`, "important");
    panel.style.setProperty("top", `${margin}px`, "important");
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
    backdrop.className = "mcore-pg-backdrop";
    document.body.appendChild(backdrop);
    const panel = graphCanvas.createPanel("Pose Gallery Min", { closable: true });
    panel.classList.add("mcore-pg-panel", "mcore-pg-modal");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", headingId);
    panel.tabIndex = -1;
    const header = panel.header || panel.querySelector(".dialog-header");
    header?.classList.add("mcore-pg-native-header");
    const closeButton = header?.querySelector(".close");
    closeButton?.classList.add("mcore-pg-native-close");
    const footer = panel.footer || panel.querySelector(".dialog-footer");
    footer?.classList.add("mcore-pg-native-footer");
    const root = panel.addHTML(buildGalleryHtml(headingId), "mcore-pg-panel-content");
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
        previewLayerVisibility: {},
        previewLineWidth: getStoredPreviewLineWidth(),
        posePreviewRequestId: 0,
        posePreviewTimer: null,
        previewExpanded: false,
        previewReturnFocus: null,
        settingsOpen: false,
        settingsReturnFocus: null,
        thumbnailObserver: null,
        restoreFocus,
        resizeHandler: null,
        keydownHandler: null,
        closing: false,
    };
    node._poseGalleryPanel = state;
    state.thumbnailObserver = createThumbnailObserver(root);
    setGalleryViewMode(state, state.viewMode);
    setPreviewLineWidth(state, state.previewLineWidth);

    const originalClose = panel.close.bind(panel);
    let closeTimer = null;
    let closeTransitionHandler = null;
    const cleanup = () => {
        window.removeEventListener("resize", state.resizeHandler);
        window.removeEventListener("keydown", state.keydownHandler);
        state.thumbnailObserver?.disconnect();
        backdrop.remove();
        if (state.posePreviewTimer != null) window.clearTimeout(state.posePreviewTimer);
        state.previewLayers.forEach((layer) => {
            if (layer.previewObjectUrl) URL.revokeObjectURL(layer.previewObjectUrl);
        });
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
        panel.classList.add("mcore-pg-closing");
        backdrop.classList.add("mcore-pg-closing");
        panel.classList.remove("mcore-pg-open");
        backdrop.classList.remove("mcore-pg-open");
        closeTransitionHandler = (event) => {
            if (event.target === panel && event.propertyName === "opacity") finishClose();
        };
        panel.addEventListener("transitionend", closeTransitionHandler);
        closeTimer = window.setTimeout(finishClose, 260);
    };
    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) panel.close();
    });
    root.querySelector('[data-action="close"]').addEventListener("click", () => panel.close());
    root.querySelector('[data-action="new-collection"]').addEventListener("click", () => createCollection(state));
    root.querySelector('[data-action="save-current"]').addEventListener("click", () => saveCurrent(state));
    root.querySelector('[data-action="use-record"]').addEventListener("click", () => useSelectedRecord(state));
    root.querySelector('[data-action="expand-preview"]').addEventListener("click", () => openPreviewLightbox(state));
    root.querySelector('[data-action="settings"]').addEventListener("click", () => openSettings(state));
    const previewLightbox = root.querySelector('[data-role="preview-lightbox"]');
    previewLightbox.querySelector('[data-action="close-preview"]').addEventListener("click", () => closePreviewLightbox(state));
    previewLightbox.addEventListener("click", (event) => {
        if (event.target === previewLightbox) closePreviewLightbox(state);
    });
    const settingsDialog = root.querySelector('[data-role="settings-dialog"]');
    settingsDialog.querySelectorAll('[data-action="close-settings"]').forEach((button) => {
        button.addEventListener("click", () => closeSettings(state));
    });
    settingsDialog.addEventListener("click", (event) => {
        if (event.target === settingsDialog) closeSettings(state);
    });
    settingsDialog.querySelector('[data-role="preview-line-width"]').addEventListener("input", (event) => {
        setPreviewLineWidth(state, Number(event.target.value) / 100);
    });
    settingsDialog.querySelector('[data-action="reset-preview-settings"]').addEventListener("click", () => {
        setPreviewLineWidth(state, 1);
    });
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
            if (state.settingsOpen) {
                event.preventDefault();
                closeSettings(state);
                return;
            }
            if (state.previewExpanded) {
                event.preventDefault();
                closePreviewLightbox(state);
                return;
            }
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
        const focusScope = state.settingsOpen
            ? state.root.querySelector('[data-role="settings-dialog"]')
            : state.previewExpanded
                ? state.root.querySelector('[data-role="preview-lightbox"]')
                : panel;
        const focusable = Array.from(focusScope.querySelectorAll(
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
        panel.classList.add("mcore-pg-open");
        backdrop.classList.add("mcore-pg-open");
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
        state.root.querySelectorAll(".mcore-pg-gallery-item").forEach((item) => {
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
    state.root.querySelectorAll(".mcore-pg-gallery-item.is-selected").forEach((item) => {
        item.classList.remove("is-selected");
        item.setAttribute("aria-pressed", "false");
    });
    setPreviewSource(state, {
        image: preview.image,
        pose: preview.pose,
        pose_json: preview.pose_json,
        masks: preview.masks || [],
        general_tags: preview.general_tags || "",
        person_tags: preview.person_tags || [],
    });
}

function showRecord(state, record) {
    setPreviewSource(state, {
        image: record.assets.image,
        pose: record.assets.pose,
        pose_json: record.pose_json,
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
        computeSize: () => [220, 40],
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
