import { resizePreviewCanvas } from "./preview.js";

/** @typedef {import("./types.js").GalleryPanelState} GalleryPanelState */
/** @typedef {import("./types.js").GalleryRecord} GalleryRecord */

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

/** @param {GalleryPanelState} state @param {GalleryRecord | null} record */
export function openDeleteConfirmation(state, record) {
    const dialog = state.root.querySelector('[data-role="delete-confirmation"]');
    if (!record || !dialog || state.deleteConfirmOpen) return;
    state.pendingDeleteRecord = record;
    state.deleteConfirmReturnFocus = document.activeElement;
    state.root.querySelector('[data-role="delete-record-name"]').textContent = record.name || "Untitled record";
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
    state.pendingDeleteRecord = null;
    const returnFocus = state.deleteConfirmReturnFocus;
    state.deleteConfirmReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
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
