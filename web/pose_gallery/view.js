import {
    drawRecordThumbnail,
    PREVIEW_LINE_WIDTH_MAX,
    PREVIEW_LINE_WIDTH_MIN,
    PREVIEW_LINE_WIDTH_STEP,
} from "./preview.js";

export const GALLERY_VIEW_MODES = ["medium", "large", "tiles"];
const GALLERY_VIEW_MODE_KEY = "openpose_editor.gallery.viewMode";
const THUMBNAIL_LAYER_KEY = "mincore.poseGallery.thumbnailLayers";
const THUMBNAIL_LAYERS = ["image", "pose", "masks"];
const RECORDS_PER_PAGE = 48;
const RECORD_SEARCH_TEXT = new WeakMap();

export function getStoredThumbnailLayerVisibility() {
    const defaults = { image: true, pose: true, masks: false };
    try {
        const stored = JSON.parse(localStorage.getItem(THUMBNAIL_LAYER_KEY) || "{}");
        return Object.fromEntries(THUMBNAIL_LAYERS.map((layer) => [
            layer,
            typeof stored?.[layer] === "boolean" ? stored[layer] : defaults[layer],
        ]));
    } catch (_error) {
        return defaults;
    }
}

export function setThumbnailLayerVisibility(state, layer, visible) {
    if (!THUMBNAIL_LAYERS.includes(layer)) return;
    state.thumbnailLayerVisibility[layer] = Boolean(visible);
    try {
        localStorage.setItem(THUMBNAIL_LAYER_KEY, JSON.stringify(state.thumbnailLayerVisibility));
    } catch (_error) {
        // The setting still applies to the current gallery if storage is unavailable.
    }
    syncThumbnailLayerControls(state);
}

export function syncThumbnailLayerControls(state) {
    state.root.querySelectorAll('[data-role="record-layer"]').forEach((input) => {
        input.checked = Boolean(state.thumbnailLayerVisibility[input.dataset.layer]);
    });
}

export function buildGalleryHtml(headingId) {
    return `
        <div class="mcore-pg-gallery" data-overlay="gallery">
            <aside class="mcore-pg-gallery-sidebar">
                <div class="mcore-pg-sidebar-card">
                    <div class="mcore-pg-preview-wrap">
                        <canvas class="mcore-pg-gallery-selected-preview" data-role="preview" width="320" height="220" aria-label="Selected record preview"></canvas>
                        <button class="mcore-pg-button mcore-pg-preview-expand" data-action="expand-preview" type="button" aria-label="Expand preview" aria-expanded="false" title="Expand preview">⤢</button>
                    </div>
                    <div class="mcore-pg-layer-controls" data-role="layer-controls" role="group" aria-label="Preview layers"></div>
                    <div class="mcore-pg-record-actions" role="group" aria-label="Preview and record actions">
                        <div class="mcore-pg-action-section" role="group" aria-label="Selected saved record">
                            <div class="mcore-pg-action-heading">Selected record</div>
                            <button class="mcore-pg-button mcore-pg-gallery-insert-btn" data-action="use-record" disabled>Use selected record</button>
                        </div>
                        <div class="mcore-pg-action-section" role="group" aria-label="Connected inputs">
                            <div class="mcore-pg-action-heading">Connected inputs</div>
                            <div class="mcore-pg-connected-input-actions" role="group" aria-label="Connected input actions">
                                <button class="mcore-pg-button mcore-pg-current-inputs" data-action="show-current-inputs" type="button">Preview inputs</button>
                                <button class="mcore-pg-button" data-action="save-current" type="button" title="Save connected inputs as a new record in the selected collection">Save as record</button>
                            </div>
                        </div>
                    </div>
                    <div class="mcore-pg-gallery-details">
                        <div class="mcore-pg-gallery-details-empty" data-role="details-empty">Select a record to inspect its image, pose, masks, and tags.</div>
                        <div class="mcore-pg-gallery-details-content" data-role="details" hidden>
                            <div class="mcore-pg-details-kicker">Record details</div>
                            <div class="mcore-pg-gallery-details-name" data-detail="name"></div>
                            <div class="mcore-pg-gallery-details-row"><span>Collection</span><strong data-detail="collection"></strong></div>
                            <div class="mcore-pg-gallery-details-row"><span>Saved</span><strong data-detail="created"></strong></div>
                            <div class="mcore-pg-gallery-details-row"><span>Size</span><strong data-detail="resolution"></strong></div>
                            <div class="mcore-pg-gallery-details-row"><span>Masks</span><strong data-detail="masks"></strong></div>
                            <div class="mcore-pg-gallery-details-row"><span>General tags</span><strong class="mcore-pg-details-tags" data-detail="general-tags"></strong></div>
                            <div data-role="person-tags-row" hidden></div>
                            <div class="mcore-pg-person-tags-warning" data-role="person-tags-warning" role="status" hidden>Person-tag slots do not match the number of people in pose JSON.</div>
                        </div>
                    </div>
                </div>
            </aside>
            <main class="mcore-pg-gallery-main">
                <div class="mcore-pg-gallery-card">
                    <div class="mcore-pg-gallery-wrapper">
                        <div class="mcore-pg-gallery-header">
                            <div class="mcore-pg-heading-row">
                                <div class="mcore-pg-heading-copy">
                                    <div class="mcore-pg-eyebrow">Min-Core · Library</div>
                                    <h1 class="mcore-pg-heading" id="${headingId}">Pose Gallery</h1>
                                    <p class="mcore-pg-subtitle">Browse saved image, pose, mask, and tag records.</p>
                                </div>
                                <div class="mcore-pg-heading-actions">
                                    <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-settings-button" data-action="settings" type="button" aria-haspopup="dialog" aria-expanded="false">Settings</button>
                                    <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-close" data-action="close" type="button" title="Close gallery">Close</button>
                                </div>
                            </div>
                            <div class="mcore-pg-toolbar">
                                <div class="mcore-pg-toolbar-primary-row">
                                    <div class="mcore-pg-toolbar-group mcore-pg-library-tools" role="group" aria-label="Collection">
                                        <span class="mcore-pg-toolbar-group-label">Collection</span>
                                        <div class="mcore-pg-toolbar-controls mcore-pg-library-controls">
                                            <select class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-collection" data-role="collection" aria-label="Collection"></select>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl" data-action="new-collection" type="button">New collection</button>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-delete-collection" data-action="delete-collection" type="button" disabled>Delete collection</button>
                                        </div>
                                    </div>
                                    <div class="mcore-pg-toolbar-group mcore-pg-browse-tools" role="group" aria-label="Browse records">
                                        <span class="mcore-pg-toolbar-group-label">Browse</span>
                                        <div class="mcore-pg-toolbar-controls mcore-pg-browse-controls">
                                            <div class="mcore-pg-gallery-search mcore-pg-search">
                                                <input class="mcore-pg-gallery-search-input mcore-pg-gallery-header-ctrl" data-role="search" type="search" placeholder="Search records and tags" aria-label="Search records and tags" autocomplete="off" spellcheck="false">
                                            </div>
                                            <span class="mcore-pg-gallery-stats-badge mcore-pg-gallery-header-ctrl" data-role="stats">0 records</span>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-view" data-action="view-mode" type="button">View: medium</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="mcore-pg-toolbar-secondary-row">
                                    <div class="mcore-pg-toolbar-group mcore-pg-selected-record-tools" role="group" aria-label="Record selection and actions">
                                        <span class="mcore-pg-toolbar-group-label">Manage records</span>
                                        <div class="mcore-pg-toolbar-controls mcore-pg-record-controls">
                                            <span class="mcore-pg-selection-count" data-role="selection-count" aria-live="polite" hidden></span>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl" data-action="select-page" type="button" title="Select or deselect records on the current page" disabled>Select page</button>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl" data-action="clear-selection" type="button" hidden>Clear selection</button>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl" data-action="move-record" type="button" disabled>Move to collection</button>
                                            <button class="mcore-pg-button mcore-pg-button-small mcore-pg-gallery-header-ctrl mcore-pg-delete-record" data-action="delete-record" type="button" disabled>Delete record</button>
                                        </div>
                                    </div>
                                    <div class="mcore-pg-toolbar-group mcore-pg-record-layer-tools" role="group" aria-label="Layers shown on record cards">
                                        <span class="mcore-pg-toolbar-group-label">Card layers</span>
                                        <div class="mcore-pg-toolbar-controls mcore-pg-record-layer-controls">
                                            <label class="mcore-pg-layer-option"><input data-role="record-layer" data-layer="image" type="checkbox"><span>Image</span></label>
                                            <label class="mcore-pg-layer-option"><input data-role="record-layer" data-layer="pose" type="checkbox"><span>Pose</span></label>
                                            <label class="mcore-pg-layer-option"><input data-role="record-layer" data-layer="masks" type="checkbox"><span>Masks</span></label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="mcore-pg-gallery-content gallery-view--medium" data-role="records"></div>
                    </div>
                </div>
            </main>
            <div class="mcore-pg-preview-lightbox" data-role="preview-lightbox" role="dialog" aria-modal="true" aria-label="Expanded preview" hidden>
                <button class="mcore-pg-button mcore-pg-preview-lightbox-close" data-action="close-preview" type="button" aria-label="Close preview" title="Close preview">×</button>
                <canvas class="mcore-pg-expanded-preview" data-role="expanded-preview" aria-label="Expanded selected record preview"></canvas>
                <div class="mcore-pg-layer-controls mcore-pg-expanded-layer-controls" data-role="expanded-layer-controls" role="group" aria-label="Preview layers"></div>
            </div>
            <div class="mcore-pg-settings-dialog" data-role="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="${headingId}-settings-title" hidden>
                <section class="mcore-pg-settings-panel">
                    <header class="mcore-pg-settings-header">
                        <h2 id="${headingId}-settings-title">Pose Gallery settings</h2>
                        <button class="mcore-pg-button" data-action="close-settings" type="button" aria-label="Close settings">×</button>
                    </header>
                    <div class="mcore-pg-settings-sections">
                        <section class="mcore-pg-settings-section" data-settings-section="preview" aria-labelledby="${headingId}-preview-section-title">
                            <h3 class="mcore-pg-settings-section-title" id="${headingId}-preview-section-title">Preview</h3>
                            <label class="mcore-pg-settings-label" for="${headingId}-line-width">OpenPose line thickness</label>
                            <div class="mcore-pg-preview-line-width-control">
                                <span>${PREVIEW_LINE_WIDTH_MIN.toFixed(1)}×</span>
                                <input id="${headingId}-line-width" data-role="preview-line-width" type="range" min="${Math.round(PREVIEW_LINE_WIDTH_MIN * 100)}" max="${Math.round(PREVIEW_LINE_WIDTH_MAX * 100)}" step="${Math.round(PREVIEW_LINE_WIDTH_STEP * 100)}" value="100" aria-describedby="${headingId}-line-width-help">
                                <span>${PREVIEW_LINE_WIDTH_MAX.toFixed(1)}×</span>
                                <output data-role="preview-line-width-value" for="${headingId}-line-width">1.0×</output>
                            </div>
                            <p class="mcore-pg-settings-help" id="${headingId}-line-width-help">1.0× uses the original line thickness. This setting affects only the gallery preview, not the OPENPOSE output.</p>
                            <div class="mcore-pg-settings-section-footer">
                                <button class="mcore-pg-button" data-action="reset-preview-settings" type="button">Reset preview settings</button>
                            </div>
                        </section>
                    </div>
                    <footer class="mcore-pg-settings-footer">
                        <button class="mcore-pg-button" data-action="close-settings" type="button">Done</button>
                    </footer>
                </section>
            </div>
            <div class="mcore-pg-confirm-dialog" data-role="delete-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="${headingId}-delete-title" aria-describedby="${headingId}-delete-copy" hidden>
                <section class="mcore-pg-confirm-panel">
                    <div class="mcore-pg-eyebrow">Permanent action</div>
                    <h2 class="mcore-pg-confirm-title" id="${headingId}-delete-title" data-role="delete-title">Delete record?</h2>
                    <p class="mcore-pg-confirm-copy" id="${headingId}-delete-copy">Permanently delete <strong data-role="delete-record-name"></strong>? This cannot be undone.</p>
                    <footer class="mcore-pg-confirm-actions">
                        <button class="mcore-pg-button" data-action="cancel-delete" type="button">Cancel</button>
                        <button class="mcore-pg-button mcore-pg-delete-confirm-button" data-action="confirm-delete" type="button">Delete record</button>
                    </footer>
                </section>
            </div>
            <div class="mcore-pg-confirm-dialog" data-role="move-dialog" role="dialog" aria-modal="true" aria-labelledby="${headingId}-move-title" aria-describedby="${headingId}-move-help" hidden>
                <section class="mcore-pg-confirm-panel">
                    <div class="mcore-pg-eyebrow">Pose Gallery</div>
                    <h2 class="mcore-pg-confirm-title" id="${headingId}-move-title" data-role="move-title">Move record</h2>
                    <p class="mcore-pg-confirm-copy" id="${headingId}-move-help" data-role="move-description"></p>
                    <label class="mcore-pg-save-label" for="${headingId}-move-collection">Destination collection</label>
                    <select class="mcore-pg-save-input" id="${headingId}-move-collection" data-role="move-collection"></select>
                    <footer class="mcore-pg-confirm-actions">
                        <button class="mcore-pg-button" data-action="cancel-move" type="button">Cancel</button>
                        <button class="mcore-pg-button mcore-pg-save-submit" data-action="confirm-move" type="button">Move record</button>
                    </footer>
                </section>
            </div>
            <div class="mcore-pg-confirm-dialog" data-role="delete-collection-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="${headingId}-delete-collection-title" aria-describedby="${headingId}-delete-collection-copy" hidden>
                <section class="mcore-pg-confirm-panel">
                    <div class="mcore-pg-eyebrow">Permanent action</div>
                    <h2 class="mcore-pg-confirm-title" id="${headingId}-delete-collection-title">Delete collection?</h2>
                    <p class="mcore-pg-confirm-copy" id="${headingId}-delete-collection-copy">Permanently delete <strong data-role="delete-collection-name"></strong> and <strong data-role="delete-collection-count"></strong>? This cannot be undone.</p>
                    <footer class="mcore-pg-confirm-actions">
                        <button class="mcore-pg-button" data-action="cancel-delete-collection" type="button">Cancel</button>
                        <button class="mcore-pg-button mcore-pg-delete-confirm-button" data-action="confirm-delete-collection" type="button">Delete collection</button>
                    </footer>
                </section>
            </div>
            <div class="mcore-pg-confirm-dialog" data-role="save-dialog" role="dialog" aria-modal="true" aria-labelledby="${headingId}-save-title" aria-describedby="${headingId}-save-help" hidden>
                <section class="mcore-pg-confirm-panel">
                    <div class="mcore-pg-eyebrow">Pose Gallery</div>
                    <h2 class="mcore-pg-confirm-title" id="${headingId}-save-title">Save current inputs</h2>
                    <form class="mcore-pg-save-form" data-role="save-form">
                        <label class="mcore-pg-save-label" for="${headingId}-save-name">Record name</label>
                        <input class="mcore-pg-save-input" id="${headingId}-save-name" data-role="save-name" type="text" maxlength="120" placeholder="Leave blank for an automatic name" autocomplete="off">
                        <p class="mcore-pg-save-help" id="${headingId}-save-help">A name will be generated automatically if this field is left blank.</p>
                        <footer class="mcore-pg-confirm-actions">
                            <button class="mcore-pg-button" data-action="cancel-save" type="button">Cancel</button>
                            <button class="mcore-pg-button mcore-pg-save-submit" type="submit">Save record</button>
                        </footer>
                    </form>
                </section>
            </div>
            <div class="mcore-pg-confirm-dialog" data-role="new-collection-dialog" role="dialog" aria-modal="true" aria-labelledby="${headingId}-collection-title" aria-describedby="${headingId}-collection-help" hidden>
                <section class="mcore-pg-confirm-panel">
                    <div class="mcore-pg-eyebrow">Pose Gallery</div>
                    <h2 class="mcore-pg-confirm-title" id="${headingId}-collection-title">New collection</h2>
                    <form data-role="new-collection-form">
                        <label class="mcore-pg-save-label" for="${headingId}-collection-name">Collection name</label>
                        <input class="mcore-pg-save-input" id="${headingId}-collection-name" data-role="new-collection-name" type="text" maxlength="100" placeholder="Enter a name" autocomplete="off" aria-required="true">
                        <p class="mcore-pg-save-help" id="${headingId}-collection-help">The new collection will be selected automatically.</p>
                        <footer class="mcore-pg-confirm-actions">
                            <button class="mcore-pg-button" data-action="cancel-new-collection" type="button">Cancel</button>
                            <button class="mcore-pg-button mcore-pg-save-submit" type="submit">Create collection</button>
                        </footer>
                    </form>
                </section>
            </div>
        </div>
    `;
}

export function getStoredViewMode() {
    try {
        const mode = localStorage.getItem(GALLERY_VIEW_MODE_KEY);
        return GALLERY_VIEW_MODES.includes(mode) ? mode : "medium";
    } catch (_error) {
        return "medium";
    }
}

export function setGalleryViewMode(state, mode) {
    state.viewMode = GALLERY_VIEW_MODES.includes(mode) ? mode : "medium";
    try {
        localStorage.setItem(GALLERY_VIEW_MODE_KEY, state.viewMode);
    } catch (_error) {
        // The selected layout still works if browser storage is unavailable.
    }
    const content = state.root.querySelector('[data-role="records"]');
    for (const view of GALLERY_VIEW_MODES) content.classList.toggle(`gallery-view--${view}`, view === state.viewMode);
    const button = state.root.querySelector('[data-action="view-mode"]');
    if (button) button.textContent = `View: ${state.viewMode}`;
}

export function createThumbnailObserver(state) {
    if (typeof IntersectionObserver === "undefined") return null;
    return new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            drawRecordThumbnail(
                entry.target,
                {
                    id: entry.target.dataset.recordId,
                    has_image: entry.target.dataset.hasImage !== "false",
                    mask_count: Number(entry.target.dataset.maskCount) || 0,
                },
                state.thumbnailLayerVisibility,
                state.thumbnailImageCache,
            );
        }
    }, {
        root: state.root.querySelector('[data-role="records"]'),
        rootMargin: "240px",
    });
}

function normalizeSearch(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
}

function recordSearchText(record) {
    if (!RECORD_SEARCH_TEXT.has(record)) {
        RECORD_SEARCH_TEXT.set(record, normalizeSearch(
            `${record.name} ${record.general_tags} ${(record.person_tags || []).join(" ")}`,
        ));
    }
    return RECORD_SEARCH_TEXT.get(record);
}

function addStatusState(carousel, { titleText, copyText, role = "status", retry }) {
    const state = document.createElement("div");
    state.className = "mcore-pg-empty-state mcore-pg-status-state";
    state.setAttribute("role", role);
    const title = document.createElement("h2");
    title.className = "mcore-pg-empty-title";
    title.textContent = titleText;
    const copy = document.createElement("p");
    copy.className = "mcore-pg-empty-copy";
    copy.textContent = copyText;
    state.append(title, copy);
    if (retry) {
        const button = document.createElement("button");
        button.className = "mcore-pg-button mcore-pg-node-button mcore-pg-state-retry";
        button.type = "button";
        button.textContent = "Try again";
        button.addEventListener("click", retry);
        state.appendChild(button);
    }
    carousel.appendChild(state);
}

export function renderRecords(state, { onSelect, onRetry, onPageChange, onSelectionChange }) {
    const container = state.root.querySelector('[data-role="records"]');
    state.thumbnailObserver?.disconnect();
    container.replaceChildren();
    container.setAttribute("aria-busy", String(state.recordsStatus === "loading"));
    const query = normalizeSearch(state.root.querySelector('[data-role="search"]').value);
    const records = state.records.filter((record) => !query || recordSearchText(record).includes(query));
    const pageCount = Math.max(1, Math.ceil(records.length / RECORDS_PER_PAGE));
    state.recordsPage = Math.max(0, Math.min(state.recordsPage || 0, pageCount - 1));
    const pageRecords = records.slice(
        state.recordsPage * RECORDS_PER_PAGE,
        (state.recordsPage + 1) * RECORDS_PER_PAGE,
    );

    const collection = state.collections.find((item) => item.id === state.selectedCollection);
    const section = document.createElement("section");
    section.className = "mcore-pg-gallery-section";
    const heading = document.createElement("div");
    heading.className = "mcore-pg-gallery-title";
    const headingText = document.createElement("span");
    headingText.className = "mcore-pg-gallery-title-text";
    headingText.textContent = collection?.name || "Default";
    heading.appendChild(headingText);
    const badge = document.createElement("span");
    badge.className = "mcore-pg-record-count";
    badge.textContent = `${records.length} record${records.length === 1 ? "" : "s"}`;
    heading.appendChild(badge);
    section.appendChild(heading);

    const carousel = document.createElement("div");
    carousel.className = "mcore-pg-gallery-carousel";
    const thumbnails = [];
    if (state.recordsStatus === "loading") {
        addStatusState(carousel, { titleText: "Loading records…", copyText: "Please wait while this collection is loaded." });
    } else if (state.recordsError) {
        addStatusState(carousel, {
            titleText: "Could not load records",
            copyText: state.recordsError,
            role: "alert",
            retry: onRetry,
        });
    } else {
        for (const record of pageRecords) {
            const item = document.createElement("div");
            item.className = "mcore-pg-gallery-item";
            item.setAttribute("role", "group");
            item.setAttribute("aria-label", record.name || "Untitled record");
            item.dataset.recordId = record.id;
            const isSelected = state.selectedRecord?.id === record.id;
            const isBulkSelected = state.selectedRecordIds.has(String(record.id));
            item.classList.toggle("is-selected", isSelected);
            item.classList.toggle("is-bulk-selected", isBulkSelected);

            const selectInput = document.createElement("input");
            selectInput.className = "mcore-pg-record-select";
            selectInput.type = "checkbox";
            selectInput.dataset.role = "record-select";
            selectInput.dataset.recordId = record.id;
            selectInput.checked = isBulkSelected;
            selectInput.setAttribute("aria-label", `Select ${record.name || "Untitled record"}`);
            selectInput.addEventListener("change", () => {
                if (selectInput.checked) state.selectedRecordIds.add(String(record.id));
                else state.selectedRecordIds.delete(String(record.id));
                item.classList.toggle("is-bulk-selected", selectInput.checked);
                onSelectionChange?.();
            });

            const previewButton = document.createElement("div");
            previewButton.className = "mcore-pg-gallery-item-preview";
            previewButton.tabIndex = 0;
            previewButton.setAttribute("role", "button");
            previewButton.setAttribute("aria-label", record.name || "Untitled record");
            previewButton.setAttribute("aria-pressed", String(isSelected));

            const canvas = document.createElement("canvas");
            canvas.width = 360;
            canvas.height = 270;
            canvas.dataset.recordId = record.id;
            canvas.dataset.hasImage = String(record.has_image !== false);
            canvas.dataset.maskCount = String(Number(record.mask_count) || 0);
            canvas.setAttribute("aria-hidden", "true");

            const imageFrame = document.createElement("div");
            imageFrame.className = "mcore-pg-card-image";
            imageFrame.appendChild(canvas);
            thumbnails.push(canvas);

            const maskCount = Number(record.mask_count) || 0;
            if (maskCount > 0) {
                const maskBadge = document.createElement("span");
                maskBadge.className = "mcore-pg-mask-badge";
                maskBadge.textContent = `${maskCount} mask${maskCount === 1 ? "" : "s"}`;
                maskBadge.title = maskBadge.textContent;
                imageFrame.appendChild(maskBadge);
            }

            const title = document.createElement("div");
            title.className = "mcore-pg-gallery-item-title";
            title.textContent = record.name || "Untitled record";
            title.title = title.textContent;

            const meta = document.createElement("div");
            meta.className = "mcore-pg-gallery-item-meta";
            const metaName = document.createElement("div");
            metaName.className = "mcore-pg-gallery-item-meta-name";
            metaName.textContent = title.textContent;
            const metaDate = document.createElement("div");
            metaDate.className = "mcore-pg-gallery-item-meta-size";
            metaDate.textContent = record.created ? new Date(record.created).toLocaleString() : "";
            const metaMasks = document.createElement("div");
            metaMasks.className = "mcore-pg-gallery-item-meta-people";
            metaMasks.textContent = `${maskCount} mask${maskCount === 1 ? "" : "s"}`;
            const metaTags = document.createElement("div");
            metaTags.className = "mcore-pg-gallery-item-meta-kp";
            metaTags.textContent = record.general_tags || (record.person_tags || []).filter(Boolean).join(", ") || "No tags";
            meta.append(metaName, metaDate, metaMasks, metaTags);
            previewButton.append(imageFrame, title, meta);
            item.append(selectInput, previewButton);

            previewButton.addEventListener("click", () => onSelect(record.id));
            previewButton.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelect(record.id);
            });
            carousel.appendChild(item);
        }

        if (!records.length) {
            const empty = document.createElement("div");
            empty.className = "mcore-pg-empty-state";
            empty.setAttribute("role", "status");
            const icon = document.createElement("span");
            icon.className = "mcore-pg-empty-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = state.records.length ? "⌕" : "+";
            const title = document.createElement("h2");
            title.className = "mcore-pg-empty-title";
            title.textContent = state.records.length ? "No matching records" : "This collection is empty";
            const body = document.createElement("p");
            body.className = "mcore-pg-empty-copy";
            body.textContent = state.records.length
                ? "Try another search term or clear your search to see all saved records."
                : "Save the current inputs to add the first record to this collection.";
            empty.append(icon, title, body);
            carousel.appendChild(empty);
        }
    }

    section.appendChild(carousel);
    if (state.recordsStatus === "ready" && !state.recordsError && records.length > RECORDS_PER_PAGE) {
        const firstRecord = state.recordsPage * RECORDS_PER_PAGE + 1;
        const lastRecord = Math.min(firstRecord + pageRecords.length - 1, records.length);
        const pagination = document.createElement("nav");
        pagination.className = "mcore-pg-pagination";
        pagination.setAttribute("aria-label", "Gallery pages");
        const previous = document.createElement("button");
        previous.className = "mcore-pg-button mcore-pg-page-button";
        previous.type = "button";
        previous.dataset.action = "previous-page";
        previous.textContent = "Previous";
        previous.disabled = state.recordsPage === 0;
        previous.addEventListener("click", () => onPageChange?.(state.recordsPage - 1, "previous-page"));
        const status = document.createElement("span");
        status.className = "mcore-pg-page-status";
        status.setAttribute("aria-live", "polite");
        status.textContent = `Showing ${firstRecord}–${lastRecord} of ${records.length} · Page ${state.recordsPage + 1} of ${pageCount}`;
        const next = document.createElement("button");
        next.className = "mcore-pg-button mcore-pg-page-button";
        next.type = "button";
        next.dataset.action = "next-page";
        next.textContent = "Next";
        next.disabled = state.recordsPage >= pageCount - 1;
        next.addEventListener("click", () => onPageChange?.(state.recordsPage + 1, "next-page"));
        pagination.append(previous, status, next);
        section.appendChild(pagination);
    }
    container.appendChild(section);
    setGalleryViewMode(state, state.viewMode);
    if (state.recordsStatus === "loading") {
        state.root.querySelector('[data-role="stats"]').textContent = "Loading…";
    } else if (state.recordsError) {
        state.root.querySelector('[data-role="stats"]').textContent = "Unavailable";
    } else {
        const masks = records.reduce((count, record) => count + (Number(record.mask_count) || 0), 0);
        state.root.querySelector('[data-role="stats"]').textContent = `${records.length} record${records.length === 1 ? "" : "s"} · ${masks} mask${masks === 1 ? "" : "s"}`;
    }

    if (state.thumbnailObserver) {
        thumbnails.forEach((canvas) => state.thumbnailObserver.observe(canvas));
    } else {
        thumbnails.forEach((canvas) => drawRecordThumbnail(
            canvas,
            {
                id: canvas.dataset.recordId,
                has_image: canvas.dataset.hasImage !== "false",
                mask_count: Number(canvas.dataset.maskCount) || 0,
            },
            state.thumbnailLayerVisibility,
            state.thumbnailImageCache,
        ));
    }
}
