import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export function fileItemUrl(item) {
    if (!item?.filename) return "";
    const query = new URLSearchParams({
        filename: item.filename,
        type: item.type || "temp",
        subfolder: item.subfolder || "",
        t: String(Date.now()),
    });
    return api.apiURL(`/view?${query}`);
}

export async function jsonRequest(path, options = {}) {
    const response = await api.fetchApi(path, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}

export function toast(severity, summary, detail = "") {
    app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 5000 });
}

export async function queueNode(node) {
    if (node?.id == null || node.id < 0) {
        throw new Error("The node must be added to the workflow before it can run.");
    }
    await app.queuePrompt(0, 1, [String(node.id)]);
}
