import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { jsonRequest, queueNode, toast } from "./pose_gallery/api.js";
import { applyPanelLayout, bindPanelEvents } from "./pose_gallery/panel_events.js";
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
    renderRecords,
    setGalleryViewMode,
    syncThumbnailLayerControls,
} from "./pose_gallery/view.js";

const NODE_TYPE = "MinCore_PoseGallery";
const STYLE_ID = "mincore-pose-gallery-stylesheet";

/** @typedef {import("./pose_gallery/types.js").GalleryRecord} GalleryRecord */
/** @typedef {import("./pose_gallery/types.js").GalleryPanelState} GalleryPanelState */

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

/** @param {GalleryPanelState} state */
function renderGalleryRecords(state) {
    renderRecords(state, {
        onSelect: (recordId) => selectRecord(state, recordId),
        onRetry: () => state.retryCollections ? refreshCollections(state) : loadRecords(state),
        onPageChange: (page, action) => {
            state.recordsPage = page;
            renderGalleryRecords(state);
            const records = state.root.querySelector('[data-role="records"]');
            records.scrollTop = 0;
            let focusTarget = state.root.querySelector(`[data-action="${action}"]`);
            if (focusTarget?.disabled) {
                const fallbackAction = action === "next-page" ? "previous-page" : "next-page";
                focusTarget = state.root.querySelector(`[data-action="${fallbackAction}"]`);
            }
            focusTarget?.focus({ preventScroll: true });
        },
        onSelectionChange: () => updateRecordActions(state),
    });
    updateRecordActions(state);
}

/**
 * @param {any} node
 * @param {any} panel LiteGraph panel instance.
 * @param {HTMLElement} backdrop
 * @param {HTMLElement} root
 * @param {Element | null} restoreFocus
 * @returns {GalleryPanelState}
 */
function createPanelState(node, panel, backdrop, root, restoreFocus) {
    return {
        node,
        panel,
        backdrop,
        root,
        collections: [],
        records: [],
        recordsPage: 0,
        recordsStatus: "loading",
        recordsError: null,
        recordsRequestId: 0,
        collectionsRequestId: 0,
        selectionRequestId: 0,
        selectedRecordIds: new Set(),
        selectionPending: false,
        selectionTargetRecordId: null,
        deletingRecordId: null,
        movingRecordId: null,
        bulkOperation: null,
        deletingCollectionId: null,
        usingRecord: false,
        retryCollections: false,
        selectedRecord: null,
        selectedCollection: String(readWidget(node, "gallery_collection_id", "default")),
        viewMode: getStoredViewMode(),
        thumbnailLayerVisibility: getStoredThumbnailLayerVisibility(),
        thumbnailImageCache: new Map(),
        previewImages: [],
        previewLayers: [],
        maskPreviewCanvases: new Map(),
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
        pendingDeleteRecords: [],
        moveDialogOpen: false,
        moveDialogReturnFocus: null,
        pendingMoveRecords: [],
        deleteCollectionConfirmOpen: false,
        deleteCollectionConfirmReturnFocus: null,
        pendingDeleteCollection: null,
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
        searchTimer: null,
        closing: false,
    };
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

    const state = createPanelState(node, panel, backdrop, root, restoreFocus);
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
        if (state.searchTimer != null) window.clearTimeout(state.searchTimer);
        state.thumbnailObserver?.disconnect();
        state.thumbnailImageCache.clear();
        backdrop.remove();
        if (state.posePreviewTimer != null) window.clearTimeout(state.posePreviewTimer);
        state.previewLayers.forEach((layer) => {
            if (layer.previewObjectUrl) URL.revokeObjectURL(layer.previewObjectUrl);
        });
        state.previewImages.forEach((image) => {
            image.onload = null;
            image.onerror = null;
            image.removeAttribute("src");
        });
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
    bindPanelEvents(state, {
        renderGalleryRecords,
        useSelectedRecord,
        toggleCurrentInputs,
        deleteSelectedRecords,
        moveSelectedRecords,
        deleteCollection,
        showCurrentState,
        loadRecords,
        createCollection,
        updateCollectionActions,
        saveCurrent,
        setWidget,
    });
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

/** @param {GalleryPanelState} state */
async function refreshCollections(state) {
    if (state.closing) return;
    const requestId = ++state.collectionsRequestId;
    state.retryCollections = true;
    state.records = [];
    state.recordsError = null;
    state.recordsStatus = "loading";
    updateCollectionActions(state);
    renderGalleryRecords(state);
    let payload;
    try {
        payload = await jsonRequest("/mincore/pose_gallery/collections");
    } catch (error) {
        if (requestId === state.collectionsRequestId && !state.closing) {
            state.recordsError = String(error);
            state.recordsStatus = "error";
            updateCollectionActions(state);
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

/** @param {GalleryPanelState} state */
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
        state.selectedRecordIds.clear();
        state.root.querySelector('[data-action="use-record"]').disabled = true;
        if (state.node._poseGalleryState) showCurrentState(state, state.node._poseGalleryState);
        else showCurrentState(state, {});
        await refreshCollections(state);
        toast("success", "Pose Gallery", `Created collection: ${collection.name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

/** @param {GalleryPanelState} state */
async function loadRecords(state) {
    if (state.closing) return false;
    state.retryCollections = false;
    state.recordsPage = 0;
    const requestId = ++state.recordsRequestId;
    const collectionId = state.selectedCollection;
    state.records = [];
    state.recordsError = null;
    state.recordsStatus = "loading";
    updateCollectionActions(state);
    renderGalleryRecords(state);
    try {
        const query = new URLSearchParams({ collection_id: collectionId });
        const payload = await jsonRequest(`/mincore/pose_gallery/records?${query}`);
        if (requestId !== state.recordsRequestId || collectionId !== state.selectedCollection || state.closing) return false;
        state.records = payload.records || [];
        const availableRecordIds = new Set(state.records.map((record) => String(record.id)));
        state.selectedRecordIds = new Set(
            Array.from(state.selectedRecordIds).filter((recordId) => availableRecordIds.has(recordId)),
        );
        state.recordsStatus = "ready";
        updateCollectionActions(state);
        renderGalleryRecords(state);
        return true;
    } catch (error) {
        if (requestId !== state.recordsRequestId || collectionId !== state.selectedCollection || state.closing) return false;
        state.recordsError = String(error);
        state.recordsStatus = "error";
        updateCollectionActions(state);
        renderGalleryRecords(state);
        toast("error", "Pose Gallery", String(error));
        return false;
    }
}

/** @param {GalleryPanelState} state @param {string} recordId */
async function selectRecord(state, recordId) {
    if (state.bulkOperation != null || state.deletingRecordId === String(recordId) || state.movingRecordId != null) return;
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
            item.querySelector(".mcore-pg-gallery-item-preview")?.setAttribute("aria-pressed", String(isSelected));
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

/** @param {GalleryPanelState} state */
function updateRecordActions(state) {
    const busy = state.selectionPending || state.deletingRecordId != null || state.deletingCollectionId != null || state.usingRecord
        || state.movingRecordId != null || state.bulkOperation != null || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    const selectedCount = state.selectedRecordIds.size;
    const selectedTargets = selectedCount
        ? state.records.filter((record) => state.selectedRecordIds.has(String(record.id)))
        : state.selectedRecord ? [state.selectedRecord] : [];
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord || busy;
    const deleteButton = state.root.querySelector('[data-action="delete-record"]');
    deleteButton.textContent = state.bulkOperation === "delete"
        ? "Deleting…"
        : selectedCount ? `Delete ${selectedCount} selected` : "Delete record";
    deleteButton.disabled = !selectedTargets.length || busy;
    const moveButton = state.root.querySelector('[data-action="move-record"]');
    if (moveButton) {
        const sourceCollectionId = selectedTargets[0]?.collection_id;
        const hasDestination = sourceCollectionId
            && state.collections.some((collection) => collection.id !== sourceCollectionId);
        moveButton.textContent = state.bulkOperation === "move"
            ? "Moving…"
            : selectedCount ? `Move ${selectedCount} selected` : "Move to collection";
        moveButton.disabled = !selectedTargets.length || !hasDestination || busy;
    }
    const countBadge = state.root.querySelector('[data-role="selection-count"]');
    countBadge.hidden = selectedCount === 0;
    countBadge.textContent = `${selectedCount} selected`;
    const clearButton = state.root.querySelector('[data-action="clear-selection"]');
    clearButton.hidden = selectedCount === 0;
    clearButton.disabled = busy;
    const visibleCheckboxes = Array.from(state.root.querySelectorAll('[data-role="record-select"]'));
    const allVisibleSelected = visibleCheckboxes.length > 0 && visibleCheckboxes.every((checkbox) => checkbox.checked);
    const selectPageButton = state.root.querySelector('[data-action="select-page"]');
    selectPageButton.textContent = "Select page";
    selectPageButton.hidden = allVisibleSelected;
    selectPageButton.disabled = visibleCheckboxes.length === 0 || busy;
    visibleCheckboxes.forEach((checkbox) => { checkbox.disabled = busy; });
    updateCollectionActions(state);
}

/** @param {GalleryPanelState} state */
function updateCollectionActions(state) {
    const button = state.root.querySelector('[data-action="delete-collection"]');
    const busy = state.deletingCollectionId != null || state.deletingRecordId != null || state.usingRecord
        || state.movingRecordId != null || state.bulkOperation != null
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    button.disabled = state.selectedCollection === "default"
        || state.recordsStatus !== "ready"
        || Boolean(state.recordsError)
        || busy;
    state.root.querySelector('[data-role="collection"]').disabled = state.deletingCollectionId != null
        || state.movingRecordId != null || state.bulkOperation != null;
    state.root.querySelector('[data-action="new-collection"]').disabled = state.deletingCollectionId != null
        || state.movingRecordId != null || state.bulkOperation != null;
    const saveButton = state.root.querySelector('[data-action="save-current"]');
    if (saveButton) {
        saveButton.disabled = state.deletingCollectionId != null || state.movingRecordId != null || state.bulkOperation != null
            || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    }
}

/** @param {GalleryPanelState} state @param {import("./pose_gallery/types.js").GalleryRecordSummary[]} records @param {string} collectionId */
async function moveSelectedRecords(state, records, collectionId) {
    const recordIds = Array.from(new Set(records.map((record) => String(record.id))));
    if (!recordIds.length || state.movingRecordId != null || state.deletingRecordId != null || state.bulkOperation != null
        || state.deletingCollectionId != null || state.selectionPending || state.usingRecord
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued) return;
    const destination = state.collections.find((collection) => collection.id === collectionId);
    if (!destination || records.every((record) => destination.id === record.collection_id)) return;

    const previewRecordId = String(state.selectedRecord?.id || "");
    state.movingRecordId = recordIds[0];
    state.bulkOperation = "move";
    updateRecordActions(state);
    let recordIdToSelect = null;
    try {
        await jsonRequest("/mincore/pose_gallery/records/batch/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ record_ids: recordIds, collection_id: destination.id }),
        });
        if (state.closing) return;

        state.selectedCollection = destination.id;
        state.root.querySelector('[data-role="collection"]').value = destination.id;
        setWidget(state.node, "gallery_collection_id", destination.id);
        state.selectedRecordIds.clear();
        showCurrentState(state, {});
        const loaded = await loadRecords(state);
        if (loaded && !state.closing) {
            recordIdToSelect = recordIds.includes(previewRecordId) ? previewRecordId : recordIds[0];
        }
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        state.movingRecordId = null;
        state.bulkOperation = null;
        updateRecordActions(state);
    }
    if (recordIdToSelect && !state.closing) await selectRecord(state, recordIdToSelect);
    if (!state.closing && recordIdToSelect) {
        toast("success", "Pose Gallery", `Moved ${recordIds.length} record${recordIds.length === 1 ? "" : "s"} → ${destination.name}`);
    }
}

/** @param {GalleryPanelState} state @param {import("./pose_gallery/types.js").GalleryRecordSummary[]} records */
async function deleteSelectedRecords(state, records) {
    const recordIds = Array.from(new Set(records.map((record) => String(record.id))));
    if (!recordIds.length || state.deletingRecordId != null || state.movingRecordId != null || state.bulkOperation != null
        || state.deletingCollectionId != null || state.selectionPending || state.usingRecord) return;

    state.deletingRecordId = recordIds[0];
    state.bulkOperation = "delete";
    updateRecordActions(state);
    let restoreNodePreview = false;
    try {
        await jsonRequest("/mincore/pose_gallery/records/batch/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ record_ids: recordIds }),
        });
        if (state.closing) return;

        const deletedIds = new Set(recordIds);
        state.records = state.records.filter((item) => !deletedIds.has(String(item.id)));
        recordIds.forEach((id) => state.selectedRecordIds.delete(id));
        if (deletedIds.has(String(state.selectionTargetRecordId))) {
            state.selectionRequestId += 1;
            state.selectionPending = false;
            state.selectionTargetRecordId = null;
        }

        let nodeState = state.node._poseGalleryState;
        const selectedWasDeleted = deletedIds.has(String(state.selectedRecord?.id));
        if (nodeState?.source === "gallery" && deletedIds.has(String(nodeState.record_id))) {
            nodeState = { ...nodeState, source: "inputs", record_id: "" };
            state.node._poseGalleryState = nodeState;
        }
        if (deletedIds.has(String(readWidget(state.node, "gallery_record_id")))) {
            setWidget(state.node, "gallery_record_id", "");
            if (readWidget(state.node, "output_source") === "gallery") {
                setWidget(state.node, "output_source", "inputs");
            }
        }

        if (selectedWasDeleted) {
            state.selectionRequestId += 1;
            state.selectionPending = false;
            state.selectedRecord = null;
            restoreNodePreview = true;
        }
        renderGalleryRecords(state);
        toast("success", "Pose Gallery", `Deleted ${recordIds.length} record${recordIds.length === 1 ? "" : "s"}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        state.deletingRecordId = null;
        state.bulkOperation = null;
        updateRecordActions(state);
    }
    if (restoreNodePreview && !state.closing) {
        if (state.node._poseGalleryState) showNodeState(state, state.node._poseGalleryState);
        else showCurrentState(state, {});
    }
}

/** @param {GalleryPanelState} state @param {import("./pose_gallery/types.js").GalleryCollection} collection */
async function deleteCollection(state, collection) {
    if (!collection || collection.id === "default" || state.selectedCollection !== collection.id
        || state.deletingCollectionId != null || state.bulkOperation != null || state.recordsStatus !== "ready") return;

    const collectionId = String(collection.id);
    const nodeState = state.node._poseGalleryState;
    const activeRecordId = String(
        readWidget(state.node, "gallery_record_id") || nodeState?.record_id || "",
    );
    const query = new URLSearchParams();
    if (activeRecordId) query.set("record_id", activeRecordId);

    state.deletingCollectionId = collectionId;
    updateRecordActions(state);
    try {
        const queryString = query.toString();
        const suffix = queryString ? `?${queryString}` : "";
        const result = await jsonRequest(
            `/mincore/pose_gallery/collections/${encodeURIComponent(collectionId)}${suffix}`,
            { method: "DELETE" },
        );
        if (state.closing) return;

        if (result.active_record_deleted) {
            state.node._poseGalleryState = { ...(nodeState || {}), source: "inputs", record_id: "" };
            setWidget(state.node, "gallery_record_id", "");
            if (readWidget(state.node, "output_source") === "gallery") {
                setWidget(state.node, "output_source", "inputs");
            }
        }

        state.selectedCollection = "default";
        state.selectedRecordIds.clear();
        state.collections = state.collections.filter((item) => item.id !== collectionId);
        const collectionSelect = state.root.querySelector('[data-role="collection"]');
        Array.from(collectionSelect.options).find((option) => option.value === collectionId)?.remove();
        collectionSelect.value = "default";
        setWidget(state.node, "gallery_collection_id", "default");
        state.selectionRequestId += 1;
        showCurrentState(state, result.active_record_deleted ? state.node._poseGalleryState : {});

        try {
            await refreshCollections(state);
        } catch (error) {
            toast("error", "Pose Gallery", `Collection deleted, but the collection list could not be refreshed: ${String(error)}`);
        }
        const count = Number(result.deleted_records) || 0;
        toast("success", "Pose Gallery", `Deleted collection: ${collection.name} (${count} record${count === 1 ? "" : "s"} removed)`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    } finally {
        if (state.deletingCollectionId === collectionId) state.deletingCollectionId = null;
        updateRecordActions(state);
    }
}

/** @param {GalleryPanelState} state @param {Record<string, any>} preview */
function showCurrentState(state, preview) {
    state.showingCurrentInputs = false;
    state.selectionRequestId += 1;
    state.selectionPending = false;
    state.selectionTargetRecordId = null;
    state.selectedRecord = null;
    updateRecordActions(state);
    state.root.querySelectorAll(".mcore-pg-gallery-item.is-selected").forEach((item) => {
        item.classList.remove("is-selected");
        item.querySelector(".mcore-pg-gallery-item-preview")?.setAttribute("aria-pressed", "false");
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

/** @param {GalleryPanelState} state @param {GalleryRecord} record */
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

/** @param {GalleryPanelState} state */
function updateCurrentInputsButton(state) {
    const button = state.root.querySelector('[data-action="show-current-inputs"]');
    if (!button) return;
    const nodeAlreadyShowsInputs = state.node._poseGalleryState?.source === "inputs";
    button.disabled = state.deletingRecordId != null || state.movingRecordId != null || state.bulkOperation != null
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    button.textContent = state.loadingCurrentInputs
        ? "Loading current inputs…"
        : state.showingCurrentInputs ? "Show node output"
            : nodeAlreadyShowsInputs ? "Refresh current inputs" : "Show current inputs";
    button.setAttribute("aria-pressed", String(state.showingCurrentInputs));
    const saveButton = state.root.querySelector('[data-action="save-current"]');
    if (saveButton) {
        saveButton.textContent = state.savingRecord || state.saveQueued ? "Saving record…" : "Save current inputs";
        saveButton.disabled = state.deletingRecordId != null || state.deletingCollectionId != null
            || state.movingRecordId != null || state.bulkOperation != null
            || state.loadingCurrentInputs || state.savingRecord || state.saveQueued;
    }
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
        pose_person_count: preview.pose_person_count,
        person_tag_mismatch: preview.person_tag_mismatch,
    };
}

/** @param {GalleryPanelState} state @param {Record<string, any>} preview */
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

/** @param {GalleryPanelState} state */
async function toggleCurrentInputs(state) {
    if (state.deletingRecordId != null || state.movingRecordId != null || state.bulkOperation != null || state.deletingCollectionId != null
        || state.loadingCurrentInputs || state.savingRecord || state.saveQueued) return;
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

/** @param {GalleryPanelState} panelState @param {Record<string, any>} nodeState */
function showNodeState(panelState, nodeState) {
    if (nodeState?.source === "gallery" && nodeState.record_id) {
        selectRecord(panelState, nodeState.record_id);
        return;
    }
    showCurrentState(panelState, nodeState);
}

/** @param {GalleryPanelState} state */
async function saveCurrent(state, name) {
    if (state.deletingRecordId != null || state.movingRecordId != null || state.bulkOperation != null || state.deletingCollectionId != null
        || state.savingRecord || state.saveQueued || state.loadingCurrentInputs) return;
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

/** @param {GalleryPanelState} state */
async function useSelectedRecord(state) {
    if (!state.selectedRecord || state.deletingRecordId != null || state.movingRecordId != null
        || state.bulkOperation != null || state.deletingCollectionId != null || state.selectionPending || state.usingRecord
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
