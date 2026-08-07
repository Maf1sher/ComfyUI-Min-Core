# OpenPose Studio — Architecture Guide for AI Assistants

This document explains how the pose editor frontend is structured after the
refactoring.  Read it before modifying or adding features.  The goal of the
refactor is **consistent keypoint manipulation** with a single place for every
cross-cutting concern, so future features (right-click delete, per-keypoint
restore, background image input, zoom, pose list) require small, local edits.

---

## 1. Module map

```
web/openpose_studio/
├── canvas2d.js            # OpenPoseCanvas2D facade — rendering + wiring
├── core/
│   ├── pose-model.js      # PoseModel — pose/keypoint DATA + unified CRUD
│   ├── hit-test.js        # HitTester  — unified pointer hit-testing
│   ├── viewport.js        # Viewport   — coordinate transforms + zoom/pan
│   ├── interaction.js     # InteractionManager + drag modes (state machine)
│   └── ARCHITECTURE.md    # this file
├── formats/               # COCO-17/COCO-18 schemas (unchanged)
├── modules/               # editor.js mixins, UI modules (unchanged)
├── main.js                # node extension entry point (unchanged)
└── utils.js               # shared helpers (unchanged)
```

### Dependency graph

```
main.js ──> canvas2d.js ──> core/pose-model.js
                        ──> core/hit-test.js
                        ──> core/viewport.js
                        ──> core/interaction.js ──> core/pose-model.js
```

`core/*` modules are **pure JS** (no canvas/DOM access) so they can be unit
tested in Node and reused by any UI surface.

---

## 2. Keypoint types (KEYPOINT_TYPES)

Every keypoint belongs to exactly one of four logical groups.  The unified CRUD
API in `PoseModel` accepts these as the first argument:

| Type constant                | Pose property          | Typical length |
|------------------------------|------------------------|----------------|
| `KEYPOINT_TYPES.BODY`        | `pose.keypoints`       | 17–18          |
| `KEYPOINT_TYPES.FACE`        | `pose.faceKeypoints`   | 0–70           |
| `KEYPOINT_TYPES.HAND_LEFT`   | `pose.handLeftKeypoints`  | 0–21        |
| `KEYPOINT_TYPES.HAND_RIGHT`  | `pose.handRightKeypoints` | 0–21        |

Import the constants from `core/pose-model.js`:

```js
import { KEYPOINT_TYPES } from "./core/pose-model.js";
```

---

## 3. PoseModel — the single source of truth for pose data

File: `core/pose-model.js`

`PoseModel` owns the `poses` array and every operation that reads or mutates it.
The canvas facade keeps a live reference (`this.poses` getter/setter delegates
to `this.model.poses`), so existing render/drag code that touches
`this.poses[...]` keeps working without changes.

### Unified keypoint CRUD — USE THIS for any keypoint modification

| Method | Purpose |
|--------|---------|
| `getKeypoint(type, poseIndex, keypointId)` | Read one keypoint (or null) |
| `setKeypoint(type, poseIndex, keypointId, x, y)` | Move/replace (no null-slot write unless `opts.overwrite`) |
| `clearKeypoint(type, poseIndex, keypointId)` | Null out a single keypoint |
| `placeKeypoint(type, poseIndex, keypointId, x, y)` | Fill a null slot (refuses to overwrite) |
| `deleteKeypoint(type, poseIndex, keypointId)` | Clear AND push to the restore stack |
| `restoreLastDeletedKeypoint()` | Pop restore stack and re-insert |
| `clearFaceKeypoints(poseIndex)` | Null all face keypoints |
| `clearHandLeftKeypoints(poseIndex)` / `clearHandRightKeypoints(poseIndex)` | Null one hand |

All CRUD methods **return a boolean** indicating whether anything actually
changed.  The facade wraps these calls to also `markKeypointEdited()`,
`requestRedraw()` and `notifyChange('geometry' | 'extras')`.

> **Rule:** new features that modify keypoints (right-click delete, restore,
> pose list editing) MUST go through `model.deleteKeypoint` / `clearKeypoint` /
> `placeKeypoint`, never by writing `pose.keypoints[i] = null` directly.

### Pose-level operations

`setPoses`, `getPoses`, `addPose`, `addPoseFromArray`, `removePose`,
`loadFromFlatArray`, `serialize`, `load`, `normalizeExtraKeypoints`.

Selection state (`selectedPoseIndex`, `selectedKeypointIds`) is intentionally
**NOT** in the model — it is UI state owned by the facade, so the renderer and
the model never disagree about "which pose is active".

---

## 4. HitTester — how to ask "what is under the cursor?"

File: `core/hit-test.js`

```js
const hit = hitTester.findKeypointAtPoint(poses, pointer, {
  types: [KEYPOINT_TYPES.BODY, KEYPOINT_TYPES.FACE, KEYPOINT_TYPES.HAND_LEFT, KEYPOINT_TYPES.HAND_RIGHT],
  poseIndex: null,       // optional: restrict to one pose
  radius: undefined,     // optional: override hit radius
});
// hit => { type, poseIndex, keypointId } | null
```

Search order: poses top-down (last pose wins), keypoints in index order.

Other helpers:

| Method | Purpose |
|--------|---------|
| `isPointOnHand(pointer, handKeypoints)` | Hit-test hand keypoints + bones |
| `getBounds(keypoints)` | Bounding box of non-null keypoints |
| `isPointInRect(pointer, rect, padding)` | Rect hit-test |
| `distanceToSegment(point, start, end)` | Point-to-segment distance |

> **Example — right-click delete (future feature):**
> ```js
> handleContextMenu(evt) {
>   const pointer = this.screenToLogical(evt.clientX, evt.clientY);
>   const hit = this.hitTester.findKeypointAtPoint(this.poses, pointer, {
>     types: [KEYPOINT_TYPES.BODY, KEYPOINT_TYPES.FACE, KEYPOINT_TYPES.HAND_LEFT, KEYPOINT_TYPES.HAND_RIGHT]
>   });
>   if (hit) {
>     this.model.deleteKeypoint(hit.type, hit.poseIndex, hit.keypointId);
>     this.markKeypointEdited();
>     this.requestRedraw();
>     this.notifyChange('geometry');
>     evt.preventDefault();
>   }
> }
> ```

---

## 5. Viewport — coordinates, zoom, background image

File: `core/viewport.js`

All pointer input flows through `viewport.screenToWorld(clientX, clientY, rect)`
(the facade's `screenToLogical()` is now just a thin wrapper).  All drawing
should flow through `viewport.applyWorldTransform(ctx)` so future zoom/pan is a
one-line change.

| Method | Purpose |
|--------|---------|
| `screenToWorld(clientX, clientY, rect)` | Client → world (logical) coords |
| `worldToScreen(x, y, rect)` | World → client coords |
| `getViewportWidth()` / `getViewportHeight()` | Effective size (honors hand-edit override) |
| `setViewportSize(size)` | Square override used by hand-edit mode |
| `zoomAround(factor, pivot)` | Future zoom around a world point |
| `panBy(dx, dy)` | Future pan |
| `applyWorldTransform(ctx)` | Apply zoom/pan to ctx before drawing |
| `setView(view)` / `worldToView` / `viewToWorld` | Generic world↔view transform (hand-edit mode) |
| `applyViewTransform(ctx)` | Apply view transform to ctx |

**Background image as node input (future feature):** the image element arrives
via `setBackground(img, mode, opacity)` (already wired in `editor.js`).  For a
node-driven background you would feed a data URL into the same path; the
viewport handles the contain/cover math in `drawBackground()`.

---

## 6. InteractionManager — how drag modes are dispatched

File: `core/interaction.js`

`handlePointerDown/Move/Up` in the facade decide *which* mode starts and then
delegate the per-frame work to the active mode.  A mode is a plain object:

```js
const MyMode = {
  onEnter(data)  { /* optional: setup */ },
  onMove(pointer, evt) { /* return true = handled */ },
  onUp(evt) { /* finalize + this.resetDragState(evt) */ }
};
```

Handlers are invoked with the owning canvas instance as `this`, so they can use
`this.poses`, `this.selectedPoseIndex`, `this.dragStartKeypoint`, ... directly.

### Built-in modes (registered by `registerDefaultModes`)

`dragKeypoint`, `moveSelectedKeypoints`, `scaleSelectedKeypoints`, `movePose`,
`scalePose`, `rotatePose`, `marquee`, `moveHand`, `scaleHand`, `rotateHand`.

### Adding a new mode

1. Define the mode object in `core/interaction.js` (or import it).
2. Register it in `registerDefaultModes(manager)`.
3. Activate it from the facade: `this.interaction.activate('myMode')`
   (or just set `this.activeDragMode = 'myMode'` — the manager reads the same
   field).
4. Make sure `onUp` ends with `this.resetDragState(evt)`.

> Hand-edit mode (`dragHandKeypoint`) is intentionally NOT a registered mode: it
> has its own isolated pointer path (`handleHandEditPointerDown/Move/Up`).  Keep
> it that way unless you are adding hand-edit-specific gestures.

---

## 7. Public API contract (DO NOT break)

`editor.js` and `main.js` call these methods on the facade.  Signatures must
stay identical:

| Method | Notes |
|--------|-------|
| `setPoses / getPoses / addPose / addPoseFromArray` | data + notify |
| `loadFromFlatArray / removePose / load / serialize` | data + notify |
| `clearKeypoint / placeKeypoint` | body keypoints (delegates to model) |
| `clearFaceKeypoints / clearHandKeypoints / clearHandLeftKeypoints / clearHandRightKeypoints` | extras |
| `clearHandEditKeypoint(id)` | hand-edit buffer only |
| `setSelectedPose / getSelectedPoseIndex` | selection |
| `setHoveredKeypointId / getCanvasHoveredKeypointId / getCanvasHoveredPoseIndex` | hover |
| `setSidebarHoveredHandSide` | sidebar hand hover |
| `enterHandEditMode / isHandEditModeActive / getHandEditModeInfo` | hand edit |
| `setHoveredHandEditKeypointId` | hand edit hover |
| `setSize / setGrid / setBackground / setBackgroundFillStyle` | canvas setup |
| `setConditioningAreas / setConditioningAreasVisible` | conditioning areas |
| `onChange / onSelectionChange / onHoverChange / onHandEditModeChange` | callbacks |
| `hasKeypointEdits / setKeypointEdits / hasExtraKeypoints / getPoseExtrasStatus` | status |
| `requestRedraw / updateCursor` | rendering triggers |
| `screenToLogical(clientX, clientY)` | coordinate mapping (delegates to viewport) |

All of these are **kept** on `canvas2d.js`.  Do not rename or re-order their
parameters without updating `editor.js` / `main.js`.

---

## 8. How to add each planned future feature

| Feature | Touch these files | Notes |
|---------|-------------------|-------|
| **Right-click keypoint delete** | `canvas2d.js` (add `contextmenu` listener + handler) | Use `hitTester.findKeypointAtPoint` + `model.deleteKeypoint` (see §4 example) |
| **Restore deleted keypoints** | `canvas2d.js` + maybe a toolbar button in `editor.js` | `model.restoreLastDeletedKeypoint()` + `notifyChange('geometry')` |
| **Background image as node input** | backend `nodes/openpose_studio.py` + `main.js`/`editor.js` feed | Reuse `setBackground()`; viewport math already handles contain/cover |
| **Zoom / pan** | `canvas2d.js` wheel/drag listeners | `viewport.zoomAround()` / `panBy()`; rendering already routed through viewport |
| **Pose list (show all poses + keypoints)** | new sidebar module + `canvas2d.js` read-only methods | Iterate `model.poses` / `model.getKeypoint(type, i, id)`; selection stays on facade |
| **Conditioning areas (keep working)** | unchanged | Already isolated in `canvas2d.js` (`drawConditioningAreaOverlays`, badge hit-test in `handlePointerDown` step 0) |

---

## 9. Refactoring rules (this repo)

- Category for every node: `"Min-Core"`. Node IDs prefixed `MinCore_`.
- Keep `core/*` modules free of DOM/canvas references so they stay testable.
- Always delegate keypoint writes through `PoseModel`.
- Update this file and `doc/*` whenever architecture or node behaviour changes.
- After editing JS: run `node --check` on every changed file.
