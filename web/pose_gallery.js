import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { setupGalleryOverlayStyles } from "./openpose_studio/modules/gallery.js";

const NODE_TYPE = "MinCore_PoseGallery";
const STYLE_ID = "mincore-pose-gallery-style";
const SHELL_STYLESHEET_ID = "mincore-pose-gallery-shell-stylesheet";
const GALLERY_VIEW_MODES = ["medium", "large", "tiles"];
const GALLERY_VIEW_MODE_KEY = "openpose_editor.gallery.viewMode";
const MASK_COLORS = [
    [255, 80, 80], [70, 170, 255], [100, 230, 120],
    [255, 190, 60], [210, 100, 255], [50, 220, 210],
];

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
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .mcore-pg-gallery.openpose-gallery-overlay{position:relative;display:flex;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box}
        .mcore-pg-gallery .openpose-gallery-sidebar{--ope-openpose-sidebar-width:300px;--ope-openpose-sidebar-min-width:230px}
        .mcore-pg-gallery .openpose-gallery-main{display:flex;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden}
        .mcore-pg-gallery .openpose-gallery-card{display:flex;min-width:0;min-height:0}
        .mcore-pg-gallery .openpose-gallery-wrapper{min-width:0;min-height:0}
        .mcore-pg-gallery .openpose-sidebar-card{width:100%;height:100%;min-height:0;box-sizing:border-box}
        .mcore-pg-gallery .openpose-gallery-details{flex:1 1 auto}
        .mcore-pg-preview-wrap{position:relative;flex:0 0 auto;width:100%;overflow:hidden}
        .mcore-pg-preview-wrap .openpose-gallery-selected-preview{width:100%;height:220px;object-fit:contain}
        .mcore-pg-layer-controls{display:flex;flex-wrap:wrap;gap:5px;max-height:96px;overflow-y:auto}
        .mcore-pg-layer-option{display:inline-flex;align-items:center;gap:5px;padding:4px 6px;border:1px solid var(--openpose-border);border-radius:4px;color:var(--openpose-text-muted);font:11px Arial,sans-serif;cursor:pointer}
        .mcore-pg-layer-option input{margin:0;accent-color:var(--openpose-primary-bg)}
        .mcore-pg-details-tags{white-space:pre-wrap;overflow-wrap:anywhere;text-align:right}
        .mcore-pg-main-actions{flex-wrap:wrap}
        .mcore-pg-collection{max-width:150px}
        .mcore-pg-record-count{font-size:10px;font-weight:600;padding:3px 8px;border-radius:3px;background:var(--openpose-input-bg);border:1px solid var(--openpose-border);color:var(--openpose-text-muted);white-space:nowrap}
        .mcore-pg-node-button{width:100%;padding:8px 12px;border:1px solid var(--openpose-border);border-radius:4px;background:var(--openpose-btn-bg);color:var(--openpose-text);font:13px Arial,sans-serif;cursor:pointer}
        .mcore-pg-node-button:hover{background:var(--openpose-btn-hover-bg)}
        .mcore-pg-gallery .openpose-gallery-content{padding:0 2px 8px}
        .mcore-pg-gallery .openpose-gallery-item.is-selected{background:var(--openpose-gallery-selection-bg)!important;outline:2px solid var(--openpose-primary-bg);outline-offset:-2px}
        .mcore-pg-gallery .openpose-gallery-item canvas{object-fit:contain}
        .mcore-pg-empty{grid-column:1/-1;padding:24px 16px;color:var(--openpose-text-muted);font:12px Arial,sans-serif;text-align:center}
        @media(max-width:900px){.mcore-pg-gallery .openpose-gallery-sidebar{--ope-openpose-sidebar-width:250px;--ope-openpose-sidebar-min-width:200px}.mcore-pg-main-actions{gap:4px!important}.mcore-pg-collection{max-width:110px}}
        @media(max-width:680px){.mcore-pg-gallery.openpose-gallery-overlay{flex-direction:column;overflow:auto}.mcore-pg-gallery .openpose-gallery-sidebar{width:100%;height:auto;max-height:46%;padding:8px 10px}.mcore-pg-gallery .openpose-sidebar-card{display:grid;grid-template-columns:minmax(120px,35%) minmax(0,1fr);gap:8px}.mcore-pg-preview-wrap{grid-row:span 2}.mcore-pg-preview-wrap .openpose-gallery-selected-preview{height:150px}.mcore-pg-gallery .openpose-gallery-details{margin:0;padding:0;border:0}.mcore-pg-gallery .openpose-gallery-main{padding:6px!important}.mcore-pg-gallery .openpose-gallery-note-row{flex-direction:column}.mcore-pg-gallery .openpose-gallery-actions{margin-left:0;flex-wrap:wrap}.mcore-pg-gallery .openpose-gallery-search{order:10;width:100%}}
    `;
    document.head.appendChild(style);
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

function fileItemUrl(item) {
    if (!item?.filename) return "";
    const query = new URLSearchParams({
        filename: item.filename,
        type: item.type || "temp",
        subfolder: item.subfolder || "",
        t: String(Date.now()),
    });
    return api.apiURL(`/view?${query}`);
}

async function jsonRequest(path, options = {}) {
    const response = await api.fetchApi(path, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}

function toast(severity, summary, detail = "") {
    app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 5000 });
}

async function queueNode(node) {
    if (node?.id == null || node.id < 0) return;
    try {
        await app.queuePrompt(0, 1, [String(node.id)]);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

function buildGalleryHtml() {
    return `
        <div class="openpose-overlay openpose-gallery-overlay mcore-pg-gallery" data-overlay="gallery">
            <aside class="openpose-sidebar openpose-gallery-sidebar">
                <div class="openpose-sidebar-card">
                    <div class="openpose-preset-preview-frame mcore-pg-preview-wrap">
                        <canvas class="openpose-preset-preview openpose-gallery-selected-preview" data-role="preview" width="320" height="220" aria-label="Selected record preview"></canvas>
                    </div>
                    <div class="mcore-pg-layer-controls" data-role="layer-controls"></div>
                    <button class="openpose-btn openpose-apply-btn openpose-gallery-insert-btn" data-action="use-record" disabled>Use selected record for outputs</button>
                    <div class="openpose-gallery-details">
                        <div class="openpose-gallery-details-empty" data-role="details-empty">Select a record to inspect its image, pose, masks, and tags.</div>
                        <div class="openpose-gallery-details-content" data-role="details" hidden>
                            <div class="openpose-gallery-details-name" data-detail="name"></div>
                            <div class="openpose-gallery-details-row"><span>Collection</span><strong data-detail="collection"></strong></div>
                            <div class="openpose-gallery-details-row"><span>Saved</span><strong data-detail="created"></strong></div>
                            <div class="openpose-gallery-details-row"><span>Masks</span><strong data-detail="masks"></strong></div>
                            <div class="openpose-gallery-details-row"><span>General tags</span><strong class="mcore-pg-details-tags" data-detail="general-tags"></strong></div>
                            <div class="openpose-gallery-details-row" data-role="person-tags-row"><span>Person tags</span><strong class="mcore-pg-details-tags" data-detail="person-tags"></strong></div>
                        </div>
                    </div>
                </div>
            </aside>
            <main class="openpose-gallery-main">
                <div class="openpose-overlay-card openpose-gallery-card">
                    <div class="openpose-overlay-content openpose-gallery-wrapper">
                        <div class="openpose-gallery-header">
                            <div class="openpose-gallery-note-row">
                                <div class="openpose-gallery-note">Browse saved image, pose, mask, and tag records</div>
                                <div class="openpose-gallery-actions mcore-pg-main-actions">
                                    <select class="openpose-btn openpose-btn-small openpose-gallery-header-ctrl openpose-gallery-collection mcore-pg-collection" data-role="collection" aria-label="Collection"></select>
                                    <button class="openpose-btn openpose-btn-small openpose-gallery-header-ctrl" data-action="new-collection" type="button">New collection</button>
                                    <button class="openpose-btn openpose-btn-small openpose-gallery-header-ctrl" data-action="save-current" type="button">Save current inputs</button>
                                    <div class="openpose-gallery-search">
                                        <input class="openpose-gallery-search-input openpose-gallery-header-ctrl" data-role="search" type="search" placeholder="Search records and tags" aria-label="Search records and tags" autocomplete="off" spellcheck="false">
                                    </div>
                                    <span class="openpose-gallery-stats-badge openpose-gallery-header-ctrl" data-role="stats">0 records</span>
                                    <button class="openpose-btn openpose-btn-small openpose-gallery-header-ctrl" data-action="view-mode" type="button">View: medium</button>
                                    <button class="openpose-btn openpose-btn-small openpose-gallery-header-ctrl" data-action="close" type="button" title="Close gallery">Close</button>
                                </div>
                            </div>
                        </div>
                        <div class="openpose-gallery-content gallery-view--medium" data-role="records"></div>
                    </div>
                </div>
            </main>
        </div>
    `;
}

function displayUrl(urlOrItem) {
    return typeof urlOrItem === "string" ? api.apiURL(urlOrItem) : fileItemUrl(urlOrItem);
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

function getStoredViewMode() {
    try {
        const mode = localStorage.getItem(GALLERY_VIEW_MODE_KEY);
        return GALLERY_VIEW_MODES.includes(mode) ? mode : "medium";
    } catch (_error) {
        return "medium";
    }
}

function setGalleryViewMode(state, mode) {
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

function openGallery(node) {
    if (node._poseGalleryPanel) {
        node._poseGalleryPanel.panel.focus?.();
        return;
    }
    installStyles();
    const graphCanvas = LiteGraph.LGraphCanvas.active_canvas;
    if (!graphCanvas) return;

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
    panel.style.opacity = "0";
    panel.style.pointerEvents = "none";
    panel.style.transition = "opacity 150ms cubic-bezier(0,0,.2,1), transform 150ms cubic-bezier(0,0,.2,1)";
    const header = panel.header || panel.querySelector(".dialog-header");
    header?.classList.add("ope-openpose-native-header");
    const closeButton = header?.querySelector(".close");
    closeButton?.classList.add("ope-openpose-native-close");
    const footer = panel.footer || panel.querySelector(".dialog-footer");
    footer?.classList.add("ope-openpose-native-footer");
    const root = panel.addHTML(buildGalleryHtml(), "openpose-container");
    root.classList.add("ope-openpose-modal");
    root.style.setProperty("--ope-openpose-sidebar-width", "300px");
    root.style.setProperty("--ope-openpose-sidebar-min-width", "230px");
    root.style.display = "flex";
    root.style.flex = "1 1 auto";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.minWidth = "0";
    root.style.minHeight = "0";
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
        selectedRecord: null,
        selectedCollection: String(readWidget(node, "gallery_collection_id", "default")),
        viewMode: getStoredViewMode(),
        previewImages: [],
        previewLayers: [],
        resizeHandler: null,
        keydownHandler: null,
        closing: false,
    };
    node._poseGalleryPanel = state;
    setGalleryViewMode(state, state.viewMode);

    const originalClose = panel.close.bind(panel);
    let closeTimer = null;
    let closeTransitionHandler = null;
    const cleanup = () => {
        window.removeEventListener("resize", state.resizeHandler);
        window.removeEventListener("keydown", state.keydownHandler);
        backdrop.remove();
        state.previewImages.forEach((image) => { image.onload = null; image.onerror = null; });
        if (node._poseGalleryPanel === state) node._poseGalleryPanel = null;
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
        setupGalleryOverlayStyles(root);
        renderRecords(state);
    });
    root.querySelector('[data-role="collection"]').addEventListener("change", (event) => {
        state.selectedCollection = event.target.value;
        state.selectedRecord = null;
        setWidget(node, "gallery_collection_id", state.selectedCollection);
        if (node._poseGalleryState) showCurrentState(state, node._poseGalleryState);
        else updateRecordDetails(state, null);
        loadRecords(state);
    });
    root.querySelector('[data-role="search"]').addEventListener("input", () => renderRecords(state));
    state.resizeHandler = () => {
        applyPanelLayout(panel);
        resizePreviewCanvas(state);
    };
    state.keydownHandler = (event) => {
        if (event.key === "Escape" && !state.closing) panel.close();
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
        resizePreviewCanvas(state);
    });
    refreshCollections(state).then(() => {
        if (node._poseGalleryState) showNodeState(state, node._poseGalleryState);
    }).catch((error) => toast("error", "Pose Gallery", String(error)));
}

async function refreshCollections(state) {
    const payload = await jsonRequest("/mincore/pose_gallery/collections");
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
        state.selectedRecord = null;
        if (state.node._poseGalleryState) showCurrentState(state, state.node._poseGalleryState);
        else updateRecordDetails(state, null);
        await refreshCollections(state);
        toast("success", "Pose Gallery", `Created collection: ${collection.name}`);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

async function loadRecords(state) {
    try {
        const query = new URLSearchParams({ collection_id: state.selectedCollection });
        const payload = await jsonRequest(`/mincore/pose_gallery/records?${query}`);
        state.records = payload.records || [];
        renderRecords(state);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

function renderRecords(state) {
    const container = state.root.querySelector('[data-role="records"]');
    container.replaceChildren();
    const query = normalizeSearch(state.root.querySelector('[data-role="search"]').value);
    const records = state.records.filter((record) => (
        !query || normalizeSearch(`${record.name} ${record.general_tags} ${(record.person_tags || []).join(" ")}`).includes(query)
    ));

    const collection = state.collections.find((item) => item.id === state.selectedCollection);
    const section = document.createElement("section");
    section.className = "openpose-gallery-section";
    const heading = document.createElement("div");
    heading.className = "openpose-gallery-title";
    const headingText = document.createElement("span");
    headingText.className = "openpose-gallery-title-text";
    headingText.textContent = collection?.name || "Default";
    heading.appendChild(headingText);
    const badge = document.createElement("span");
    badge.className = "mcore-pg-record-count";
    badge.textContent = `${records.length} record${records.length === 1 ? "" : "s"}`;
    heading.appendChild(badge);
    section.appendChild(heading);

    const carousel = document.createElement("div");
    carousel.className = "openpose-gallery-carousel";
    for (const record of records) {
        const item = document.createElement("div");
        item.className = "openpose-gallery-item";
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.setAttribute("aria-label", record.name || "Untitled record");
        item.dataset.recordId = record.id;
        item.classList.toggle("is-selected", state.selectedRecord?.id === record.id);

        const canvas = document.createElement("canvas");
        canvas.width = 180;
        canvas.height = 180;
        canvas.setAttribute("aria-hidden", "true");
        drawRecordThumbnail(canvas, record.id);

        const title = document.createElement("div");
        title.className = "openpose-gallery-item-title";
        title.textContent = record.name || "Untitled record";
        title.title = title.textContent;

        const meta = document.createElement("div");
        meta.className = "openpose-gallery-item-meta";
        const metaName = document.createElement("div");
        metaName.className = "openpose-gallery-item-meta-name";
        metaName.textContent = title.textContent;
        const metaSize = document.createElement("div");
        metaSize.className = "openpose-gallery-item-meta-size";
        metaSize.textContent = record.created ? new Date(record.created).toLocaleString() : "";
        const metaMasks = document.createElement("div");
        metaMasks.className = "openpose-gallery-item-meta-people";
        metaMasks.textContent = `${record.mask_count || 0} mask${record.mask_count === 1 ? "" : "s"}`;
        const metaTags = document.createElement("div");
        metaTags.className = "openpose-gallery-item-meta-kp";
        metaTags.textContent = record.general_tags || (record.person_tags || []).filter(Boolean).join(", ") || "No tags";
        meta.append(metaName, metaSize, metaMasks, metaTags);
        item.append(canvas, title, meta);

        item.addEventListener("click", () => selectRecord(state, record.id));
        item.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectRecord(state, record.id);
        });
        carousel.appendChild(item);
    }

    if (!records.length) {
        const empty = document.createElement("div");
        empty.className = "openpose-alert openpose-alert-info alert alert-info openpose-gallery-empty";
        empty.setAttribute("role", "status");
        const body = document.createElement("div");
        body.className = "openpose-alert-body";
        body.textContent = state.records.length ? "No records match this search." : "This collection is empty. Save the current inputs to add its first record.";
        empty.appendChild(body);
        carousel.appendChild(empty);
    }

    section.appendChild(carousel);
    container.appendChild(section);
    setupGalleryOverlayStyles(state.root);
    setGalleryViewMode(state, state.viewMode);
    const masks = records.reduce((count, record) => count + (Number(record.mask_count) || 0), 0);
    state.root.querySelector('[data-role="stats"]').textContent = `${records.length} record${records.length === 1 ? "" : "s"} · ${masks} mask${masks === 1 ? "" : "s"}`;
}

function normalizeSearch(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
}

function drawRecordThumbnail(canvas, recordId) {
    const image = new Image();
    image.onload = () => {
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    };
    image.src = api.apiURL(`/mincore/pose_gallery/records/${recordId}/assets/image.png`);
}

async function selectRecord(state, recordId) {
    try {
        const record = await jsonRequest(`/mincore/pose_gallery/records/${recordId}`);
        state.selectedRecord = record;
        state.root.querySelectorAll(".openpose-gallery-item").forEach((item) => {
            item.classList.toggle("is-selected", item.dataset.recordId === recordId);
        });
        showRecord(state, record);
    } catch (error) {
        toast("error", "Pose Gallery", String(error));
    }
}

function setPreviewSource(state, preview) {
    state.previewRevision = (state.previewRevision || 0) + 1;
    const revision = state.previewRevision;
    state.previewImages.forEach((image) => { image.onload = null; image.onerror = null; });
    state.previewImages = [];
    const canvas = state.root.querySelector('[data-role="preview"]');
    const controls = state.root.querySelector('[data-role="layer-controls"]');
    controls.replaceChildren();

    const layers = [
        { name: "Image", type: "image", url: displayUrl(preview.image), visible: true },
        { name: "Pose", type: "pose", url: displayUrl(preview.pose), visible: true },
        ...(preview.masks || []).map((mask, index) => ({
            name: `Mask ${index + 1}`,
            type: "mask",
            url: displayUrl(mask),
            visible: false,
            color: MASK_COLORS[index % MASK_COLORS.length],
        })),
    ].filter((layer) => layer.url);
    state.previewLayers = layers;

    for (const layer of layers) {
        const label = document.createElement("label");
        label.className = "mcore-pg-layer-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = layer.visible;
        checkbox.addEventListener("change", () => {
            layer.visible = checkbox.checked;
            renderPreview(state);
        });
        const text = document.createElement("span");
        text.textContent = layer.name;
        label.append(checkbox, text);
        controls.appendChild(label);

        const image = new Image();
        state.previewImages.push(image);
        image.onload = () => {
            if (state.previewRevision === revision) {
                layer.image = image;
                renderPreview(state);
            }
        };
        image.onerror = () => {
            if (state.previewRevision === revision) renderPreview(state);
        };
        image.src = layer.url;
    }

    resizePreviewCanvas(state);
    renderPreview(state);
    updateRecordDetails(state, preview.record || null);
    state.root.querySelector('[data-action="use-record"]').disabled = !state.selectedRecord;
}

function resizePreviewCanvas(state) {
    const canvas = state.root.querySelector('[data-role="preview"]');
    const frame = canvas?.closest(".mcore-pg-preview-wrap");
    if (!canvas || !frame) return;
    const width = Math.max(1, Math.round(frame.clientWidth || 240));
    const height = Math.max(1, Math.round(frame.clientHeight || 220));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    renderPreview(state);
}

function containRect(canvas, image) {
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height };
}

function renderPreview(state) {
    const canvas = state.root.querySelector('[data-role="preview"]');
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const imageLayer = state.previewLayers.find((layer) => layer.type === "image" && layer.image);
    const poseLayer = state.previewLayers.find((layer) => layer.type === "pose" && layer.image);
    const reference = imageLayer?.image || poseLayer?.image || state.previewLayers.find((layer) => layer.image)?.image;
    if (!reference) return;
    const rect = containRect(canvas, reference);

    if (imageLayer?.visible) {
        context.drawImage(imageLayer.image, rect.x, rect.y, rect.width, rect.height);
    }
    if (poseLayer?.visible) {
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = 0.92;
        context.drawImage(poseLayer.image, rect.x, rect.y, rect.width, rect.height);
        context.restore();
    }
    for (const [index, layer] of state.previewLayers.entries()) {
        if (layer.type !== "mask" || !layer.visible || !layer.image) continue;
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
        if (!maskContext) continue;
        maskContext.drawImage(layer.image, rect.x, rect.y, rect.width, rect.height);
        const pixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        const color = layer.color || MASK_COLORS[index % MASK_COLORS.length];
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
            const alpha = pixels.data[pixel];
            pixels.data[pixel] = color[0];
            pixels.data[pixel + 1] = color[1];
            pixels.data[pixel + 2] = color[2];
            pixels.data[pixel + 3] = Math.round(alpha * 0.52);
        }
        maskContext.putImageData(pixels, 0, 0);
        context.drawImage(maskCanvas, 0, 0);
    }
}

function updateRecordDetails(state, record) {
    const empty = state.root.querySelector('[data-role="details-empty"]');
    const details = state.root.querySelector('[data-role="details"]');
    empty.hidden = !!record;
    details.hidden = !record;
    if (!record) {
        empty.textContent = "Showing the latest node output. Select a saved record to inspect its details.";
        return;
    }
    const setDetail = (name, value) => {
        const element = state.root.querySelector(`[data-detail="${name}"]`);
        if (element) element.textContent = value || "—";
    };
    setDetail("name", record.name || "Untitled record");
    setDetail("collection", state.collections.find((item) => item.id === record.collection_id)?.name || "—");
    setDetail("created", record.created ? new Date(record.created).toLocaleString() : "—");
    setDetail("masks", String(record.mask_count || 0));
    setDetail("general-tags", record.general_tags || "—");
    const personTags = (record.person_tags || []).map((tag, index) => `Person ${index + 1}: ${tag || "—"}`).join("\n");
    setDetail("person-tags", personTags || "—");
    state.root.querySelector('[data-role="person-tags-row"]').hidden = !personTags;
}

function showCurrentState(state, preview) {
    state.selectedRecord = null;
    state.root.querySelectorAll(".openpose-gallery-item.is-selected").forEach((item) => item.classList.remove("is-selected"));
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
    setWidget(state.node, "gallery_record_id", state.selectedRecord.id);
    setWidget(state.node, "output_source", "gallery");
    await queueNode(state.node);
    toast("success", "Pose Gallery", `Selected: ${state.selectedRecord.name}`);
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
            loadRecords(panelState).then(() => selectRecord(panelState, capture.id));
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
