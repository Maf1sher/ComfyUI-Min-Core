/**
 * HitTester - unified pointer hit-testing for the pose editor.
 *
 * All "what is under the cursor?" questions go through this module so that the
 * pointer handlers stay thin and new keypoint types / gestures (right-click
 * delete, background image, zoom) reuse the exact same hit-test semantics.
 *
 * Pure logic: takes poses + a pointer in *logical* coordinates, returns hits.
 * No canvas/DOM access.
 */

import { keypointTypeProperty, KEYPOINT_TYPES } from "./pose-model.js";

/** Hand skeleton edges (bone pairs) used for line hit-testing. */
const HAND_EDGES = [
	[0, 1], [1, 2], [2, 3], [3, 4],
	[0, 5], [5, 6], [6, 7], [7, 8],
	[0, 9], [9, 10], [10, 11], [11, 12],
	[0, 13], [13, 14], [14, 15], [15, 16],
	[0, 17], [17, 18], [18, 19], [19, 20]
];

/**
 * A resolved hit against a single keypoint.
 * @typedef {object} KeypointHit
 * @property {string} type   - KEYPOINT_TYPES
 * @property {number} poseIndex
 * @property {number} keypointId
 */

export class HitTester {
	/**
	 * @param {object} [options]
	 * @param {number} [options.keypointHitRadius] - hit radius for body keypoints
	 * @param {number} [options.faceHitRadius]     - hit radius for face keypoints (defaults to keypointHitRadius)
	 * @param {number} [options.handHitRadius]     - hit radius for hand keypoints
	 * @param {number} [options.lineHitRadius]     - distance for hitting hand bones
	 */
	constructor(options = {}) {
		this.keypointHitRadius = options.keypointHitRadius ?? 10;
		this.faceHitRadius = options.faceHitRadius ?? this.keypointHitRadius;
		this.handHitRadius = options.handHitRadius ?? this.keypointHitRadius;
		this.lineHitRadius = options.lineHitRadius ?? 6;
	}

	/**
	 * Distance from point to a line segment.
	 * @param {{x:number,y:number}} point
	 * @param {{x:number,y:number}} start
	 * @param {{x:number,y:number}} end
	 * @returns {number}
	 */
	distanceToSegment(point, start, end) {
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const lengthSquared = dx * dx + dy * dy;
		if (lengthSquared === 0) {
			return Math.hypot(point.x - start.x, point.y - start.y);
		}
		const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
		return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
	}

	/**
	 * Find the topmost keypoint of the given types under `pointer`.
	 * Poses are searched top-down (last pose wins); within a pose, keypoints
	 * are searched in index order.
	 *
	 * @param {Array<object>} poses - pose objects from PoseModel
	 * @param {{x:number,y:number}} pointer - logical coordinates
	 * @param {object} [options]
	 * @param {Array<string>} [options.types]   - KEYPOINT_TYPES to include (default [BODY])
	 * @param {number|null} [options.poseIndex] - restrict to a single pose
	 * @param {number} [options.radius]         - override hit radius for all types
	 * @returns {KeypointHit|null}
	 */
	findKeypointAtPoint(poses, pointer, options = {}) {
		const types = options.types || [KEYPOINT_TYPES.BODY];
		const radiusOverride = options.radius;
		const radiusFor = (type) => {
			if (radiusOverride != null) return radiusOverride;
			if (type === KEYPOINT_TYPES.FACE) return this.faceHitRadius;
			if (type === KEYPOINT_TYPES.HAND_LEFT || type === KEYPOINT_TYPES.HAND_RIGHT) return this.handHitRadius;
			return this.keypointHitRadius;
		};

		let start = options.poseIndex ?? poses.length - 1;
		let end = options.poseIndex ?? 0;
		if (start < 0) return null;
		start = Math.min(start, poses.length - 1);
		if (options.poseIndex == null && start < 0) return null;

		for (let poseIdx = start; poseIdx >= end; poseIdx--) {
			const pose = poses[poseIdx];
			if (!pose) continue;
			for (const type of types) {
				const prop = keypointTypeProperty(type);
				const arr = prop ? pose[prop] : null;
				if (!Array.isArray(arr)) continue;
				const radius = radiusFor(type);
				for (let kpId = 0; kpId < arr.length; kpId++) {
					const kp = arr[kpId];
					if (!kp) continue;
					const dist = Math.hypot(pointer.x - kp.x, pointer.y - kp.y);
					if (dist <= radius) {
						return { type, poseIndex: poseIdx, keypointId: kpId };
					}
				}
			}
		}
		return null;
	}

	/**
	 * True if the pointer is near any hand keypoint or hand bone.
	 * @param {{x:number,y:number}} pointer
	 * @param {Array<{x,y}|null>} handKeypoints
	 * @param {object} [options] - { handLineWidth }
	 * @returns {boolean}
	 */
	isPointOnHand(pointer, handKeypoints, options = {}) {
		if (!Array.isArray(handKeypoints)) return false;
		for (const kp of handKeypoints) {
			if (kp && Math.hypot(pointer.x - kp.x, pointer.y - kp.y) <= this.handHitRadius) {
				return true;
			}
		}
		const lineHitRadius = Math.max(this.lineHitRadius, (options.handLineWidth ?? 3) + 3);
		for (const [a, b] of HAND_EDGES) {
			const start = handKeypoints[a];
			const end = handKeypoints[b];
			if (start && end && this.distanceToSegment(pointer, start, end) <= lineHitRadius) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Bounding box of non-null keypoints (any array).
	 * @param {Array<{x,y}|null>} keypoints
	 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
	 */
	getBounds(keypoints) {
		if (!Array.isArray(keypoints)) return null;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const kp of keypoints) {
			if (!kp) continue;
			minX = Math.min(minX, kp.x);
			minY = Math.min(minY, kp.y);
			maxX = Math.max(maxX, kp.x);
			maxY = Math.max(maxY, kp.y);
		}
		return minX === Infinity ? null : { minX, minY, maxX, maxY };
	}

	/**
	 * True if pointer is inside a rect (with optional padding).
	 * @param {{x:number,y:number}} pointer
	 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
	 * @param {number} [padding]
	 * @returns {boolean}
	 */
	isPointInRect(pointer, rect, padding = 0) {
		return pointer.x >= rect.minX - padding && pointer.x <= rect.maxX + padding &&
			pointer.y >= rect.minY - padding && pointer.y <= rect.maxY + padding;
	}
}
