/**
 * Viewport - coordinate transforms for the pose editor canvas.
 *
 * Owns the logical <-> screen mapping, an optional zoom/pan transform (used by
 * the future zoom feature), and a generic "view" transform used by hand-edit
 * mode.  All pointer coordinates flow through screenToWorld() and all drawing
 * flows through applyWorldTransform() / applyViewTransform() so that future
 * zoom/pan/background-image features only touch this one file.
 */

/**
 * A 2D transform: world -> view (x' = x * scale + offsetX).
 * @typedef {object} ViewTransform
 * @property {number} scale
 * @property {number} offsetX
 * @property {number} offsetY
 */

export class Viewport {
	/**
	 * @param {object} [options]
	 * @param {number} [options.logicalWidth]
	 * @param {number} [options.logicalHeight]
	 */
	constructor(options = {}) {
		this.logicalWidth = options.logicalWidth || 768;
		this.logicalHeight = options.logicalHeight || 512;

		// Zoom / pan state (identity by default).  The future zoom feature
		// mutates these; hit-testing and drawing automatically follow.
		this.zoomScale = 1;
		this.zoomOffsetX = 0;
		this.zoomOffsetY = 0;

		// Optional viewport-size override (used by hand-edit mode's square view).
		this.viewportSize = null;

		// Active view transform (hand-edit mode sets this to fit the hand).
		// Null means no transform (identity).
		this.view = null;
	}

	// ── Dimensions ──────────────────────────────────────────────────────────

	/** @returns {number} effective viewport width (override-aware) */
	getViewportWidth() {
		return this.viewportSize ?? this.logicalWidth;
	}

	/** @returns {number} effective viewport height (override-aware) */
	getViewportHeight() {
		return this.viewportSize ?? this.logicalHeight;
	}

	/**
	 * Set the viewport size override (e.g. hand-edit square view).
	 * @param {number|null} size - square size, or null to clear the override
	 */
	setViewportSize(size) {
		this.viewportSize = size ?? null;
	}

	// ── Coordinate mapping ──────────────────────────────────────────────────

	/**
	 * Map client (screen) coordinates to world (logical) coordinates.
	 * Handles CSS scaling, devicePixelRatio, viewport override and zoom/pan.
	 * @param {number} clientX
	 * @param {number} clientY
	 * @param {DOMRect} rect - canvas.getBoundingClientRect()
	 * @returns {{x:number, y:number}}
	 */
	screenToWorld(clientX, clientY, rect) {
		const vw = this.getViewportWidth();
		const vh = this.getViewportHeight();
		let x = (clientX - rect.left) * (vw / rect.width);
		let y = (clientY - rect.top) * (vh / rect.height);
		// Undo zoom/pan
		x = (x - this.zoomOffsetX) / this.zoomScale;
		y = (y - this.zoomOffsetY) / this.zoomScale;
		return { x, y };
	}

	/**
	 * Map world (logical) coordinates to client (screen) coordinates.
	 * @param {number} x
	 * @param {number} y
	 * @param {DOMRect} rect - canvas.getBoundingClientRect()
	 * @returns {{x:number, y:number}}
	 */
	worldToScreen(x, y, rect) {
		const vw = this.getViewportWidth();
		const vh = this.getViewportHeight();
		const sx = x * this.zoomScale + this.zoomOffsetX;
		const sy = y * this.zoomScale + this.zoomOffsetY;
		return {
			x: rect.left + sx * (rect.width / vw),
			y: rect.top + sy * (rect.height / vh)
		};
	}

	// ── Zoom / pan (future feature) ─────────────────────────────────────────

	/**
	 * Apply a world-space transform to the canvas context BEFORE drawing.
	 * Composes zoom/pan so that all draw methods render in world coordinates.
	 * @param {CanvasRenderingContext2D} ctx
	 */
	applyWorldTransform(ctx) {
		if (this.zoomScale !== 1 || this.zoomOffsetX !== 0 || this.zoomOffsetY !== 0) {
			// translate-then-scale maps world -> zoom*world + offset, which is the
			// exact inverse of screenToWorld's (view - offset) / zoom.
			ctx.translate(this.zoomOffsetX, this.zoomOffsetY);
			ctx.scale(this.zoomScale, this.zoomScale);
		}
	}

	/**
	 * Zoom by a factor around a world-space pivot point.
	 * The pivot stays fixed on screen (its canvas position is unchanged).
	 * Forward transform is canvas = world * zoomScale + zoomOffset, so the
	 * offset must be adjusted by pivot * (oldScale - newScale) to keep the
	 * pivot's canvas position invariant.
	 * @param {number} factor
	 * @param {{x:number, y:number}} pivot - world coordinate to zoom around
	 */
	zoomAround(factor, pivot) {
		const oldScale = this.zoomScale;
		const newScale = Math.max(0.1, Math.min(10, oldScale * factor));
		this.zoomOffsetX += pivot.x * (oldScale - newScale);
		this.zoomOffsetY += pivot.y * (oldScale - newScale);
		this.zoomScale = newScale;
	}

	/**
	 * Pan by a delta in screen (view) coordinates.
	 * @param {number} dx
	 * @param {number} dy
	 */
	panBy(dx, dy) {
		this.zoomOffsetX += dx;
		this.zoomOffsetY += dy;
	}

	/** Reset zoom/pan to identity. */
	resetZoom() {
		this.zoomScale = 1;
		this.zoomOffsetX = 0;
		this.zoomOffsetY = 0;
	}

	// ── View transform (hand-edit mode / generic) ───────────────────────────

	/**
	 * Set the active view transform (world -> view). Pass null to clear.
	 * @param {ViewTransform|null} view
	 */
	setView(view) {
		this.view = view ?? null;
	}

	/**
	 * Map a world point through the active view transform.
	 * @param {{x:number, y:number}} point
	 * @returns {{x:number, y:number}|null}
	 */
	worldToView(point) {
		const view = this.view;
		if (!point || !view) {
			return null;
		}
		return {
			x: point.x * view.scale + view.offsetX,
			y: point.y * view.scale + view.offsetY
		};
	}

	/**
	 * Map a view-space point back to world coordinates.
	 * @param {{x:number, y:number}} point
	 * @returns {{x:number, y:number}|null}
	 */
	viewToWorld(point) {
		const view = this.view;
		if (!point || !view) {
			return null;
		}
		return {
			x: (point.x - view.offsetX) / view.scale,
			y: (point.y - view.offsetY) / view.scale
		};
	}

	/**
	 * Apply the active view transform to a canvas context.
	 * @param {CanvasRenderingContext2D} ctx
	 */
	applyViewTransform(ctx) {
		const view = this.view;
		if (!view) {
			return;
		}
		ctx.translate(view.offsetX, view.offsetY);
		ctx.scale(view.scale, view.scale);
	}
}
