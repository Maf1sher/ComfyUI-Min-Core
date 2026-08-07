/**
 * PoseModel - unified data model for poses and keypoints.
 *
 * Owns the `poses` array and exposes a single, type-aware CRUD surface for
 * keypoints of every kind (body, face, left/right hand).  This is the one
 * place that knows how keypoints are stored on a pose object; consumers
 * (canvas renderer, sidebar, pose list, tools) all go through this class so
 * that future features (right-click delete, per-keypoint restore, pose list)
 * can be added without duplicating storage logic.
 */

import { isValidKeypoint } from "../utils.js";
import { getFormat, detectFormat, detectFormatFromMetadata, DEFAULT_FORMAT_ID } from "../formats/index.js";

/** Logical categories of keypoints stored on a pose. */
export const KEYPOINT_TYPES = Object.freeze({
	BODY: "body",
	FACE: "face",
	HAND_LEFT: "hand_left",
	HAND_RIGHT: "hand_right",
});

/**
 * Maps a KEYPOINT_TYPES value to the property name used on a pose object.
 * @param {string} type - one of KEYPOINT_TYPES
 * @returns {string|null}
 */
export function keypointTypeProperty(type) {
	switch (type) {
		case KEYPOINT_TYPES.BODY: return "keypoints";
		case KEYPOINT_TYPES.FACE: return "faceKeypoints";
		case KEYPOINT_TYPES.HAND_LEFT: return "handLeftKeypoints";
		case KEYPOINT_TYPES.HAND_RIGHT: return "handRightKeypoints";
		default: return null;
	}
}

const EXTRA_KEYPOINT_EPSILON = 0.5;

export class PoseModel {
	/**
	 * @param {object} options
	 * @param {number} [options.logicalWidth] - canvas logical width (used to clamp coordinates)
	 * @param {number} [options.logicalHeight] - canvas logical height
	 */
	constructor(options = {}) {
		this.logicalWidth = options.logicalWidth || 768;
		this.logicalHeight = options.logicalHeight || 512;
		/** @type {Array<object>} Array of pose objects. Each pose:
		 *   { keypoints, formatId, faceKeypoints, handLeftKeypoints, handRightKeypoints }
		 */
		this.poses = [];
		this.activeFormatId = DEFAULT_FORMAT_ID;
		// Stack of deleted keypoints for future restore/undo support.
		// NOTE: selection state (selectedPoseIndex / selectedKeypointIds) is
		// intentionally owned by the canvas facade, not here, so the renderer
		// and the model never disagree about "which pose is active".
		/** @type {Array<{type: string, poseIndex: number, keypointId: number, x: number, y: number}>} */
		this.deletedKeypoints = [];
	}

	// ── Keypoint accessors (unified) ────────────────────────────────────────

	/**
	 * Get the keypoint array backing `type` on a pose, or null.
	 * @param {object} pose
	 * @param {string} type - KEYPOINT_TYPES
	 * @returns {Array<{x,y}|null>|null}
	 */
	getKeypointArray(pose, type) {
		if (!pose) return null;
		const prop = keypointTypeProperty(type);
		return prop ? pose[prop] || null : null;
	}

	/**
	 * Read a single keypoint of any type.
	 * @param {string} type - KEYPOINT_TYPES
	 * @param {number} poseIndex
	 * @param {number} keypointId
	 * @returns {{x:number,y:number}|null}
	 */
	getKeypoint(type, poseIndex, keypointId) {
		const arr = this.getKeypointArray(this.poses[poseIndex], type);
		return arr && arr[keypointId] ? arr[keypointId] : null;
	}

	/**
	 * Move/replace an existing keypoint of any type. Does NOT place into a null slot.
	 * @param {string} type - KEYPOINT_TYPES
	 * @param {number} poseIndex
	 * @param {number} keypointId
	 * @param {number} x
	 * @param {number} y
	 * @param {object} [opts] - { overwrite: boolean } allows writing into a null slot
	 * @returns {boolean} true if the slot was written
	 */
	setKeypoint(type, poseIndex, keypointId, x, y, opts = {}) {
		const pose = this.poses[poseIndex];
		const arr = this.getKeypointArray(pose, type);
		if (!arr || keypointId < 0 || keypointId >= arr.length) return false;
		if (arr[keypointId] && !opts.overwrite) return false;
		arr[keypointId] = { x, y };
		
		return true;
	}

	/**
	 * Clear (null) a single keypoint of any type.
	 * @param {string} type - KEYPOINT_TYPES
	 * @param {number} poseIndex
	 * @param {number} keypointId
	 * @returns {boolean} true if a keypoint was actually cleared
	 */
	clearKeypoint(type, poseIndex, keypointId) {
		const arr = this.getKeypointArray(this.poses[poseIndex], type);
		if (!arr || !arr[keypointId]) return false;
		arr[keypointId] = null;
		
		return true;
	}

	/**
	 * Place a missing keypoint at the given logical coordinates.
	 * Only places when the slot is currently null (does not overwrite existing keypoints).
	 * @param {string} type - KEYPOINT_TYPES
	 * @param {number} poseIndex
	 * @param {number} keypointId
	 * @param {number} x
	 * @param {number} y
	 * @returns {boolean}
	 */
	placeKeypoint(type, poseIndex, keypointId, x, y) {
		const pose = this.poses[poseIndex];
		const arr = this.getKeypointArray(pose, type);
		if (!arr || keypointId < 0 || keypointId >= arr.length) return false;
		if (arr[keypointId]) return false; // refuse to overwrite
		arr[keypointId] = {
			x: Math.max(0, Math.min(this.logicalWidth, x)),
			y: Math.max(0, Math.min(this.logicalHeight, y))
		};
		
		return true;
	}

	/**
	 * Remove a keypoint AND remember it so it can be restored later.
	 * @param {string} type - KEYPOINT_TYPES
	 * @param {number} poseIndex
	 * @param {number} keypointId
	 * @returns {boolean}
	 */
	deleteKeypoint(type, poseIndex, keypointId) {
		const arr = this.getKeypointArray(this.poses[poseIndex], type);
		if (!arr || !arr[keypointId]) return false;
		this.deletedKeypoints.push({ type, poseIndex, keypointId, x: arr[keypointId].x, y: arr[keypointId].y });
		arr[keypointId] = null;
		
		return true;
	}

	/**
	 * Restore the most recently deleted keypoint (future feature hook).
	 * @returns {boolean} true if a keypoint was restored
	 */
	restoreLastDeletedKeypoint() {
		const entry = this.deletedKeypoints.pop();
		if (!entry) return false;
		const arr = this.getKeypointArray(this.poses[entry.poseIndex], entry.type);
		if (!arr || arr[entry.keypointId]) return false;
		arr[entry.keypointId] = { x: entry.x, y: entry.y };
		
		return true;
	}

	/** @returns {number} number of keypoints currently staged for restore */
	getDeletedKeypointCount() {
		return this.deletedKeypoints.length;
	}

	/** Clear the deleted-keypoint stack. */
	clearDeletedKeypoints() {
		this.deletedKeypoints = [];
	}

	// ── Bulk keypoint clear helpers ─────────────────────────────────────────

	clearFaceKeypoints(poseIndex) {
		const pose = this.poses[poseIndex];
		if (!pose) return false;
		if (!Array.isArray(pose.faceKeypoints) || pose.faceKeypoints.length === 0) {
			pose.faceKeypoints = [];
			return false;
		}
		pose.faceKeypoints = new Array(pose.faceKeypoints.length).fill(null);
		
		return true;
	}

	clearHandLeftKeypoints(poseIndex) {
		const pose = this.poses[poseIndex];
		if (!pose) return false;
		if (!Array.isArray(pose.handLeftKeypoints) || pose.handLeftKeypoints.length === 0) {
			pose.handLeftKeypoints = [];
			return false;
		}
		pose.handLeftKeypoints = new Array(pose.handLeftKeypoints.length).fill(null);
		
		return true;
	}

	clearHandRightKeypoints(poseIndex) {
		const pose = this.poses[poseIndex];
		if (!pose) return false;
		if (!Array.isArray(pose.handRightKeypoints) || pose.handRightKeypoints.length === 0) {
			pose.handRightKeypoints = [];
			return false;
		}
		pose.handRightKeypoints = new Array(pose.handRightKeypoints.length).fill(null);
		
		return true;
	}

	// ── Pose CRUD ───────────────────────────────────────────────────────────

	/**
	 * Bulk-replace all poses, normalizing extra keypoints.
	 * @param {Array} posesArray
	 */
	setPoses(posesArray) {
		this.poses = posesArray.map(pose => {
			const kps = pose.keypoints || pose;
			return {
				keypoints: kps,
				formatId: pose.formatId || detectFormat(kps),
				faceKeypoints: this.normalizeExtraKeypoints(pose.faceKeypoints || pose.face_keypoints_2d),
				handLeftKeypoints: this.normalizeExtraKeypoints(pose.handLeftKeypoints || pose.hand_left_keypoints_2d),
				handRightKeypoints: this.normalizeExtraKeypoints(pose.handRightKeypoints || pose.hand_right_keypoints_2d)
			};
		});
		this.clearDeletedKeypoints();
	}

	/** @returns {Array<object>} shallow copies of poses (same keypoint arrays) */
	getPoses() {
		return this.poses.map(pose => ({
			keypoints: pose.keypoints,
			formatId: pose.formatId,
			faceKeypoints: pose.faceKeypoints,
			handLeftKeypoints: pose.handLeftKeypoints,
			handRightKeypoints: pose.handRightKeypoints
		}));
	}

	/**
	 * Add a pose to the end and select it.
	 * @param {Array<{x,y}|null>} keypoints
	 * @param {Array|null} faceKeypoints
	 * @param {Array|null} handLeftKeypoints
	 * @param {Array|null} handRightKeypoints
	 * @param {string|null} formatId
	 * @returns {number} index of the added pose
	 */
	addPose(keypoints, faceKeypoints = null, handLeftKeypoints = null, handRightKeypoints = null, formatId = null) {
		const resolvedFormatId = formatId !== null ? formatId : detectFormat(keypoints);
		this.poses.push({ keypoints, formatId: resolvedFormatId, faceKeypoints, handLeftKeypoints, handRightKeypoints });
		return this.poses.length - 1;
	}

	/**
	 * Convert a raw [x,y] keypoint array to internal {x,y} format with
	 * validation and bounds-clamping, then add as a new pose.
	 * @param {Array} xyPairs - array of [x,y] pairs
	 * @returns {number} index of the added pose
	 */
	addPoseFromArray(xyPairs, faceKeypoints = null, handLeftKeypoints = null, handRightKeypoints = null, formatId = null) {
		const converted = [];
		for (let i = 0; i < xyPairs.length; i++) {
			const point = xyPairs[i];
			if (isValidKeypoint(point)) {
				const x = Number(point[0]);
				const y = Number(point[1]);
				if (Number.isFinite(x) && Number.isFinite(y) &&
					x >= 0 && y >= 0 &&
					x <= this.logicalWidth && y <= this.logicalHeight) {
					converted.push({ x, y });
				} else {
					converted.push(null);
				}
			} else {
				converted.push(null);
			}
		}
		const convertedFaceKeypoints = this.normalizeExtraKeypoints(faceKeypoints);
		const convertedHandLeftKeypoints = this.normalizeExtraKeypoints(handLeftKeypoints);
		const convertedHandRightKeypoints = this.normalizeExtraKeypoints(handRightKeypoints);
		return this.addPose(converted, convertedFaceKeypoints, convertedHandLeftKeypoints, convertedHandRightKeypoints, formatId);
	}

	/**
	 * Normalize extra (face/hand) keypoints from {x,y} or [x,y] to internal {x,y} format,
	 * clamping to canvas bounds and treating near-origin points as missing.
	 * @param {Array} points
	 * @returns {Array|null}
	 */
	normalizeExtraKeypoints(points) {
		if (!Array.isArray(points)) {
			return null;
		}
		const converted = [];
		for (let i = 0; i < points.length; i++) {
			const point = points[i];
			let x;
			let y;
			if (point && typeof point === "object" && !Array.isArray(point)) {
				x = Number(point.x);
				y = Number(point.y);
				if (Math.abs(x) <= EXTRA_KEYPOINT_EPSILON && Math.abs(y) <= EXTRA_KEYPOINT_EPSILON) {
					converted.push(null);
					continue;
				}
			} else if (isValidKeypoint(point)) {
				x = Number(point[0]);
				y = Number(point[1]);
			} else {
				converted.push(null);
				continue;
			}
			if (Math.abs(x) <= EXTRA_KEYPOINT_EPSILON && Math.abs(y) <= EXTRA_KEYPOINT_EPSILON) {
				converted.push(null);
				continue;
			}
			if (Number.isFinite(x) && Number.isFinite(y) &&
				x >= 0 && y >= 0 &&
				x <= this.logicalWidth && y <= this.logicalHeight) {
				converted.push({ x, y });
			} else {
				converted.push(null);
			}
		}
		return converted;
	}

	/**
	 * Clear all poses and bulk-load from a flat [x,y] keypoint array,
	 * chunked into groups of format's keypoint count per pose.
	 * @param {Array} flatXYPairs
	 * @param {string|null} formatId
	 */
	loadFromFlatArray(flatXYPairs, formatId = null) {
		const format = getFormat(formatId || this.activeFormatId);
		const kpCount = format && format.keypoints ? format.keypoints.length : 18;
		this.poses = [];
		this.clearDeletedKeypoints();
		const resolvedFormatId = (format && format.id) ? format.id : null;
		for (let i = 0; i < flatXYPairs.length; i += kpCount) {
			const chunk = flatXYPairs.slice(i, i + kpCount);
			if (chunk.length >= kpCount) {
				this.addPoseFromArray(chunk, null, null, null, resolvedFormatId);
			}
		}
	}

	/**
	 * Remove a pose at the given index.
	 * @param {number} index
	 * @returns {boolean} true if a pose was removed
	 */
	removePose(index) {
		if (index < 0 || index >= this.poses.length) {
			return false;
		}
		this.poses.splice(index, 1);
		return true;
	}

	// ── Serialization ───────────────────────────────────────────────────────

	/**
	 * @param {object} [options] - { includeExtras, includeFace, includeHands }
	 * @returns {object} serialized pose data
	 */
	serialize(options = {}) {
		const includeExtras = !!options.includeExtras;
		const includeFace = includeExtras || !!options.includeFace;
		const includeHands = includeExtras || !!options.includeHands;
		const payload = {
			width: this.logicalWidth,
			format: this.activeFormatId,
			height: this.logicalHeight,
			keypoints: this.poses.map(pose =>
				pose.keypoints.map(kp => kp ? [kp.x, kp.y] : null)
			)
		};
		const hasFace = this.poses.some((pose) =>
			Array.isArray(pose.faceKeypoints) && pose.faceKeypoints.length > 0
		);
		const hasHandLeft = this.poses.some((pose) =>
			Array.isArray(pose.handLeftKeypoints) && pose.handLeftKeypoints.length > 0
		);
		const hasHandRight = this.poses.some((pose) =>
			Array.isArray(pose.handRightKeypoints) && pose.handRightKeypoints.length > 0
		);
		if (includeFace && hasFace) {
			payload.face_keypoints_2d = this.poses.map((pose) => (
				Array.isArray(pose.faceKeypoints)
					? pose.faceKeypoints.map(kp => kp ? [kp.x, kp.y] : null)
					: null
			));
		}
		if (includeHands && hasHandLeft) {
			payload.hand_left_keypoints_2d = this.poses.map((pose) => (
				Array.isArray(pose.handLeftKeypoints)
					? pose.handLeftKeypoints.map(kp => kp ? [kp.x, kp.y] : null)
					: null
			));
		}
		if (includeHands && hasHandRight) {
			payload.hand_right_keypoints_2d = this.poses.map((pose) => (
				Array.isArray(pose.handRightKeypoints)
					? pose.handRightKeypoints.map(kp => kp ? [kp.x, kp.y] : null)
					: null
			));
		}
		return payload;
	}

	/**
	 * Load a serialized object into the model.
	 * @param {object} serializedObject
	 */
	load(serializedObject) {
		this.logicalWidth = serializedObject.width || 768;
		this.logicalHeight = serializedObject.height || 512;

		const poseKeypoints = serializedObject.keypoints || [];
		const flatKeypoints = poseKeypoints.length > 0 && Array.isArray(poseKeypoints[0])
			? poseKeypoints.flat()
			: poseKeypoints;
		this.activeFormatId = detectFormatFromMetadata(
			serializedObject.format,
			flatKeypoints
		) || DEFAULT_FORMAT_ID;

		const faceKeypoints = Array.isArray(serializedObject.face_keypoints_2d)
			? serializedObject.face_keypoints_2d
			: Array.isArray(serializedObject.faceKeypoints)
				? serializedObject.faceKeypoints
				: null;
		const handLeftKeypoints = Array.isArray(serializedObject.hand_left_keypoints_2d)
			? serializedObject.hand_left_keypoints_2d
			: Array.isArray(serializedObject.handLeftKeypoints)
				? serializedObject.handLeftKeypoints
				: null;
		const handRightKeypoints = Array.isArray(serializedObject.hand_right_keypoints_2d)
			? serializedObject.hand_right_keypoints_2d
			: Array.isArray(serializedObject.handRightKeypoints)
				? serializedObject.handRightKeypoints
				: null;

		this.poses = (serializedObject.keypoints || []).map((poseKeypoints, index) =>
			({
				keypoints: poseKeypoints.map(kp =>
					kp && kp.length === 2 ? { x: kp[0], y: kp[1] } : null
				),
				formatId: this.activeFormatId,
				faceKeypoints: this.normalizeExtraKeypoints(
					faceKeypoints ? faceKeypoints[index] : null
				),
				handLeftKeypoints: this.normalizeExtraKeypoints(
					handLeftKeypoints ? handLeftKeypoints[index] : null
				),
				handRightKeypoints: this.normalizeExtraKeypoints(
					handRightKeypoints ? handRightKeypoints[index] : null
				)
			})
		);
		this.clearDeletedKeypoints();
	}
}
