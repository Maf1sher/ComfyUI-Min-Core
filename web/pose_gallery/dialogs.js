import { resizePreviewCanvas } from "./preview.js";

/** @typedef {import("./types.js").GalleryPanelState} GalleryPanelState */
/** @typedef {import("./types.js").GalleryRecordSummary} GalleryRecordSummary */

/** @param {GalleryPanelState} state */
export function openPreviewLightbox(state) {
    const lightbox = state.root.querySelector('[data-role="preview-lightbox"]');
    if (!lightbox || state.previewExpanded) return;
    state.previewReturnFocus = document.activeElement;
    state.previewExpanded = true;
    state.root.querySelector('[data-action="expand-preview"]').setAttribute("aria-expanded", "true");
    lightbox.hidden = false;
    resizePreviewCanvas(state);
    lightbox.querySelector('[data-action="close-preview"]').focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closePreviewLightbox(state) {
    const lightbox = state.root.querySelector('[data-role="preview-lightbox"]');
    if (!lightbox || !state.previewExpanded) return;
    state.previewExpanded = false;
    state.root.querySelector('[data-action="expand-preview"]').setAttribute("aria-expanded", "false");
    lightbox.hidden = true;
    const returnFocus = state.previewReturnFocus;
    state.previewReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function openSettings(state) {
    const settings = state.root.querySelector('[data-role="settings-dialog"]');
    if (!settings || state.settingsOpen) return;
    state.settingsReturnFocus = document.activeElement;
    state.settingsOpen = true;
    state.root.querySelector('[data-action="settings"]').setAttribute("aria-expanded", "true");
    settings.hidden = false;
    settings.querySelector('[data-action="close-settings"]').focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeSettings(state) {
    const settings = state.root.querySelector('[data-role="settings-dialog"]');
    if (!settings || !state.settingsOpen) return;
    state.settingsOpen = false;
    state.root.querySelector('[data-action="settings"]').setAttribute("aria-expanded", "false");
    settings.hidden = true;
    const returnFocus = state.settingsReturnFocus;
    state.settingsReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state @param {GalleryRecordSummary[] | null} records */
export function openDeleteConfirmation(state, records) {
    const dialog = state.root.querySelector('[data-role="delete-confirmation"]');
    if (!records?.length || !dialog || state.deleteConfirmOpen) return;
    state.pendingDeleteRecords = records;
    state.deleteConfirmReturnFocus = document.activeElement;
    const singular = records.length === 1;
    state.root.querySelector('[data-role="delete-title"]').textContent = singular ? "Delete record?" : `Delete ${records.length} records?`;
    state.root.querySelector('[data-role="delete-record-name"]').textContent = singular
        ? records[0].name || "Untitled record"
        : `${records.length} records`;
    dialog.querySelector('[data-action="confirm-delete"]').textContent = singular ? "Delete record" : `Delete ${records.length} records`;
    state.deleteConfirmOpen = true;
    dialog.hidden = false;
    dialog.querySelector('[data-action="cancel-delete"]').focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeDeleteConfirmation(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="delete-confirmation"]');
    if (!dialog || !state.deleteConfirmOpen) return;
    state.deleteConfirmOpen = false;
    dialog.hidden = true;
    state.pendingDeleteRecords = [];
    const returnFocus = state.deleteConfirmReturnFocus;
    state.deleteConfirmReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state @param {GalleryRecordSummary[] | null} records */
export function openMoveDialog(state, records) {
    const dialog = state.root.querySelector('[data-role="move-dialog"]');
    if (!records?.length || !dialog || state.moveDialogOpen || state.movingRecordId != null) return;
    const sourceCollectionId = records[0].collection_id;
    const destinations = state.collections.filter((collection) => collection.id !== sourceCollectionId);
    if (!destinations.length) return;

    state.pendingMoveRecords = records;
    state.moveDialogReturnFocus = document.activeElement;
    const singular = records.length === 1;
    const source = state.collections.find((collection) => collection.id === sourceCollectionId);
    state.root.querySelector('[data-role="move-title"]').textContent = singular ? "Move record" : `Move ${records.length} records`;
    state.root.querySelector('[data-role="move-description"]').textContent = singular
        ? `Move “${records[0].name || "Untitled record"}” from ${source?.name || "current collection"} to another collection. The record and its files will be kept.`
        : `Move ${records.length} records from ${source?.name || "current collection"} to another collection. Their files will be kept.`;
    dialog.querySelector('[data-action="confirm-move"]').textContent = singular ? "Move record" : `Move ${records.length} records`;
    const select = state.root.querySelector('[data-role="move-collection"]');
    select.replaceChildren();
    for (const collection of destinations) {
        const option = document.createElement("option");
        option.value = collection.id;
        option.textContent = collection.name;
        select.appendChild(option);
    }

    state.moveDialogOpen = true;
    dialog.hidden = false;
    select.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeMoveDialog(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="move-dialog"]');
    if (!dialog || !state.moveDialogOpen) return;
    state.moveDialogOpen = false;
    dialog.hidden = true;
    state.pendingMoveRecords = [];
    const returnFocus = state.moveDialogReturnFocus;
    state.moveDialogReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state @param {(state: GalleryPanelState, records: GalleryRecordSummary[], collectionId: string) => Promise<void>} moveSelectedRecords */
export function submitMoveDialog(state, moveSelectedRecords) {
    if (!state.moveDialogOpen || !state.pendingMoveRecords.length) return;
    const collectionId = state.root.querySelector('[data-role="move-collection"]').value;
    if (!collectionId || collectionId === state.pendingMoveRecords[0].collection_id) return;
    const records = state.pendingMoveRecords;
    closeMoveDialog(state, false);
    state.root.querySelector('[data-role="search"]').focus({ preventScroll: true });
    void moveSelectedRecords(state, records, collectionId);
}

/** @param {GalleryPanelState} state @param {{ id: string, name: string } | null} collection */
export function openDeleteCollectionConfirmation(state, collection) {
    const dialog = state.root.querySelector('[data-role="delete-collection-confirmation"]');
    if (!collection || collection.id === "default" || !dialog || state.deleteCollectionConfirmOpen) return;
    state.pendingDeleteCollection = collection;
    state.deleteCollectionConfirmReturnFocus = document.activeElement;
    state.root.querySelector('[data-role="delete-collection-name"]').textContent = collection.name;
    const count = state.records.length;
    state.root.querySelector('[data-role="delete-collection-count"]').textContent =
        `${count} saved record${count === 1 ? "" : "s"}`;
    state.deleteCollectionConfirmOpen = true;
    dialog.hidden = false;
    dialog.querySelector('[data-action="cancel-delete-collection"]').focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeDeleteCollectionConfirmation(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="delete-collection-confirmation"]');
    if (!dialog || !state.deleteCollectionConfirmOpen) return;
    state.deleteCollectionConfirmOpen = false;
    dialog.hidden = true;
    state.pendingDeleteCollection = null;
    const returnFocus = state.deleteCollectionConfirmReturnFocus;
    state.deleteCollectionConfirmReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function openSaveDialog(state) {
    const dialog = state.root.querySelector('[data-role="save-dialog"]');
    if (!dialog || state.saveDialogOpen || state.savingRecord || state.saveQueued || state.loadingCurrentInputs) return;
    state.saveDialogReturnFocus = document.activeElement;
    state.saveDialogOpen = true;
    dialog.hidden = false;
    const nameInput = dialog.querySelector('[data-role="save-name"]');
    nameInput.value = "";
    nameInput.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeSaveDialog(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="save-dialog"]');
    if (!dialog || !state.saveDialogOpen) return;
    state.saveDialogOpen = false;
    dialog.hidden = true;
    const returnFocus = state.saveDialogReturnFocus;
    state.saveDialogReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function openNewCollectionDialog(state) {
    const dialog = state.root.querySelector('[data-role="new-collection-dialog"]');
    if (!dialog || state.newCollectionDialogOpen) return;
    state.newCollectionDialogReturnFocus = document.activeElement;
    state.newCollectionDialogOpen = true;
    dialog.hidden = false;
    const nameInput = dialog.querySelector('[data-role="new-collection-name"]');
    nameInput.value = "";
    nameInput.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state */
export function closeNewCollectionDialog(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="new-collection-dialog"]');
    if (!dialog || !state.newCollectionDialogOpen) return;
    state.newCollectionDialogOpen = false;
    dialog.hidden = true;
    const returnFocus = state.newCollectionDialogReturnFocus;
    state.newCollectionDialogReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

/** @param {GalleryPanelState} state @param {(state: GalleryPanelState, name: string) => Promise<void>} createCollection */
export function submitNewCollectionDialog(state, createCollection) {
    if (!state.newCollectionDialogOpen) return;
    const nameInput = state.root.querySelector('[data-role="new-collection-name"]');
    const name = nameInput.value.trim();
    if (!name) {
        nameInput.focus({ preventScroll: true });
        return;
    }
    closeNewCollectionDialog(state);
    void createCollection(state, name);
}

/** @param {GalleryPanelState} state @param {(state: GalleryPanelState, name: string) => Promise<void>} saveCurrent */
export function submitSaveDialog(state, saveCurrent) {
    if (!state.saveDialogOpen || state.savingRecord) return;
    const name = state.root.querySelector('[data-role="save-name"]').value;
    closeSaveDialog(state, false);
    state.root.querySelector('[data-role="search"]').focus({ preventScroll: true });
    void saveCurrent(state, name);
}
