import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "MinCore_MaskPainterLatch";
const _MASK_COLOR = "#1e3a1e";
const _MASK_BG_COLOR = "#0f1f0f";
const _LATCH_COLOR = "#1b3a4b";
const _LATCH_BG_COLOR = "#0f232e";

// ── Prompt link removal ───────────────────────────────────────────────────────
//
// ComfyUI's cache key includes ALL ancestor node signatures.  Even though
// lazy evaluation prevents upstream execution, a changed ancestor invalidates
// the cache key of this node, forcing it to re-execute.
//
// The fix: before the prompt is sent, remove linked inputs that the node
// doesn't need (block=True + backup on disk).  Without the link in the
// prompt, the ancestor is NOT part of the cache signature.

// Cached backup status per node_id.
const _backupStatus = {}; // nodeId -> { image: bool, mask: bool }

async function _refreshBackupStatus(nodeIds) {
    if (nodeIds.length === 0) return;
    try {
        const res = await api.fetchApi(
            `/mincore/mask_painter/backup_status?node_ids=${nodeIds.join(",")}`,
            { cache: "no-store" }
        );
        if (res.ok) {
            const data = await res.json();
            for (const [nid, status] of Object.entries(data)) {
                _backupStatus[nid] = status;
            }
        }
    } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFileItem(baseType, path) {
    try {
        let pathType = baseType;
        if (path.endsWith("[output]")) { pathType = "output"; path = path.slice(0, -9); }
        else if (path.endsWith("[input]")) { pathType = "input"; path = path.slice(0, -8); }
        else if (path.endsWith("[temp]")) { pathType = "temp"; path = path.slice(0, -7); }
        const slash = path.lastIndexOf("/");
        return {
            filename: slash >= 0 ? path.slice(slash + 1) : path,
            subfolder: slash >= 0 ? path.slice(0, slash) : "",
            type: pathType,
        };
    } catch (_) { return null; }
}

async function registerClipspacePath(nodeId, clipspacePath) {
    const item = getFileItem("temp", clipspacePath);
    if (!item) return `$${nodeId}-0`;
    const params = new URLSearchParams({
        node_id: String(nodeId),
        filename: item.filename,
        type: item.type,
        subfolder: item.subfolder,
    });
    try {
        const res = await api.fetchApi(`/mincore/mask_painter/bridge/set?${params}`, { cache: "no-store" });
        if (res.ok) return await res.text();
    } catch (_) {}
    return `$${nodeId}-0`;
}

async function loadImageFromId(image, v) {
    try {
        const res = await api.fetchApi(
            `/mincore/mask_painter/bridge/get?id=${encodeURIComponent(v)}`,
            { cache: "no-store" }
        );
        if (res.ok) {
            const item = await res.json();
            const p = new URLSearchParams({
                filename: item.filename,
                type: item.type,
                subfolder: item.subfolder ?? "",
                t: Date.now(),
            });
            image.src = api.apiURL(`/view?${p}`);
            return true;
        }
    } catch (_) {}
    return false;
}

// Queue a single node + its upstream deps.
async function _queueNode(node) {
    try {
        const p = await app.graphToPrompt();
        if (p?.output) {
            const filtered = {};
            _collectUpstream(String(node.id), p.output, filtered);
            await api.queuePrompt(0, { output: filtered, workflow: p.workflow });
        }
    } catch (err) {
        console.error("Mask Painter Latch queue error:", err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Queue Failed",
            detail: String(err),
            life: 6000,
        });
    }
}

function _collectUpstream(nodeId, allOutput, result) {
    if (result[nodeId] || !allOutput[nodeId]) return;
    result[nodeId] = allOutput[nodeId];
    for (const inputVal of Object.values(allOutput[nodeId].inputs ?? {})) {
        if (Array.isArray(inputVal)) _collectUpstream(String(inputVal[0]), allOutput, result);
    }
}

function _updateNodeStatus(node, hasMask, latched) {
    node._mcmpHasMask = hasMask;
    node._mcmpLatched = latched;
    if (hasMask) {
        node.color = _MASK_COLOR;
        node.bgcolor = _MASK_BG_COLOR;
    } else if (latched) {
        node.color = _LATCH_COLOR;
        node.bgcolor = _LATCH_BG_COLOR;
    } else {
        delete node.color;
        delete node.bgcolor;
    }
    node.setDirtyCanvas?.(true, false);
}

// ── Per-node setup ────────────────────────────────────────────────────────────

function setupMaskPainterLatchNode(node) {
    const w = node.widgets?.find(obj => obj.name === "image_widget");
    if (!w) return;

    // Hide tracking widgets
    w.type = "hidden";
    w.hidden = true;
    w.computeSize = () => [0, -4];

    const versionWidget = node.widgets?.find(obj => obj.name === "latch_version");
    if (versionWidget) {
        versionWidget.type = "hidden";
        versionWidget.hidden = true;
        versionWidget.computeSize = () => [0, -4];
    }

    // Initial node thumbnail slot
    node._imgs = [new Image()];
    node.imageIndex = 0;

    // Suppress default onExecuted — we handle thumbnails ourselves.
    node.onExecuted = function () {};

    // Re-apply status color on every draw
    const _origDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function (ctx, canvas) {
        _origDrawBackground?.call(this, ctx, canvas);
        if (node._mcmpHasMask) {
            if (node.color !== _MASK_COLOR) node.color = _MASK_COLOR;
            if (node.bgcolor !== _MASK_BG_COLOR) node.bgcolor = _MASK_BG_COLOR;
        } else if (node._mcmpLatched) {
            if (node.color !== _LATCH_COLOR) node.color = _LATCH_COLOR;
            if (node.bgcolor !== _LATCH_BG_COLOR) node.bgcolor = _LATCH_BG_COLOR;
        }
    };

    // ── image_widget.value: pb_id management ─────────────────────────────────
    Object.defineProperty(w, "value", {
        async set(v) {
            if (w._lock) return;
            const stack = new Error().stack ?? "";
            if (stack.includes("presetText.js")) return;

            const image = new Image();
            if (typeof v === "string" && v.startsWith("$")) {
                const needToLoad = !node._imgs[0]?.src;
                if (await loadImageFromId(image, v)) {
                    w._value = v;
                    if (needToLoad) {
                        node._imgs = [image];
                        node.setDirtyCanvas?.(true, false);
                    }
                } else {
                    w._value = `$${node.id}-0`;
                }
            } else if (v) {
                w._lock = true;
                try {
                    w._value = await registerClipspacePath(node.id, v);
                    const versionWidget = node.widgets?.find(obj => obj.name === "latch_version");
                    if (versionWidget) {
                        versionWidget.value = String(Date.now());
                    }
                } finally {
                    w._lock = false;
                }
            } else {
                w._value = "";
            }
        },
        get() {
            if (w._value === undefined || w._value === null) {
                w._value = node.id != null && node.id >= 0 ? `$${node.id}-0` : "";
            }
            return w._value;
        },
        configurable: true,
    });

    // ── node.imgs: detect pasteFromClipspace ─────────────────────────────────
    Object.defineProperty(node, "imgs", {
        set(v) {
            if (!v || v.length === 0) {
                node._imgs = v || [];
                return;
            }
            try {
                const sp = new URLSearchParams(v[0].src.split("?")[1]);
                const type = sp.get("type");
                const filename = sp.get("filename") || "";
                
                // Allow user pastes (e.g. from Mask Editor) to trigger bridge/set, 
                // but IGNORE execution thumbnails (which have MCMP- in their filename)
                // to prevent an infinite cache miss loop!
                if (type && !filename.includes("MCMP-")) {
                    let str = "";
                    if (sp.get("subfolder")) str += sp.get("subfolder") + "/";
                    str += `${filename} [${type}]`;
                    w.value = str;
                }
            } catch (_) {}
            node._imgs = v;
        },
        get() { return node._imgs; },
        configurable: true,
    });

    // ── Action handlers ──────────────────────────────────────────────────────

    function actionEdit() {
        if (!node._imgs?.[0]?.src) {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "No image",
                detail: "Run the node first to load the image.",
                life: 5000,
            });
            return;
        }
        const copy = app.copyToClipspace ? (...a) => app.copyToClipspace(...a) : app.constructor?.copyToClipspace;
        const open = app.openMaskeditor ? (...a) => app.openMaskeditor(...a) : app.constructor?.open_maskeditor;
        if (!copy || !open) {
            app.extensionManager?.toast?.add?.({
                severity: "error",
                summary: "Editor unavailable",
                detail: "The native mask editor is not available in this ComfyUI version.",
                life: 5000,
            });
            return;
        }
        if (app.constructor) app.constructor.clipspace = null;
        app.clipspace = null;
        copy(node);
        if (app.constructor) app.constructor.clipspace_return_node = node;
        app.clipspace_return_node = node;
        open();
    }

    async function actionClear() {
        if (node.id == null || node.id < 0) return;
        _updateNodeStatus(node, false, false);

        // Clear backup status so prompt manipulation won't strip links
        delete _backupStatus[String(node.id)];

        try {
            await api.fetchApi(
                `/mincore/mask_painter/clear?node_id=${encodeURIComponent(String(node.id))}`,
                { cache: "no-store" }
            );
        } catch (_) {}

        w._value = `$${node.id}-0`;

        if (versionWidget) {
            versionWidget.value = String(Date.now());
        }

        _queueNode(node);
    }

    async function actionRefreshImage() {
        if (node.id == null || node.id < 0) return;

        // Clear image backup status so link is preserved for this run
        delete _backupStatus[String(node.id)];

        try {
            await api.fetchApi(
                `/mincore/mask_painter/refresh_image?node_id=${encodeURIComponent(String(node.id))}`,
                { cache: "no-store" }
            );
        } catch (_) {}

        if (versionWidget) {
            versionWidget.value = String(Date.now());
        }

        _queueNode(node);
    }

    async function actionRefreshMask() {
        if (node.id == null || node.id < 0) return;

        // Clear mask backup status so link is preserved for this run
        delete _backupStatus[String(node.id)];

        try {
            await api.fetchApi(
                `/mincore/mask_painter/refresh_mask?node_id=${encodeURIComponent(String(node.id))}`,
                { cache: "no-store" }
            );
        } catch (_) {}

        if (versionWidget) {
            versionWidget.value = String(Date.now());
        }

        _queueNode(node);
    }

    // ── Custom 4-button widget: two rows of two ──────────────────────────────
    const BTN_ROW_HEIGHT = 40;
    const BTN_H = 32;
    const BTN_PAD_TOP = 4;
    const ROW_GAP = 4;

    const buttonRows = [
        [
            { label: "✏️ Edit", action: actionEdit },
            { label: "🗑️ Clear", action: actionClear },
        ],
        [
            { label: "🔄 Refresh", action: actionRefreshImage },
            { label: "🔄 Refresh 🎭", action: actionRefreshMask },
        ],
    ];

    const rowWidget = {
        type: "custom",
        name: "mcmp_buttons",
        value: null,
        options: { serialize: false },
        last_y: 0,
        _hover: [-1, -1], // [row, col]
        _down: [-1, -1],
        computeSize(width) {
            const totalH = buttonRows.length * BTN_ROW_HEIGHT + (buttonRows.length - 1) * ROW_GAP + BTN_PAD_TOP;
            return [width, totalH];
        },
        _layout(widgetWidth) {
            const margin = 12;
            const gap = 6;
            const innerW = widgetWidth - margin * 2;
            return { margin, gap, innerW };
        },
        _btnRect(row, col, widgetWidth) {
            const { margin, gap, innerW } = this._layout(widgetWidth);
            const cols = buttonRows[row].length;
            const btnW = (innerW - gap * (cols - 1)) / cols;
            const x = margin + col * (btnW + gap);
            const y = BTN_PAD_TOP + row * (BTN_ROW_HEIGHT + ROW_GAP);
            return { x, y, w: btnW, h: BTN_H };
        },
        draw(ctx, _node, _widgetWidth, widgetY, _height) {
            const widgetWidth = _node.size[0];
            this.last_y = widgetY;
            ctx.save();
            ctx.font = "13px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            for (let r = 0; r < buttonRows.length; r++) {
                for (let c = 0; c < buttonRows[r].length; c++) {
                    const rect = this._btnRect(r, c, widgetWidth);
                    const bx = rect.x;
                    const by = widgetY + rect.y;
                    const bw = rect.w;
                    const bh = rect.h;
                    const active =
                        (r === this._down[0] && c === this._down[1]) ||
                        (r === this._hover[0] && c === this._hover[1]);
                    ctx.fillStyle = active ? "#3a3a3a" : "#2a2a2a";
                    ctx.strokeStyle = "#1a1a1a";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4);
                    else ctx.rect(bx, by, bw, bh);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = "#dcdcdc";
                    ctx.fillText(buttonRows[r][c].label, bx + bw / 2, by + bh / 2);
                }
            }
            ctx.restore();
        },
        mouse(event, pos, ownerNode) {
            const widgetWidth = ownerNode.size[0];
            const x = pos[0];
            const yRel = pos[1] - this.last_y;

            let hitRow = -1, hitCol = -1;
            for (let r = 0; r < buttonRows.length && hitRow < 0; r++) {
                for (let c = 0; c < buttonRows[r].length; c++) {
                    const rect = this._btnRect(r, c, widgetWidth);
                    if (
                        x >= rect.x && x <= rect.x + rect.w &&
                        yRel >= rect.y && yRel <= rect.y + rect.h
                    ) {
                        hitRow = r;
                        hitCol = c;
                        break;
                    }
                }
            }

            const t = event.type;
            if (t === "pointerdown" || t === "mousedown") {
                if (hitRow >= 0) {
                    this._down = [hitRow, hitCol];
                    ownerNode.setDirtyCanvas?.(true, false);
                    return true;
                }
                return false;
            }
            if (t === "pointerup" || t === "mouseup") {
                const wasDown = [...this._down];
                this._down = [-1, -1];
                ownerNode.setDirtyCanvas?.(true, false);
                if (wasDown[0] >= 0 && wasDown[0] === hitRow && wasDown[1] === hitCol) {
                    buttonRows[hitRow][hitCol].action();
                    return true;
                }
                return false;
            }
            if (t === "pointermove" || t === "mousemove") {
                if (hitRow !== this._hover[0] || hitCol !== this._hover[1]) {
                    this._hover = [hitRow, hitCol];
                    ownerNode.setDirtyCanvas?.(true, false);
                }
                return false;
            }
            return false;
        },
    };
    node.addCustomWidget(rowWidget);

    // ── Initial backup status (on workflow load) ─────────────────────────────
    if (node.id != null && node.id >= 0) {
        _refreshBackupStatus([String(node.id)]);
    }
}


// ── Global "executed" listener ────────────────────────────────────────────────

api.addEventListener("executed", ({ detail }) => {
    if (!detail?.output) return;
    const node = app.graph?.getNodeById?.(detail.node);
    if (!node || node.comfyClass !== NODE_TYPE) return;

    const out = detail.output;
    if (!("mcmp_pb_id" in out)) return;

    const w = node.widgets?.find(obj => obj.name === "image_widget");
    const pb_id = Array.isArray(out.mcmp_pb_id) ? out.mcmp_pb_id[0] : out.mcmp_pb_id;
    const hasMask = Array.isArray(out.mcmp_has_mask) ? !!out.mcmp_has_mask[0] : !!out.mcmp_has_mask;
    const latched = Array.isArray(out.mcmp_latched) ? !!out.mcmp_latched[0] : !!out.mcmp_latched;

    // Update thumbnail
    if (out.images?.length) {
        const item = out.images[0];
        let currentFilename = "";
        try {
            const u = new URL(node._imgs?.[0]?.src ?? "", window.location.href);
            currentFilename = u.searchParams.get("filename") ?? "";
        } catch (_) {}

        if (currentFilename !== item.filename) {
            const p = new URLSearchParams({
                filename: item.filename,
                type: item.type,
                subfolder: item.subfolder ?? "",
            });
            const img = new Image();
            img.src = api.apiURL(`/view?${p}`);
            node._imgs = [img];
            node.imageIndex = 0;
            node.setDirtyCanvas?.(true, false);
        }
    }

    // Store pb_id without re-triggering the value setter
    if (w && pb_id) w._value = pb_id;

    // Update backup status cache
    const nid = String(detail.node);
    delete _backupStatus[nid];
    _backupStatus[nid] = {
        image: latched || !!out.images?.length,
        mask: hasMask,
    };

    _updateNodeStatus(node, hasMask, latched);
});


// ── Prompt manipulation: strip blocked upstream links ─────────────────────────
//
// We monkey-patch app.graphToPrompt so that before the prompt is sent,
// we remove the `image` and/or `mask` links from any MaskPainterLatch node
// that has the corresponding block=True and backup on disk.

const _origGraphToPrompt = app.graphToPrompt.bind(app);
app.graphToPrompt = async function () {
    // Collect node IDs that need a status check
    const nodeIds = [];
    if (app.graph) {
        for (const node of app.graph._nodes || []) {
            if (node.comfyClass === NODE_TYPE && node.id != null && node.id >= 0) {
                const nid = String(node.id);
                if (!(nid in _backupStatus)) {
                    nodeIds.push(nid);
                }
            }
        }
    }
    if (nodeIds.length > 0) {
        await _refreshBackupStatus(nodeIds);
    }

    const result = await _origGraphToPrompt();
    if (!result?.output) return result;

    for (const [nodeId, nodeData] of Object.entries(result.output)) {
        if (nodeData.class_type !== NODE_TYPE) continue;
        const inputs = nodeData.inputs;
        if (!inputs) continue;

        // Set image_widget to a constant so it doesn't cause spurious cache misses,
        // but do not delete it, otherwise ComfyUI frontend validation fails.
        inputs.image_widget = "";

        const status = _backupStatus[nodeId];
        if (!status) continue;

        // Strip image link if blocked and backed up
        if (inputs.block_image && status.image && Array.isArray(inputs.image)) {
            delete inputs.image;
        }

        // Strip mask link if blocked and backed up
        if (inputs.block_mask && status.mask && Array.isArray(inputs.mask)) {
            delete inputs.mask;
        }
    }

    return result;
};


// ── Extension registration ────────────────────────────────────────────────────

app.registerExtension({
    name: "MinCore.MaskPainterLatch",

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        setupMaskPainterLatchNode(node);
    },
});
