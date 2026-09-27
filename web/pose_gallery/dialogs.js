import { resizePreviewCanvas } from "./preview.js";

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

export function openSettings(state) {
    const settings = state.root.querySelector('[data-role="settings-dialog"]');
    if (!settings || state.settingsOpen) return;
    state.settingsReturnFocus = document.activeElement;
    state.settingsOpen = true;
    state.root.querySelector('[data-action="settings"]').setAttribute("aria-expanded", "true");
    settings.hidden = false;
    settings.querySelector('[data-action="close-settings"]').focus({ preventScroll: true });
}

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

export function closeSaveDialog(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="save-dialog"]');
    if (!dialog || !state.saveDialogOpen) return;
    state.saveDialogOpen = false;
    dialog.hidden = true;
    const returnFocus = state.saveDialogReturnFocus;
    state.saveDialogReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

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

export function closeNewCollectionDialog(state, restoreFocus = true) {
    const dialog = state.root.querySelector('[data-role="new-collection-dialog"]');
    if (!dialog || !state.newCollectionDialogOpen) return;
    state.newCollectionDialogOpen = false;
    dialog.hidden = true;
    const returnFocus = state.newCollectionDialogReturnFocus;
    state.newCollectionDialogReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

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

export function submitSaveDialog(state, saveCurrent) {
    if (!state.saveDialogOpen || state.savingRecord) return;
    const name = state.root.querySelector('[data-role="save-name"]').value;
    closeSaveDialog(state, false);
    state.root.querySelector('[data-role="search"]').focus({ preventScroll: true });
    void saveCurrent(state, name);
}
