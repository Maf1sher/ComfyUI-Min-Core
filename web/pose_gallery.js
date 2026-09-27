import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { jsonRequest, queueNode, toast } from "./pose_gallery/api.js";
import {
    closeDeleteConfirmation,
    closeNewCollectionDialog,
    closePreviewLightbox,
    closeSaveDialog,
    closeSettings,
    openDeleteConfirmation,
    openNewCollectionDialog,
    openPreviewLightbox,
    openSaveDialog,
    openSettings,
    submitNewCollectionDialog,
    submitSaveDialog,
} from "./pose_gallery/dialogs.js";
import {
    getStoredPreviewLineWidth,
    resizePreviewCanvas,
    setPreviewLineWidth,
    setPreviewSource,
} from "./pose_gallery/preview.js";
import {
    buildGalleryHtml,
    createThumbnailObserver,
    getStoredThumbnailLayerVisibility,
    getStoredViewMode,
    GALLERY_VIEW_MODES,
    renderRecords,
    setThumbnailLayerVisibility,
    setGalleryViewMode,
    syncThumbnailLayerControls,
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
        selectionPending: false,
        selectionTargetRecordId: null,
        deletingRecordId: null,
        usingRecord: false,
        retryCollections: false,
        selectedRecord: null,
        selectedCollection: String(readWidget(node, "gallery_collection_id", "default")),
        viewMode: getStoredViewMode(),
        thumbnailLayerVisibility: getStoredThumbnailLayerVisibility(),
        thumbnailImageCache: new Map(),
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
        deleteConfirmOpen: false,
        deleteConfirmReturnFocus: null,
        pendingDeleteRecord: null,
        newCollectionDialogOpen: false,
        newCollectionDialogReturnFocus: null,
        saveDialogOpen: false,
        saveDialogReturnFocus: null,
        savingRecord: false,
        saveQueued: false,
        loadingCurrentInputs: false,
        showingCurrentInputs: false,
        thumbnailObserver: null,
        restoreFocus,
        resizeHandler: null,
        keydownHandler: null,
        closing: false,
    };
    node._poseGalleryPanel = state;
    state.thumbnailObserver = createThumbnailObserver(state);
    setGalleryViewMode(state, state.viewMode);
    syncThumbnailLayerControls(state);
    setPreviewLineWidth(state, state.previewLineWidth);

    const originalClose = panel.close.bind(panel);
    let closeTimer = null;
    let closeTransitionHandler = null;
    const cleanup = () => {
        window.removeEventListener("resize", state.resizeHandler);
        window.removeEventListener("keydown", state.keydownHandler);
        state.thumbnailObserver?.disconnect();
        state.thumbnailImageCache.clear();
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
    root.querySelector('[data-action="new-collection"]').addEventListener("click", () => openNewCollectionDialog(state));
    root.querySelector('[data-action="save-current"]').addEventListener("click", () => openSaveDialog(state));
    root.querySelector('[data-action="use-record"]').addEventListener("click", () => useSelectedRecord(state));
    root.querySelector('[data-action="show-current-inputs"]').addEventListener("click", () => {
        void toggleCurrentInputs(state);
    });
    root.querySelector('[data-action="delete-record"]').addEventListener("click", () => {
        if (!state.selectionPending && state.deletingRecordId == null && !state.loadingCurrentInputs && !state.saveQueued) {
            openDeleteConfirmation(state, state.selectedRecord);
        }
    });
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
    const deleteConfirmation = root.querySelector('[data-role="delete-confirmation"]');
    deleteConfirmation.querySelector('[data-action="cancel-delete"]').addEventListener("click", () => closeDeleteConfirmation(state));
    deleteConfirmation.querySelector('[data-action="confirm-delete"]').addEventListener("click", () => {
        const record = state.pendingDeleteRecord;
        if (!record) return;
        closeDeleteConfirmation(state, false);
        root.querySelector('[data-role="search"]').focus({ preventScroll: true });
        void deleteSelectedRecord(state, record);
    });
    deleteConfirmation.addEventListener("click", (event) => {
        if (event.target === deleteConfirmation) closeDeleteConfirmation(state);
    });
    const saveDialog = root.querySelector('[data-role="save-dialog"]');
    saveDialog.querySelector('[data-action="cancel-save"]').addEventListener("click", () => closeSaveDialog(state));
    saveDialog.querySelector('[data-role="save-form"]').addEventListener("submit", (event) => {
        event.preventDefault();
        submitSaveDialog(state, saveCurrent);
    });
    saveDialog.addEventListener("click", (event) => {
        if (event.target === saveDialog) closeSaveDialog(state);
    });
    const newCollectionDialog = root.querySelector('[data-role="new-collection-dialog"]');
    newCollectionDialog.querySelector('[data-action="cancel-new-collection"]').addEventListener("click", () => closeNewCollectionDialog(state));
    newCollectionDialog.querySelector('[data-role="new-collection-form"]').addEventListener("submit", (event) => {
        event.preventDefault();
        submitNewCollectionDialog(state, createCollection);
    });
    newCollectionDialog.addEventListener("click", (event) => {
        if (event.target === newCollectionDialog) closeNewCollectionDialog(state);
    });
    root.querySelector('[data-action="view-mode"]').addEventListener("click", () => {
        const index = GALLERY_VIEW_MODES.indexOf(state.viewMode);
        setGalleryViewMode(state, GALLERY_VIEW_MODES[(index + 1) % GALLERY_VIEW_MODES.length]);
        renderGalleryRecords(state);
    });
    root.querySelectorAll('[data-role="record-layer"]').forEach((input) => {
        input.addEventListener("change", () => {
            setThumbnailLayerVisibility(state, input.dataset.layer, input.checked);
            renderGalleryRecords(state);
        });
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
            if (state.newCollectionDialogOpen) {
                event.preventDefault();
                closeNewCollectionDialog(state);
                return;
            }
            if (state.saveDialogOpen) {
                event.preventDefault();
                closeSaveDialog(state);
                return;
            }
            if (state.deleteConfirmOpen) {
                event.preventDefault();
                closeDeleteConfirmation(state);
                return;
            }
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
        const focusScope = state.newCollectionDialogOpen
            ? state.root.querySelector('[data-role="new-collection-dialog"]')
            : state.saveDialogOpen
                ? state.root.querySelector('[data-role="save-dialog"]')
                : state.deleteConfirmOpen
                    ? state.root.querySelector('[data-role="delete-confirmation"]')
                    : state.settingsOpen
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

async function createCollection(state, name) {
    if (!name?.trim()) return;
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
    if (state.deletingRecordId === String(recordId)) return;
    const requestId = ++state.selectionRequestId;
    state.selectionPending = true;
    state.selectionTargetRecordId = String(recordId);
    updateRecordActions(state);
    try {
        const record = await jsonRequest(`/mincore/pose_gallery/records/${recordId}`);
        if (requestId !== state.selectionRequestId || state.closing) return;
        state.selectionPending = false;
        state.selectionTargetRecordId = null;
        state.selectedRecord = record;
        updateRecordActions(state);
        state.root.querySelectorAll(".mcore-pg-gallery-item").forEach((item) => {
            const isSelected = String(item.dataset.recordId) === String(recordId);
            item.classList.toggle("is-selected", isSelected);
            item.setAttribute("aria-pressed", String(isSelected));
        });
        showRecord(state, record);
    } catch (error) {
        if (requestId !== state.selectionRequestId || state.closing) return;
        state.selectionPending = false;
        state.selectionTargetRecordId = null;
        updateRecordActions(state);
        toast("error", "Pose Gallery", String(error));
    }
}

function updateRecordActions(state) {
    const busy = state.selectionPending || state.deletingRecordId != null || state.usingRecord
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord || busy;
    state.root.querySelector('[data-action="delete-record"]').disabled = !state.selectedRecord || busy;
}

async function deleteSelectedRecord(state, record) {
    if (!record || state.deletingRecordId != null || state.selectionPending || state.usingRecord) return;
    const recordId = String(record.id);
    const name = record.name || "Untitled record";

    state.deletingRecordId = recordId;
    updateRecordActions(state);
    try {
        await jsonRequest(`/mincore/pose_gallery/records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
        state.records = state.records.filter((item) => String(item.id) !== recordId);
        if (state.selectionTargetRecordId === recordId) {
            state.selectionRequestId += 1;
            state.selectionPending = false;
            state.selectionTargetRecordId = null;
        }

        const nodeState = state.node._poseGalleryState;
        const selectedWasDeleted = String(state.selectedRecord?.id) === recordId;
        if (nodeState?.source === "gallery" && String(nodeState.record_id) === recordId) {
            state.node._poseGalleryState = { ...nodeState, source: "inputs", record_id: "" };
        }
        if (String(readWidget(state.node, "gallery_record_id")) === recordId) {
            setWidget(state.node, "gallery_record_id", "");
            if (readWidget(state.node, "output_source") === "gallery") {
                setWidget(state.node, "output_source", "inputs");
            }
        }

        if (selectedWasDeleted) {
            state.selectionRequestId += 1;
            state.selectionPending = false;
            state.selectedRecord = null;
            if (state.node._poseGalleryState) showNodeState(state, state.node._poseGalleryState);
            else showCurrentState(state, {});
        }
        renderGalleryRecords(state);
        toast("success", "Pose Gallery", `Deleted: ${name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        if (state.deletingRecordId === recordId) state.deletingRecordId = null;
        updateRecordActions(state);
    }
}

function showCurrentState(state, preview) {
    state.showingCurrentInputs = false;
    state.selectionRequestId += 1;
    state.selectionPending = false;
    state.selectionTargetRecordId = null;
    state.selectedRecord = null;
    updateRecordActions(state);
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
        record: preview.source === "inputs" ? currentInputsDetails(preview) : null,
    });
    updateCurrentInputsButton(state);
}

function showRecord(state, record) {
    state.showingCurrentInputs = false;
    setPreviewSource(state, {
        image: record.assets.image,
        pose: record.assets.pose,
        pose_json: record.pose_json,
        masks: record.assets.masks || [],
        general_tags: record.general_tags,
        person_tags: record.person_tags || [],
        record,
    });
    updateCurrentInputsButton(state);
}

function updateCurrentInputsButton(state) {
    const button = state.root.querySelector('[data-action="show-current-inputs"]');
    if (!button) return;
    const nodeAlreadyShowsInputs = state.node._poseGalleryState?.source === "inputs";
    button.disabled = state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    button.textContent = state.loadingCurrentInputs
        ? "Loading current inputs…"
        : state.savingRecord || state.saveQueued ? "Saving record…"
        : state.showingCurrentInputs ? "Show node output"
            : nodeAlreadyShowsInputs ? "Refresh current inputs" : "Show current inputs";
    button.setAttribute("aria-pressed", String(state.showingCurrentInputs));
    const saveButton = state.root.querySelector('[data-action="save-current"]');
    if (saveButton) saveButton.disabled = state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    updateRecordActions(state);
}

function currentInputsDetails(preview) {
    return {
        source: "current_inputs",
        name: "Current inputs",
        image_shape: Array.isArray(preview.image_shape) ? preview.image_shape : [],
        mask_count: Number.isFinite(Number(preview.mask_count))
            ? Number(preview.mask_count)
            : (preview.masks || []).length,
        general_tags: preview.general_tags || "",
        person_tags: preview.person_tags || [],
    };
}

function showCurrentInputs(state, preview) {
    state.showingCurrentInputs = true;
    setPreviewSource(state, {
        image: preview.image,
        pose: preview.pose,
        pose_json: preview.pose_json,
        masks: preview.masks || [],
        general_tags: preview.general_tags || "",
        person_tags: preview.person_tags || [],
        record: currentInputsDetails(preview),
    });
    updateCurrentInputsButton(state);
}

async function toggleCurrentInputs(state) {
    if (state.loadingCurrentInputs || state.savingRecord || state.saveQueued) return;
    if (state.showingCurrentInputs) {
        if (state.selectedRecord) showRecord(state, state.selectedRecord);
        else if (state.node._poseGalleryState) showNodeState(state, state.node._poseGalleryState);
        else showCurrentState(state, {});
        return;
    }

    state.loadingCurrentInputs = true;
    updateCurrentInputsButton(state);
    try {
        await jsonRequest("/mincore/pose_gallery/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "preview",
                node_id: String(state.node.id),
            }),
        });
        await queueNode(state.node);
        toast("info", "Pose Gallery", "Queued current inputs preview.");
    } catch (error) {
        state.loadingCurrentInputs = false;
        updateCurrentInputsButton(state);
        toast("error", "Pose Gallery", String(error));
    }
}

function showNodeState(panelState, nodeState) {
    if (nodeState?.source === "gallery" && nodeState.record_id) {
        selectRecord(panelState, nodeState.record_id);
        return;
    }
    showCurrentState(panelState, nodeState);
}

async function saveCurrent(state, name) {
    if (state.savingRecord || state.saveQueued || state.loadingCurrentInputs) return;
    state.savingRecord = true;
    updateCurrentInputsButton(state);
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
        state.saveQueued = true;
        updateCurrentInputsButton(state);
        await queueNode(state.node);
        toast("info", "Pose Gallery", "Queued current inputs for saving.");
    } catch (error) {
        state.saveQueued = false;
        toast("error", "Pose Gallery", String(error));
    } finally {
        state.savingRecord = false;
        updateCurrentInputsButton(state);
    }
}

async function useSelectedRecord(state) {
    if (!state.selectedRecord || state.deletingRecordId != null || state.selectionPending || state.usingRecord
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued) return;
    const selectedRecord = state.selectedRecord;
    state.usingRecord = true;
    updateRecordActions(state);
    try {
        setWidget(state.node, "gallery_record_id", selectedRecord.id);
        setWidget(state.node, "output_source", "gallery");
        await queueNode(state.node);
        toast("success", "Pose Gallery", `Selected: ${selectedRecord.name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        state.usingRecord = false;
        updateRecordActions(state);
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
        computeSize: (width) => [Math.max(280, Number(width) || 0), 40],
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
    const currentInputs = Array.isArray(output.pose_gallery_current_inputs)
        ? output.pose_gallery_current_inputs[0]
        : null;
    if (state) {
        node._poseGalleryState = state;
        if (node._poseGalleryPanel) {
            const panelState = node._poseGalleryPanel;
            if (currentInputs) {
                panelState.loadingCurrentInputs = false;
                showCurrentInputs(panelState, currentInputs);
            } else {
                showNodeState(panelState, state);
            }
        }
    } else if (currentInputs && node._poseGalleryPanel) {
        node._poseGalleryPanel.loadingCurrentInputs = false;
        showCurrentInputs(node._poseGalleryPanel, currentInputs);
    }
    const capture = Array.isArray(output.pose_gallery_capture) ? output.pose_gallery_capture[0] : null;
    if (capture?.id) {
        if (node._poseGalleryPanel) {
            node._poseGalleryPanel.saveQueued = false;
            updateCurrentInputsButton(node._poseGalleryPanel);
        }
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

function clearPendingGalleryOperations() {
    for (const node of app.graph?._nodes || []) {
        const panelState = node.comfyClass === NODE_TYPE ? node._poseGalleryPanel : null;
        if (!panelState) continue;
        panelState.loadingCurrentInputs = false;
        panelState.saveQueued = false;
        updateCurrentInputsButton(panelState);
    }
}

api.addEventListener("execution_error", clearPendingGalleryOperations);
api.addEventListener("execution_interrupted", clearPendingGalleryOperations);

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
