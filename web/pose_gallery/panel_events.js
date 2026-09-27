import {
    closeDeleteConfirmation,
    closeDeleteCollectionConfirmation,
    closeNewCollectionDialog,
    closeMoveDialog,
    closePreviewLightbox,
    closeSaveDialog,
    closeSettings,
    openDeleteConfirmation,
    openDeleteCollectionConfirmation,
    openNewCollectionDialog,
    openMoveDialog,
    openPreviewLightbox,
    openSaveDialog,
    openSettings,
    submitNewCollectionDialog,
    submitMoveDialog,
    submitSaveDialog,
} from "./dialogs.js";
import { resizePreviewCanvas, setPreviewLineWidth } from "./preview.js";
import {
    GALLERY_VIEW_MODES,
    setGalleryViewMode,
    setThumbnailLayerVisibility,
} from "./view.js";

/** @typedef {import("./types.js").GalleryPanelState} GalleryPanelState */
/** @typedef {import("./types.js").GalleryPanelActions} GalleryPanelActions */

/** @param {any} panel */
export function applyPanelLayout(panel) {
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

/** @param {GalleryPanelState} state @param {GalleryPanelActions} actions */
export function bindPanelEvents(state, actions) {
    const { node, panel, backdrop, root } = state;
    const {
        renderGalleryRecords,
        useSelectedRecord,
        toggleCurrentInputs,
        deleteSelectedRecord,
        moveSelectedRecord,
        deleteCollection,
        showCurrentState,
        loadRecords,
        createCollection,
        updateCollectionActions,
        saveCurrent,
        setWidget,
    } = actions;

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
        if (!state.selectionPending && state.deletingRecordId == null && state.movingRecordId == null
            && state.deletingCollectionId == null && !state.loadingCurrentInputs && !state.savingRecord && !state.saveQueued) {
            openDeleteConfirmation(state, state.selectedRecord);
        }
    });
    root.querySelector('[data-action="move-record"]').addEventListener("click", () => {
        if (!state.selectionPending && state.deletingRecordId == null && state.movingRecordId == null
            && state.deletingCollectionId == null && !state.loadingCurrentInputs
            && !state.savingRecord && !state.saveQueued) {
            openMoveDialog(state, state.selectedRecord);
        }
    });
    root.querySelector('[data-action="delete-collection"]').addEventListener("click", () => {
        if (state.selectedCollection === "default" || state.deletingCollectionId != null) return;
        const collection = state.collections.find((item) => item.id === state.selectedCollection);
        openDeleteCollectionConfirmation(state, collection);
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
    const moveDialog = root.querySelector('[data-role="move-dialog"]');
    moveDialog.querySelector('[data-action="cancel-move"]').addEventListener("click", () => closeMoveDialog(state));
    moveDialog.querySelector('[data-action="confirm-move"]').addEventListener("click", () => {
        submitMoveDialog(state, moveSelectedRecord);
    });
    moveDialog.addEventListener("click", (event) => {
        if (event.target === moveDialog) closeMoveDialog(state);
    });
    const deleteCollectionConfirmation = root.querySelector('[data-role="delete-collection-confirmation"]');
    deleteCollectionConfirmation.querySelector('[data-action="cancel-delete-collection"]').addEventListener("click", () => closeDeleteCollectionConfirmation(state));
    deleteCollectionConfirmation.querySelector('[data-action="confirm-delete-collection"]').addEventListener("click", () => {
        const collection = state.pendingDeleteCollection;
        if (!collection) return;
        closeDeleteCollectionConfirmation(state, false);
        root.querySelector('[data-role="search"]').focus({ preventScroll: true });
        void deleteCollection(state, collection);
    });
    deleteCollectionConfirmation.addEventListener("click", (event) => {
        if (event.target === deleteCollectionConfirmation) closeDeleteCollectionConfirmation(state);
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
        updateCollectionActions(state);
        loadRecords(state);
    });
    root.querySelector('[data-role="search"]').addEventListener("input", () => {
        if (state.searchTimer != null) window.clearTimeout(state.searchTimer);
        state.recordsPage = 0;
        state.searchTimer = window.setTimeout(() => {
            state.searchTimer = null;
            renderGalleryRecords(state);
        }, 160);
    });
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
            if (state.moveDialogOpen) {
                event.preventDefault();
                closeMoveDialog(state);
                return;
            }
            if (state.deleteCollectionConfirmOpen) {
                event.preventDefault();
                closeDeleteCollectionConfirmation(state);
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
                if (state.searchTimer != null) window.clearTimeout(state.searchTimer);
                state.searchTimer = null;
                state.recordsPage = 0;
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
                    : state.moveDialogOpen
                        ? state.root.querySelector('[data-role="move-dialog"]')
                        : state.deleteCollectionConfirmOpen
                            ? state.root.querySelector('[data-role="delete-collection-confirmation"]')
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
}
