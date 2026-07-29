import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "MinCore_LatentLatch";
const _LATCH_COLOR = "#1b3a4b";
const _LATCH_BG_COLOR = "#0f232e";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Queue a single node by generating the prompt and filtering the graph down
// to that node + its upstream deps. We bypass app.queuePrompt() to avoid
// triggering global UI side-effects like randomizing seeds on unrelated nodes.
async function _queueNode(node) {
    try {
        const p = await app.graphToPrompt();
        if (p?.output) {
            const filtered = {};
            _collectUpstream(String(node.id), p.output, filtered);
            await api.queuePrompt(0, { output: filtered, workflow: p.workflow });
        }
    } catch (err) {
        console.error("Latent Latch queue error:", err);
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

function _updateLatchStatus(node, isLatched) {
    node._mincoreLatched = isLatched;
    if (isLatched) {
        node.color = _LATCH_COLOR;
        node.bgcolor = _LATCH_BG_COLOR;
    } else {
        delete node.color;
        delete node.bgcolor;
    }
    node.setDirtyCanvas?.(true, false);
}

// ── Per-node setup ────────────────────────────────────────────────────────────

function setupLatentLatchNode(node) {
    // 1. Hide the latch_version widget
    const versionWidget = node.widgets?.find(w => w.name === "latch_version");
    if (versionWidget) {
        versionWidget.type = "hidden";
        versionWidget.hidden = true;
        versionWidget.computeSize = () => [0, -4];
    }

    // 2. Re-apply color on draw if latched (so themes don't overwrite it)
    const _origDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function (ctx, canvas) {
        _origDrawBackground?.call(this, ctx, canvas);
        if (node._mincoreLatched) {
            if (node.color !== _LATCH_COLOR) node.color = _LATCH_COLOR;
            if (node.bgcolor !== _LATCH_BG_COLOR) node.bgcolor = _LATCH_BG_COLOR;
        }
    };

    // 3. Action handlers
    async function actionRefresh() {
        if (node.id == null || node.id < 0) return;

        // Instant visual feedback
        _updateLatchStatus(node, false);

        // Tell backend to force refresh
        try {
            await api.fetchApi(
                `/mincore/latch/refresh?node_id=${encodeURIComponent(String(node.id))}`,
                { cache: "no-store" }
            );
        } catch (_) {}

        // Bump the version to invalidate ComfyUI's cache for this node
        if (versionWidget) {
            versionWidget.value = String(Date.now());
        }

        // Re-execute this node and its upstream
        _queueNode(node);
    }

    // 4. Custom button widget
    const btnWidget = {
        type: "custom",
        name: "mincore_latch_button",
        value: null,
        options: { serialize: false },
        last_y: 0,
        _hover: false,
        _down: false,
        computeSize(width) {
            return [width, 32];
        },
        draw(ctx, ownerNode, widgetWidth, widgetY, height) {
            this.last_y = widgetY;
            const actualWidth = ownerNode.size[0];
            const margin = 12;
            const btnW = actualWidth - margin * 2;
            const btnH = 24;
            const x = margin;
            const y = widgetY + 4;

            ctx.save();
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            const active = this._down || this._hover;
            ctx.fillStyle = active ? "#3a3a3a" : "#2a2a2a";
            ctx.strokeStyle = "#1a1a1a";
            ctx.lineWidth = 1;

            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, btnW, btnH, 4);
            else ctx.rect(x, y, btnW, btnH);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#dcdcdc";
            ctx.fillText("🔄 Refresh", x + btnW / 2, y + btnH / 2);
            ctx.restore();
        },
        mouse(event, pos, ownerNode) {
            const actualWidth = ownerNode.size[0];
            const margin = 12;
            const btnW = actualWidth - margin * 2;
            const btnH = 24;
            const x = pos[0];
            const yRel = pos[1] - this.last_y;
            
            const hit = x >= margin && x <= margin + btnW && yRel >= 4 && yRel <= 4 + btnH;
            const t = event.type;

            if (t === "pointerdown" || t === "mousedown") {
                if (hit) {
                    this._down = true;
                    ownerNode.setDirtyCanvas?.(true, false);
                    return true;
                }
                return false;
            }
            if (t === "pointerup" || t === "mouseup") {
                const wasDown = this._down;
                this._down = false;
                ownerNode.setDirtyCanvas?.(true, false);
                if (wasDown && hit) {
                    actionRefresh();
                    return true;
                }
                return false;
            }
            if (t === "pointermove" || t === "mousemove") {
                if (hit !== this._hover) {
                    this._hover = hit;
                    ownerNode.setDirtyCanvas?.(true, false);
                }
                return false;
            }
            return false;
        },
    };
    node.addCustomWidget(btnWidget);

    // 5. Initial status check (useful on workflow load)
    if (node.id != null && node.id >= 0) {
        api.fetchApi(`/mincore/latch/status?node_id=${encodeURIComponent(String(node.id))}`, { cache: "no-store" })
            .then(res => res.json())
            .then(data => {
                if (data.latched) {
                    _updateLatchStatus(node, true);
                }
            })
            .catch(() => {});
    }
}

// ── Global "executed" listener ────────────────────────────────────────────────

api.addEventListener("executed", ({ detail }) => {
    if (!detail?.output) return;
    const node = app.graph?.getNodeById?.(detail.node);
    if (!node || node.comfyClass !== NODE_TYPE) return;

    const out = detail.output;
    if ("latched" in out) {
        const isLatched = Array.isArray(out.latched) ? !!out.latched[0] : !!out.latched;
        if (isLatched) {
            _updateLatchStatus(node, true);
        }
    }
});

// ── Extension registration ────────────────────────────────────────────────────

app.registerExtension({
    name: "MinCore.LatentLatch",

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        setupLatentLatchNode(node);
    },
});
