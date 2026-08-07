/**
 * InteractionManager - dispatch layer for pointer drag modes.
 *
 * Each drag behaviour is a small mode object with `onMove` / `onUp` handlers.
 * The manager only stores *which* mode is active and routes pointer events to
 * it.  Mode handlers are invoked with the owning canvas instance as `this`, so
 * they read/write the same state fields as before (activeDragMode,
 * dragStartKeypoint, ...) without any new plumbing.
 *
 * Adding a new gesture (e.g. right-click delete) = register a new mode here
 * and activate it from the owning class.  See core/ARCHITECTURE.md.
 */

/**
 * Mode contract:
 *   onMove(pointer, evt) -> boolean  (return true = handled / keep dragging)
 *   onUp(evt) -> void                (finalize + call this.resetDragState(evt))
 *   onEnter(data) -> void            (optional, called on activate)
 */

export class InteractionManager {
	/**
	 * @param {object} owner - the canvas class instance (OpenPoseCanvas2D)
	 */
	constructor(owner) {
		this.owner = owner;
		this.modes = new Map();
	}

	/**
	 * Register a mode by name.
	 * @param {string} name - must match the owner's activeDragMode string
	 * @param {object} mode - { onMove?, onUp?, onEnter? }
	 */
	registerMode(name, mode) {
		this.modes.set(name, mode);
	}

	unregisterMode(name) {
		this.modes.delete(name);
	}

	/** @returns {string|null} name of the currently active mode */
	get current() {
		return this.owner.activeDragMode;
	}

	/**
	 * @param {string} name
	 * @returns {boolean} true if `name` is the active drag mode
	 */
	isActive(name) {
		return this.owner.activeDragMode === name;
	}

	/**
	 * Activate a mode.  Keeps `owner.activeDragMode` as the single source of
	 * truth so all existing code that reads it keeps working.
	 * @param {string} name
	 * @param {*} [data] - passed to the mode's onEnter, if any
	 */
	activate(name, data = undefined) {
		const previous = this.owner.activeDragMode;
		this.owner.activeDragMode = name;
		const mode = this.modes.get(name);
		if (mode?.onEnter && previous !== name) {
			mode.onEnter.call(this.owner, data);
		}
	}

	/** Deactivate any active mode (sets activeDragMode to 'none'). */
	deactivate() {
		this.owner.activeDragMode = 'none';
	}

	/**
	 * Route a pointermove to the active mode.
	 * @param {{x:number, y:number}} pointer - logical coordinates
	 * @param {Event} evt
	 * @returns {boolean} true if a mode handled the event
	 */
	handlePointerMove(pointer, evt) {
		const mode = this.modes.get(this.owner.activeDragMode);
		if (!mode?.onMove) {
			return false;
		}
		return mode.onMove.call(this.owner, pointer, evt);
	}

	/**
	 * Route a pointerup to the active mode, or reset shared state if no mode
	 * is active.  Modes are expected to finish with this.owner.resetDragState(evt).
	 * @param {Event} evt
	 */
	handlePointerUp(evt) {
		const mode = this.modes.get(this.owner.activeDragMode);
		if (mode?.onUp) {
			mode.onUp.call(this.owner, evt);
		} else {
			this.owner.resetDragState?.(evt);
		}
	}
}

// ── Drag mode implementations ────────────────────────────────────────────────
// Each block below was extracted verbatim from OpenPoseCanvas2D's
// handlePointerMove / handlePointerUp so behaviour is identical.

/** Drag a single body keypoint. */
const DragKeypointMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !Array.isArray(pose.keypoints)) {
			return true;
		}
		pose.keypoints[this.activeKeypointId] = {
			x: Math.max(0, Math.min(this.logicalWidth, pointer.x)),
			y: Math.max(0, Math.min(this.logicalHeight, pointer.y))
		};
		this.updateAttachedHands(pose);
		this.updateWristFusionTargets(pose);
		const R = this._getTrashTargetRadius();
		const wasHovered = this.trashTargetHovered;
		const dx = this.logicalWidth - pointer.x;
		const dy = pointer.y;
		this.trashTargetHovered = (dx * dx + dy * dy <= R * R);
		if (wasHovered !== this.trashTargetHovered) {
			this.requestRedraw();
			return true;
		}
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		// Drag-to-delete: drop on trash target deletes the keypoint
		if (this.trashTargetHovered && this.dragStartKeypoint) {
			const { poseIndex, keypointId } = this.dragStartKeypoint;
			const pose = this.poses[poseIndex];
			if (pose && pose.keypoints) {
				this.restoreAttachedHands(pose);
				pose.keypoints[keypointId] = null;
				this.markKeypointEdited();
			}
			this.notifyChange('geometry');
			this.resetDragState(evt);
			return;
		}
		// Wrist fusion after drag
		const poseIndex = this.dragStartKeypoint?.poseIndex ?? this.selectedPoseIndex;
		this.fuseBodyWristsAtHandTargets(this.poses[poseIndex]);
		// Only mark edited if the keypoint actually moved
		if (this.dragStartKeypoint) {
			const pose = this.poses[this.dragStartKeypoint.poseIndex];
			const kp = pose ? pose.keypoints[this.dragStartKeypoint.keypointId] : null;
			if (kp && (kp.x !== this.dragStartKeypoint.x || kp.y !== this.dragStartKeypoint.y)) {
				this.markKeypointEdited();
			}
		}
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Move multiple selected keypoints together (delta from drag start). */
const MoveSelectedKeypointsMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !this.dragStartPointer || !this.dragStartKeypointMap) {
			return true;
		}
		const dx = pointer.x - this.dragStartPointer.x;
		const dy = pointer.y - this.dragStartPointer.y;
		for (const [kpId, startPos] of this.dragStartKeypointMap) {
			pose.keypoints[kpId] = {
				x: Math.max(0, Math.min(this.logicalWidth, startPos.x + dx)),
				y: Math.max(0, Math.min(this.logicalHeight, startPos.y + dy))
			};
		}
		this.updateAttachedHands(pose);
		this.updateWristFusionTargets(pose);
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		const poseIndex = this.dragStartKeypoint?.poseIndex ?? this.selectedPoseIndex;
		this.fuseBodyWristsAtHandTargets(this.poses[poseIndex]);
		this.markKeypointEdited();
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Scale the selected keypoint group around an anchor. */
const ScaleSelectedKeypointsMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !this.dragStartKeypointMap || !this.activeScaleHandle) {
			return true;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const pos of this.dragStartKeypointMap.values()) {
			minX = Math.min(minX, pos.x); minY = Math.min(minY, pos.y);
			maxX = Math.max(maxX, pos.x); maxY = Math.max(maxY, pos.y);
		}
		const bbox = { minX, minY, maxX, maxY };
		const handle = this.activeScaleHandle;
		let scaleX = 1, scaleY = 1, anchorX, anchorY;

		if (['nw', 'ne', 'sw', 'se'].includes(handle)) {
			const anchorMap = {
				nw: { x: bbox.maxX, y: bbox.maxY },
				ne: { x: bbox.minX, y: bbox.maxY },
				sw: { x: bbox.maxX, y: bbox.minY },
				se: { x: bbox.minX, y: bbox.minY }
			};
			const anchor = anchorMap[handle];
			anchorX = anchor.x; anchorY = anchor.y;
			const handleOriginal = this.getScaleHandles(bbox, 10)[handle];
			const originalDist = Math.sqrt((handleOriginal.x - anchorX) ** 2 + (handleOriginal.y - anchorY) ** 2);
			const currentDist = Math.sqrt((pointer.x - anchorX) ** 2 + (pointer.y - anchorY) ** 2);
			let scale = originalDist > 0 ? currentDist / originalDist : 1;
			scale = Math.max(0.1, Math.min(10, scale));
			scaleX = scale; scaleY = scale;
		} else if (handle === 'e') {
			anchorX = bbox.minX; anchorY = (bbox.minY + bbox.maxY) / 2;
			const w = bbox.maxX - bbox.minX;
			scaleX = w > 0 ? Math.max(0.1, Math.min(10, (pointer.x - anchorX) / w)) : 1; scaleY = 1;
		} else if (handle === 'w') {
			anchorX = bbox.maxX; anchorY = (bbox.minY + bbox.maxY) / 2;
			const w = bbox.maxX - bbox.minX;
			scaleX = w > 0 ? Math.max(0.1, Math.min(10, (anchorX - pointer.x) / w)) : 1; scaleY = 1;
		} else if (handle === 's') {
			anchorX = (bbox.minX + bbox.maxX) / 2; anchorY = bbox.minY;
			const h = bbox.maxY - bbox.minY;
			scaleX = 1; scaleY = h > 0 ? Math.max(0.1, Math.min(10, (pointer.y - anchorY) / h)) : 1;
		} else if (handle === 'n') {
			anchorX = (bbox.minX + bbox.maxX) / 2; anchorY = bbox.maxY;
			const h = bbox.maxY - bbox.minY;
			scaleX = 1; scaleY = h > 0 ? Math.max(0.1, Math.min(10, (anchorY - pointer.y) / h)) : 1;
		}

		for (const [kpId, startPos] of this.dragStartKeypointMap) {
			pose.keypoints[kpId] = {
				x: anchorX + (startPos.x - anchorX) * scaleX,
				y: anchorY + (startPos.y - anchorY) * scaleY
			};
		}
		this.updateAttachedHands(pose);
		this.updateWristFusionTargets(pose);
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		const poseIndex = this.dragStartKeypoint?.poseIndex ?? this.selectedPoseIndex;
		this.fuseBodyWristsAtHandTargets(this.poses[poseIndex]);
		this.markKeypointEdited();
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Move the whole pose (body + face + hands) by a delta. */
const MovePoseMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !this.dragStartPointer || !this.dragStartPose) {
			return true;
		}
		const dx = pointer.x - this.dragStartPointer.x;
		const dy = pointer.y - this.dragStartPointer.y;
		for (let i = 0; i < pose.keypoints.length; i++) {
			const originalKp = this.dragStartPose.keypoints[i];
			if (originalKp) {
				pose.keypoints[i] = {
					x: Math.max(0, Math.min(this.logicalWidth, originalKp.x + dx)),
					y: Math.max(0, Math.min(this.logicalHeight, originalKp.y + dy))
				};
			}
		}
		if (Array.isArray(pose.faceKeypoints) && Array.isArray(this.dragStartPose.faceKeypoints)) {
			for (let i = 0; i < pose.faceKeypoints.length; i++) {
				const originalKp = this.dragStartPose.faceKeypoints[i];
				if (originalKp) {
					pose.faceKeypoints[i] = {
						x: Math.max(0, Math.min(this.logicalWidth, originalKp.x + dx)),
						y: Math.max(0, Math.min(this.logicalHeight, originalKp.y + dy))
					};
				}
			}
		}
		if (Array.isArray(pose.handLeftKeypoints) && Array.isArray(this.dragStartPose.handLeftKeypoints)) {
			for (let i = 0; i < pose.handLeftKeypoints.length; i++) {
				const originalKp = this.dragStartPose.handLeftKeypoints[i];
				if (originalKp) {
					pose.handLeftKeypoints[i] = {
						x: Math.max(0, Math.min(this.logicalWidth, originalKp.x + dx)),
						y: Math.max(0, Math.min(this.logicalHeight, originalKp.y + dy))
					};
				}
			}
		}
		if (Array.isArray(pose.handRightKeypoints) && Array.isArray(this.dragStartPose.handRightKeypoints)) {
			for (let i = 0; i < pose.handRightKeypoints.length; i++) {
				const originalKp = this.dragStartPose.handRightKeypoints[i];
				if (originalKp) {
					pose.handRightKeypoints[i] = {
						x: Math.max(0, Math.min(this.logicalWidth, originalKp.x + dx)),
						y: Math.max(0, Math.min(this.logicalHeight, originalKp.y + dy))
					};
				}
			}
		}
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Scale the whole pose around an anchor handle. */
const ScalePoseMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !this.dragStartPose || !this.activeScaleHandle) {
			return true;
		}
		const bbox = this.getPoseBounds(this.dragStartPose);
		if (!bbox) return true;

		const handle = this.activeScaleHandle;
		let scaleX = 1;
		let scaleY = 1;
		let anchorX, anchorY;

		if (['nw', 'ne', 'sw', 'se'].includes(handle)) {
			const anchorMap = {
				nw: { x: bbox.maxX, y: bbox.maxY },
				ne: { x: bbox.minX, y: bbox.maxY },
				sw: { x: bbox.maxX, y: bbox.minY },
				se: { x: bbox.minX, y: bbox.minY }
			};
			const anchor = anchorMap[handle];
			anchorX = anchor.x;
			anchorY = anchor.y;
			const handleOriginal = this.getScaleHandles(bbox, 10)[handle];
			const originalDist = Math.sqrt(
				(handleOriginal.x - anchor.x) ** 2 + (handleOriginal.y - anchor.y) ** 2
			);
			const currentDist = Math.sqrt(
				(pointer.x - anchor.x) ** 2 + (pointer.y - anchor.y) ** 2
			);
			let scale = currentDist / originalDist;
			scale = Math.max(0.1, Math.min(10, scale));
			scaleX = scale;
			scaleY = scale;
		} else if (handle === 'e') {
			anchorX = bbox.minX;
			anchorY = (bbox.minY + bbox.maxY) / 2;
			const originalWidth = bbox.maxX - bbox.minX;
			const newWidth = pointer.x - anchorX;
			scaleX = newWidth / originalWidth;
			scaleX = Math.max(0.1, Math.min(10, scaleX));
			scaleY = 1;
		} else if (handle === 'w') {
			anchorX = bbox.maxX;
			anchorY = (bbox.minY + bbox.maxY) / 2;
			const originalWidth = bbox.maxX - bbox.minX;
			const newWidth = anchorX - pointer.x;
			scaleX = newWidth / originalWidth;
			scaleX = Math.max(0.1, Math.min(10, scaleX));
			scaleY = 1;
		} else if (handle === 's') {
			anchorX = (bbox.minX + bbox.maxX) / 2;
			anchorY = bbox.minY;
			const originalHeight = bbox.maxY - bbox.minY;
			const newHeight = pointer.y - anchorY;
			scaleY = newHeight / originalHeight;
			scaleY = Math.max(0.1, Math.min(10, scaleY));
			scaleX = 1;
		} else if (handle === 'n') {
			anchorX = (bbox.minX + bbox.maxX) / 2;
			anchorY = bbox.maxY;
			const originalHeight = bbox.maxY - bbox.minY;
			const newHeight = anchorY - pointer.y;
			scaleY = newHeight / originalHeight;
			scaleY = Math.max(0.1, Math.min(10, scaleY));
			scaleX = 1;
		}

		for (let i = 0; i < pose.keypoints.length; i++) {
			const originalKp = this.dragStartPose.keypoints[i];
			if (originalKp) {
				pose.keypoints[i] = {
					x: anchorX + (originalKp.x - anchorX) * scaleX,
					y: anchorY + (originalKp.y - anchorY) * scaleY
				};
			}
		}
		if (Array.isArray(pose.faceKeypoints) && Array.isArray(this.dragStartPose.faceKeypoints)) {
			for (let i = 0; i < pose.faceKeypoints.length; i++) {
				const originalKp = this.dragStartPose.faceKeypoints[i];
				if (originalKp) {
					pose.faceKeypoints[i] = {
						x: anchorX + (originalKp.x - anchorX) * scaleX,
						y: anchorY + (originalKp.y - anchorY) * scaleY
					};
				}
			}
		}
		if (Array.isArray(pose.handLeftKeypoints) && Array.isArray(this.dragStartPose.handLeftKeypoints)) {
			for (let i = 0; i < pose.handLeftKeypoints.length; i++) {
				const originalKp = this.dragStartPose.handLeftKeypoints[i];
				if (originalKp) {
					pose.handLeftKeypoints[i] = {
						x: anchorX + (originalKp.x - anchorX) * scaleX,
						y: anchorY + (originalKp.y - anchorY) * scaleY
					};
				}
			}
		}
		if (Array.isArray(pose.handRightKeypoints) && Array.isArray(this.dragStartPose.handRightKeypoints)) {
			for (let i = 0; i < pose.handRightKeypoints.length; i++) {
				const originalKp = this.dragStartPose.handRightKeypoints[i];
				if (originalKp) {
					pose.handRightKeypoints[i] = {
						x: anchorX + (originalKp.x - anchorX) * scaleX,
						y: anchorY + (originalKp.y - anchorY) * scaleY
					};
				}
			}
		}
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Rotate the whole pose around its bbox center. */
const RotatePoseMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		if (!pose || !this.rotatePivot || this.rotateStartAngle === null || !this.dragStartPose) {
			return true;
		}
		const cx = this.rotatePivot.x;
		const cy = this.rotatePivot.y;
		const currentAngle = Math.atan2(pointer.y - cy, pointer.x - cx);
		const deltaAngle = currentAngle - this.rotateStartAngle;
		const cosA = Math.cos(deltaAngle);
		const sinA = Math.sin(deltaAngle);
		const rotatePoint = (kp) => {
			if (!kp) return null;
			const dx = kp.x - cx;
			const dy = kp.y - cy;
			return {
				x: cx + dx * cosA - dy * sinA,
				y: cy + dx * sinA + dy * cosA
			};
		};
		for (let i = 0; i < pose.keypoints.length; i++) {
			pose.keypoints[i] = rotatePoint(this.dragStartPose.keypoints[i]);
		}
		if (Array.isArray(pose.faceKeypoints) && Array.isArray(this.dragStartPose.faceKeypoints)) {
			for (let i = 0; i < pose.faceKeypoints.length; i++) {
				pose.faceKeypoints[i] = rotatePoint(this.dragStartPose.faceKeypoints[i]);
			}
		}
		if (Array.isArray(pose.handLeftKeypoints) && Array.isArray(this.dragStartPose.handLeftKeypoints)) {
			for (let i = 0; i < pose.handLeftKeypoints.length; i++) {
				pose.handLeftKeypoints[i] = rotatePoint(this.dragStartPose.handLeftKeypoints[i]);
			}
		}
		if (Array.isArray(pose.handRightKeypoints) && Array.isArray(this.dragStartPose.handRightKeypoints)) {
			for (let i = 0; i < pose.handRightKeypoints.length; i++) {
				pose.handRightKeypoints[i] = rotatePoint(this.dragStartPose.handRightKeypoints[i]);
			}
		}
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		this.notifyChange('geometry');
		this.resetDragState(evt);
	}
};

/** Marquee selection rectangle. */
const MarqueeMode = {
	onMove(pointer) {
		this.marqueeRect.x2 = pointer.x;
		this.marqueeRect.y2 = pointer.y;
		if (this.selectedPoseIndex !== null && this.selectedPoseIndex < this.poses.length) {
			const rect = this.marqueeRect;
			const rxMin = Math.min(rect.x1, rect.x2);
			const rxMax = Math.max(rect.x1, rect.x2);
			const ryMin = Math.min(rect.y1, rect.y2);
			const ryMax = Math.max(rect.y1, rect.y2);
			const liveSelection = this.marqueeSelectionBase ? new Set(this.marqueeSelectionBase) : new Set();
			const activePose = this.poses[this.selectedPoseIndex];
			for (let kpId = 0; kpId < activePose.keypoints.length; kpId++) {
				const kp = activePose.keypoints[kpId];
				if (kp && kp.x >= rxMin && kp.x <= rxMax && kp.y >= ryMin && kp.y <= ryMax) {
					liveSelection.add(kpId);
				}
			}
			this.selectedKeypointIds = liveSelection;
		}
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		if (this.marqueeRect === null) {
			this.resetDragState(evt);
			return;
		}
		const rect = this.marqueeRect;
		const rxMin = Math.min(rect.x1, rect.x2);
		const rxMax = Math.max(rect.x1, rect.x2);
		const ryMin = Math.min(rect.y1, rect.y2);
		const ryMax = Math.max(rect.y1, rect.y2);
		const dragWidth = rxMax - rxMin;
		const dragHeight = ryMax - ryMin;
		const isClick = dragWidth < 5 && dragHeight < 5;
		if (isClick) {
			this.marqueeRect = null;
			this.marqueeSelectionBase = null;
			this.setSelectedPose(null);
		} else {
			const newSelection = this.marqueeSelectionBase ? new Set(this.marqueeSelectionBase) : new Set();
			if (this.selectedPoseIndex !== null && this.selectedPoseIndex < this.poses.length) {
				const activePose = this.poses[this.selectedPoseIndex];
				for (let kpId = 0; kpId < activePose.keypoints.length; kpId++) {
					const kp = activePose.keypoints[kpId];
					if (kp && kp.x >= rxMin && kp.x <= rxMax && kp.y >= ryMin && kp.y <= ryMax) {
						newSelection.add(kpId);
					}
				}
			}
			this.selectedKeypointIds = newSelection;
			this.marqueeRect = null;
			this.marqueeSelectionBase = null;
			this.notifyChange('select');
		}
		this.resetDragState(evt);
	}
};

/** Move a loose hand (body-to-hand wrist fusion kept in sync). */
const MoveHandMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		const handRef = this.selectedHand;
		if (!pose || !handRef || handRef.poseIndex !== this.selectedPoseIndex || !this.dragStartHandKeypoints ||
			!this.dragStartPointer) {
			return true;
		}
		const { property } = this.getHandSideConfig(handRef.side);
		const bounds = this.getHandBounds(this.dragStartHandKeypoints);
		if (!bounds) {
			return true;
		}
		let dx = pointer.x - this.dragStartPointer.x;
		let dy = pointer.y - this.dragStartPointer.y;
		dx = Math.max(-bounds.minX, Math.min(this.logicalWidth - bounds.maxX, dx));
		dy = Math.max(-bounds.minY, Math.min(this.logicalHeight - bounds.maxY, dy));
		this.handDragMoved = this.handDragMoved || dx !== 0 || dy !== 0;
		pose[property] = this.dragStartHandKeypoints.map((kp) => kp ? { x: kp.x + dx, y: kp.y + dy } : null);
		this.updateMovedHandFusionTarget(pose, handRef.side);
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		const handRef = this.selectedHand;
		if (handRef) {
			const pose = this.poses[handRef.poseIndex];
			this.snapMovedHandToBodyWrist(pose, handRef.side);
			const { property } = this.getHandSideConfig(handRef.side);
			const changed = !!pose && JSON.stringify(pose[property]) !== JSON.stringify(this.dragStartHandKeypoints);
			if (changed) {
				this.markKeypointEdited();
				this.notifyChange('geometry');
			}
		}
		this.resetDragState(evt);
	}
};

/** Scale a hand uniformly from its wrist pivot. */
const ScaleHandMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		const handRef = this.selectedHand;
		if (!pose || !handRef || handRef.poseIndex !== this.selectedPoseIndex || !this.dragStartHandKeypoints ||
			!this.handTransformPivot || !this.handScaleStartDistance) {
			return true;
		}
		const { property } = this.getHandSideConfig(handRef.side);
		const pivot = this.handTransformPivot;
		const currentDistance = Math.hypot(pointer.x - pivot.x, pointer.y - pivot.y);
		let scale = Math.max(0.1, Math.min(10, currentDistance / this.handScaleStartDistance));
		let maximumCanvasScale = 10;
		for (const kp of this.dragStartHandKeypoints) {
			if (!kp) continue;
			const dx = kp.x - pivot.x;
			const dy = kp.y - pivot.y;
			if (dx > 0) maximumCanvasScale = Math.min(maximumCanvasScale, (this.logicalWidth - pivot.x) / dx);
			else if (dx < 0) maximumCanvasScale = Math.min(maximumCanvasScale, (0 - pivot.x) / dx);
			if (dy > 0) maximumCanvasScale = Math.min(maximumCanvasScale, (this.logicalHeight - pivot.y) / dy);
			else if (dy < 0) maximumCanvasScale = Math.min(maximumCanvasScale, (0 - pivot.y) / dy);
		}
		scale = Math.min(scale, Math.max(0.1, maximumCanvasScale));
		pose[property] = this.dragStartHandKeypoints.map((kp, index) => {
			if (!kp) return null;
			if (index === 0) return { ...pivot };
			return {
				x: pivot.x + (kp.x - pivot.x) * scale,
				y: pivot.y + (kp.y - pivot.y) * scale
			};
		});
		this.handDragMoved = this.handDragMoved || scale !== 1;
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		const handRef = this.selectedHand;
		if (handRef) {
			const pose = this.poses[handRef.poseIndex];
			const { property } = this.getHandSideConfig(handRef.side);
			const changed = !!pose && JSON.stringify(pose[property]) !== JSON.stringify(this.dragStartHandKeypoints);
			if (changed) {
				this.markKeypointEdited();
				this.notifyChange('geometry');
			}
		}
		this.resetDragState(evt);
	}
};

/** Rotate a hand around its wrist pivot. */
const RotateHandMode = {
	onMove(pointer) {
		const pose = this.poses[this.selectedPoseIndex];
		const handRef = this.selectedHand;
		if (!pose || !handRef || handRef.poseIndex !== this.selectedPoseIndex || !this.dragStartHandKeypoints ||
			!this.handTransformPivot || this.handRotateStartAngle === null) {
			return true;
		}
		const { property } = this.getHandSideConfig(handRef.side);
		const pivot = this.handTransformPivot;
		const currentAngle = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x);
		const deltaAngle = currentAngle - this.handRotateStartAngle;
		const cosAngle = Math.cos(deltaAngle);
		const sinAngle = Math.sin(deltaAngle);
		pose[property] = this.dragStartHandKeypoints.map((kp, index) => {
			if (!kp) return null;
			if (index === 0) return { ...pivot };
			const dx = kp.x - pivot.x;
			const dy = kp.y - pivot.y;
			return {
				x: pivot.x + dx * cosAngle - dy * sinAngle,
				y: pivot.y + dx * sinAngle + dy * cosAngle
			};
		});
		this.handDragMoved = this.handDragMoved || deltaAngle !== 0;
		this.requestRedraw();
		return true;
	},

	onUp(evt) {
		const handRef = this.selectedHand;
		if (handRef) {
			const pose = this.poses[handRef.poseIndex];
			const { property } = this.getHandSideConfig(handRef.side);
			const changed = !!pose && JSON.stringify(pose[property]) !== JSON.stringify(this.dragStartHandKeypoints);
			if (changed) {
				this.markKeypointEdited();
				this.notifyChange('geometry');
			}
		}
		this.resetDragState(evt);
	}
};

/**
 * Register every built-in drag mode on the manager.
 * @param {InteractionManager} manager
 */
export function registerDefaultModes(manager) {
	manager.registerMode('dragKeypoint', DragKeypointMode);
	manager.registerMode('moveSelectedKeypoints', MoveSelectedKeypointsMode);
	manager.registerMode('scaleSelectedKeypoints', ScaleSelectedKeypointsMode);
	manager.registerMode('movePose', MovePoseMode);
	manager.registerMode('scalePose', ScalePoseMode);
	manager.registerMode('rotatePose', RotatePoseMode);
	manager.registerMode('marquee', MarqueeMode);
	manager.registerMode('moveHand', MoveHandMode);
	manager.registerMode('scaleHand', ScaleHandMode);
	manager.registerMode('rotateHand', RotateHandMode);
}
